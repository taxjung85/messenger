// ─── Supabase 설정 (하드코딩 — anon key는 공개용) ───
const SUPABASE_URL = "https://gwirtvvbscwriqmoxqyv.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd3aXJ0dnZic2N3cmlxbW94cXl2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMwNjc5NzUsImV4cCI6MjA4ODY0Mzk3NX0.LgO1hrzhPUgYNzO6YyoVPIpBMMETCZjimvHUkNjQ2ew";

async function getKeys() {
  return { url: SUPABASE_URL, key: SUPABASE_ANON_KEY };
}

// ─── Google 로그인 (content script 콜백 방식 — 추가 권한 불필요) ───
let _oauthResolve = null;

async function loginWithGoogle() {
  // 카카오 비즈니스 페이지로 리다이렉트 → content script가 토큰 캡처
  const redirectUrl = "https://business.kakao.com/";
  const authUrl = SUPABASE_URL + "/auth/v1/authorize?provider=google&redirect_to=" + encodeURIComponent(redirectUrl);

  return new Promise((resolve, reject) => {
    _oauthResolve = resolve;
    chrome.tabs.create({ url: authUrl });
    // 2분 타임아웃
    setTimeout(() => {
      if (_oauthResolve) { _oauthResolve = null; reject("로그인 시간 초과"); }
    }, 120000);
  });
}

// ─── 토큰 자동 갱신 ───
async function refreshAccessToken() {
  const refreshToken = await new Promise(r => chrome.storage.local.get("authRefreshToken", res => r(res.authRefreshToken)));
  if (!refreshToken) return null;
  try {
    const res = await fetch(SUPABASE_URL + "/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (!res.ok) {
      console.error("[AI BG] 토큰 갱신 실패:", res.status);
      return null;
    }
    const data = await res.json();
    if (data.access_token) {
      chrome.storage.local.set({
        authAccessToken: data.access_token,
        authRefreshToken: data.refresh_token || refreshToken,
      });
      console.log("[AI BG] 토큰 갱신 완료");
      return data.access_token;
    }
    return null;
  } catch (e) {
    console.error("[AI BG] 토큰 갱신 에러:", e.message);
    return null;
  }
}

async function getValidToken() {
  let token = await new Promise(r => chrome.storage.local.get("authAccessToken", res => r(res.authAccessToken)));
  if (!token) return null;
  // JWT 만료 체크 (exp claim)
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now + 60) {
      // 만료됨 또는 1분 내 만료 → 갱신
      console.log("[AI BG] 토큰 만료 감지, 갱신 시도...");
      token = await refreshAccessToken();
    }
  } catch (e) {
    // JWT 파싱 실패 → 그냥 사용
  }
  return token;
}

// ─── 인증된 상태에서 settings 읽기 ───
async function fetchAuthSettings(accessToken) {
  try {
    // 전달된 토큰 대신 유효한 토큰 사용
    const validToken = await getValidToken() || accessToken;
    const res = await fetch(SUPABASE_URL + "/rest/v1/settings?select=key,value", {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: "Bearer " + validToken,
      }
    });
    if (!res.ok) return null;
    const rows = await res.json();
    const map = {};
    for (const r of rows) map[r.key] = r.value;
    return map;
  } catch (e) {
    return null;
  }
}

// ─── Supabase REST 헬퍼 ───
async function supaRest(method, table, params, body) {
  const { url, key } = await getKeys();
  if (!url || !key) return null;
  // RLS 통과를 위해 유효한 auth token 사용 (없으면 anon key fallback)
  const authToken = await getValidToken();
  const headers = {
    apikey: key,
    Authorization: "Bearer " + (authToken || key),
    "Content-Type": "application/json",
    Prefer: method === "POST" ? "return=minimal" : "",
  };
  let endpoint = url + "/rest/v1/" + table;
  if (params) endpoint += "?" + params;
  const res = await fetch(endpoint, {
    method: method,
    headers: headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    console.error("[AI BG] REST 에러:", res.status, await res.text().catch(() => ""));
    return null;
  }
  if (method === "GET") return res.json();
  return true;
}

// ─── 한국 공휴일 (고정) ───
const FIXED_HOLIDAYS = [
  "01-01", "03-01", "05-05", "06-06", "08-15", "10-03", "10-09", "12-25",
];
function isWeekend(d) { return d.getUTCDay() === 0 || d.getUTCDay() === 6; }
function isHoliday(d) {
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return FIXED_HOLIDAYS.includes(mm + "-" + dd);
}
function isBusinessDay(d) { return !isWeekend(d) && !isHoliday(d); }
function prevBusinessDay(dateStr) {
  const d = new Date(dateStr + "T00:00:00Z");
  while (!isBusinessDay(d)) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().substring(0, 10);
}
function getKSTNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}
function getKSTToday() {
  return getKSTNow().toISOString().substring(0, 10);
}

// ─── 알람 등록 + 확장프로그램 리로드 후 탭 새로고침 ───
// ─── 네이티브 호스트 자동 설치 체크 ───
function checkNativeHost() {
  chrome.runtime.sendNativeMessage("com.jungsem.messenger", { action: "ping" }, (res) => {
    if (chrome.runtime.lastError || !res || !res.success) {
      console.log("[AI BG] 네이티브 호스트 미연결 — install_host.bat 실행 필요");
      chrome.notifications.create("native-setup", {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "채널에이전트 초기 설정",
        message: "거래처 폴더 기능을 사용하려면 extension 폴더의 install_host.bat을 1회 실행해주세요.",
      });
    } else {
      console.log("[AI BG] 네이티브 호스트 연결 OK");
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  // 네이티브 호스트 연결 체크
  checkNativeHost();
  // 1시간 간격 기본 체크 알람
  chrome.alarms.create("todo-check", { periodInMinutes: 60 });
  // 반복 todo 생성용 (매일 오전 8시 KST 체크)
  chrome.alarms.create("recurring-generate", { periodInMinutes: 60 });
  // 반복 todo 마감 알림용 (10분 간격으로 체크, 10AM/4PM에만 발동)
  chrome.alarms.create("recurring-notify", { periodInMinutes: 10 });
  console.log("[AI BG] 알람 등록 완료");

  // 확장프로그램 리로드 후 카카오 탭 새로고침
  chrome.storage.local.get("pendingTabReload", (result) => {
    if (result.pendingTabReload) {
      chrome.storage.local.remove("pendingTabReload");
      setTimeout(() => {
        chrome.tabs.query({ url: ["https://business.kakao.com/*", "https://center-pf.kakao.com/*"] }, (tabs) => {
          for (const tab of tabs) chrome.tabs.reload(tab.id);
          console.log("[AI BG] 탭", tabs.length + "개 새로고침 완료");
        });
      }, 500);
    }
  });
});

// 서비스 워커 재시작 시에도 알람 보장
chrome.alarms.get("todo-check", (a) => {
  if (!a) chrome.alarms.create("todo-check", { periodInMinutes: 60 });
});
chrome.alarms.get("recurring-generate", (a) => {
  if (!a) chrome.alarms.create("recurring-generate", { periodInMinutes: 60 });
});
chrome.alarms.get("recurring-notify", (a) => {
  if (!a) chrome.alarms.create("recurring-notify", { periodInMinutes: 10 });
});
// version-check 알람 제거 (content-list.js에서 접속 시 체크)

// ─── 버전 체크 ───
async function checkVersionUpdate() {
  try {
    const data = await supaRest("GET", "settings", "select=value&key=eq.app_version");
    if (!data || data.length === 0) return;
    const remoteVersion = data[0].value;
    const localVersion = chrome.runtime.getManifest().version;
    if (remoteVersion === localVersion) return;
    console.log("[AI BG] 새 버전 감지:", localVersion, "→", remoteVersion);
    chrome.notifications.create("version-update", {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "🔄 새 버전 사용 가능 (v" + remoteVersion + ")",
      message: "클릭하면 확장 프로그램을 새로고침합니다.",
      priority: 2,
      requireInteraction: true,
    });
    // content script에도 알림
    chrome.tabs.query({ url: ["https://business.kakao.com/*", "https://center-pf.kakao.com/*"] }, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: "version-update", version: remoteVersion }).catch(() => {});
      }
    });
  } catch (e) {
    console.error("[AI BG] 버전 체크 실패:", e.message);
  }
}

// 알림 클릭 → 다운로드 + 업데이트 + 리로드
chrome.notifications.onClicked.addListener(async (notifId) => {
  if (notifId === "version-update") {
    try {
      // Supabase에서 download_url 조회
      const dlData = await supaRest("GET", "settings", "select=value&key=eq.download_url");
      const downloadUrl = dlData && dlData[0] && dlData[0].value;
      if (!downloadUrl) {
        // URL 없으면 기존 방식 (리로드만)
        chrome.storage.local.set({ pendingTabReload: true }, () => chrome.runtime.reload());
        return;
      }
      // native host로 다운로드 + 압축해제
      chrome.runtime.sendNativeMessage("com.jungsem.messenger", {
        action: "update",
        downloadUrl: downloadUrl,
        targetDir: "C:\\extension"
      }, (response) => {
        if (response && response.success) {
          console.log("[AI BG] 업데이트 완료:", response.path);
          chrome.storage.local.set({ pendingTabReload: true }, () => chrome.runtime.reload());
        } else {
          console.error("[AI BG] 업데이트 실패:", response && response.error);
          // 실패 시 기존 방식 폴백
          chrome.storage.local.set({ pendingTabReload: true }, () => chrome.runtime.reload());
        }
      });
    } catch (e) {
      console.error("[AI BG] 업데이트 오류:", e);
      chrome.storage.local.set({ pendingTabReload: true }, () => chrome.runtime.reload());
    }
  }
});

// ─── 미완료 To-Do 조회 ───
async function getPendingTodoCount() {
  const data = await supaRest("GET", "todos", "select=id&status=eq.pending");
  return data ? data.length : 0;
}

// ─── 반복 todo 자동 생성 (매월 초) ───
async function generateRecurringTodos() {
  try {
    const today = getKSTToday();
    const yearMonth = today.substring(0, 7);

    // 활성 반복 일정 조회
    const recurring = await supaRest("GET", "recurring_todos", "select=*&is_active=eq.true&order=day_of_month.asc");
    if (!recurring || recurring.length === 0) return;

    // 이번 달 이미 생성된 반복 todo
    const existing = await supaRest("GET", "todos",
      "select=recurring_id&recurring_id=not.is.null&created_at=gte." + yearMonth + "-01T00:00:00%2B09:00");
    const createdSet = new Set((existing || []).map(t => String(t.recurring_id)));

    let created = 0;
    for (const r of recurring) {
      if (createdSet.has(String(r.id))) continue;

      const lastDay = new Date(parseInt(yearMonth.substring(0, 4)), parseInt(yearMonth.substring(5, 7)), 0).getDate();
      const targetDay = Math.min(r.day_of_month, lastDay);
      const targetDate = yearMonth + "-" + String(targetDay).padStart(2, "0");
      const actualDate = prevBusinessDay(targetDate);

      await supaRest("POST", "todos", null, {
        content: r.title,
        status: "pending",
        assigned_to: r.assigned_to || "",
        recurring_id: r.id,
        recurring_date: actualDate,
      });
      created++;
    }
    if (created > 0) console.log("[AI BG] 반복 To-Do", created + "건 생성");
  } catch (e) {
    console.error("[AI BG] 반복 생성 실패:", e.message);
  }
}

// ─── 반복 todo 마감 알림 (해당일 10AM, 미완료 시 4PM) ───
async function checkRecurringNotifications() {
  try {
    const kstNow = getKSTNow();
    const hour = kstNow.getUTCHours(); // KST 시간 (이미 +9 했으므로 UTC hours = KST hours)
    const minute = kstNow.getUTCMinutes();
    const today = getKSTToday();

    // 10:00~10:09 또는 16:00~16:09에만 체크 (10분 간격 알람이므로)
    const is10AM = hour === 10 && minute < 10;
    const is4PM = hour === 16 && minute < 10;
    if (!is10AM && !is4PM) return;

    // 평일만
    const d = new Date(today + "T00:00:00+09:00");
    if (!isBusinessDay(d)) return;

    // 오늘 마감인 반복 todo 중 미완료 조회
    const pending = await supaRest("GET", "todos",
      "select=id,content,recurring_date&status=eq.pending&recurring_date=eq." + today);
    // 기한이 오늘인 일반 todo 조회
    const dueTodos = await supaRest("GET", "todos",
      "select=id,content,due_date&status=eq.pending&due_date=eq." + today + "&recurring_id=is.null");

    const recCount = (pending || []).length;
    const dueCount = (dueTodos || []).length;
    if (recCount === 0 && dueCount === 0) return;

    const recTitles = (pending || []).map(t => "• [반복] " + t.content);
    const dueTitles = (dueTodos || []).map(t => "• [기한] " + t.content);
    const allTitles = [...recTitles, ...dueTitles].join("\n");
    const totalCount = recCount + dueCount;

    if (is10AM) {
      chrome.notifications.create("deadline-10am-" + today, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "🔥 오늘 마감 업무 " + totalCount + "건",
        message: allTitles,
        priority: 2,
      });
      console.log("[AI BG] 10AM 마감 알림: 반복", recCount + "건, 기한", dueCount + "건");
    } else if (is4PM) {
      chrome.notifications.create("deadline-4pm-" + today, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "⚠️ 미완료 마감 업무 " + totalCount + "건 (4시)",
        message: allTitles + "\n\n퇴근 전 완료해주세요!",
        priority: 2,
      });
      console.log("[AI BG] 4PM 마감 알림: 반복", recCount + "건, 기한", dueCount + "건");
    }
  } catch (e) {
    console.error("[AI BG] 반복 알림 실패:", e.message);
  }
}

// ─── 알람 이벤트 핸들러 ───
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "todo-check") {
    // 평일 09:00~18:00만 알림
    const kstNow = getKSTNow();
    const day = kstNow.getUTCDay();
    const hour = kstNow.getUTCHours();
    if (day === 0 || day === 6 || hour < 9 || hour >= 18) {
      console.log("[AI BG] 업무시간 외 → 알림 스킵");
      return;
    }

    const today = getKSTToday();
    // 기한 없는 todo + 기한이 오늘인 todo만 (미래 기한 제외)
    const pendingAll = await supaRest("GET", "todos",
      "select=id,content,due_date,recurring_id&status=eq.pending");
    const relevantTodos = (pendingAll || []).filter(t => {
      if (t.recurring_id) return false; // 반복일정은 별도 알림
      if (!t.due_date) return true; // 기한 없음 → 항상 포함
      return t.due_date === today; // 기한 = 오늘만 포함
    });
    // 당일 마감 반복일정
    const recurringToday = await supaRest("GET", "todos",
      "select=id,content&status=eq.pending&recurring_date=eq." + today);
    const totalCount = relevantTodos.length + (recurringToday || []).length;
    console.log("[AI BG] 미완료 To-Do:", relevantTodos.length + "건, 당일 반복:", (recurringToday || []).length + "건");

    if (totalCount > 0) {
      let msg = "";
      if (relevantTodos.length > 0) msg += "할일 " + relevantTodos.length + "건";
      if ((recurringToday || []).length > 0) msg += (msg ? " + " : "") + "반복 " + recurringToday.length + "건";
      chrome.notifications.create("todo-reminder-" + Date.now(), {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "🚨 미완료된 업무가 " + totalCount + "건 있습니다!",
        message: msg + " — 확인해주세요.",
        priority: 2,
      });
    }

    // 다음 알람 시각을 content script에 전달
    const nextAlarm = await chrome.alarms.get("todo-check");
    if (nextAlarm) {
      chrome.runtime.sendMessage({
        type: "next-alarm",
        scheduledTime: nextAlarm.scheduledTime,
      }).catch(() => {});
    }
  }

  if (alarm.name === "recurring-generate") {
    // 매시간 체크하되, 실제 생성은 중복 방지됨
    await generateRecurringTodos();
  }

  if (alarm.name === "recurring-notify") {
    await checkRecurringNotifications();
  }

  // version-check는 content-list.js에서 처리
});

// ─── content script 메시지 핸들러 ───
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Google 로그인 요청
  if (msg.type === "google-login") {
    loginWithGoogle().then((result) => {
      sendResponse({ success: true, email: result.email });
    }).catch((err) => {
      sendResponse({ success: false, error: String(err) });
    });
    return true;
  }

  // OAuth 콜백 (content script에서 토큰 전달)
  if (msg.type === "oauth-callback") {
    if (msg.accessToken) {
      chrome.storage.local.set({ authAccessToken: msg.accessToken, authRefreshToken: msg.refreshToken || "" });
      fetch(SUPABASE_URL + "/auth/v1/user", {
        headers: { Authorization: "Bearer " + msg.accessToken, apikey: SUPABASE_ANON_KEY }
      }).then(r => r.json()).then(user => {
        chrome.storage.local.set({ authUserEmail: user.email || "" });
        if (_oauthResolve) { _oauthResolve({ accessToken: msg.accessToken, email: user.email }); _oauthResolve = null; }
        sendResponse({ success: true, email: user.email });
      }).catch(() => {
        if (_oauthResolve) { _oauthResolve({ accessToken: msg.accessToken, email: "" }); _oauthResolve = null; }
        sendResponse({ success: true });
      });
    } else {
      sendResponse({ success: false });
    }
    return true;
  }

  // 인증 상태 확인 + API 키 로딩
  if (msg.type === "get-auth-config") {
    (async () => {
      const token = await getValidToken();
      if (!token) {
        sendResponse({ authenticated: false });
        return;
      }
      const email = await new Promise(r => chrome.storage.local.get("authUserEmail", res => r(res.authUserEmail || "")));
      // settings에서 OpenAI 키 등 로딩
      const settings = await fetchAuthSettings(token);
      if (!settings) {
        sendResponse({ authenticated: false, error: "설정 로딩 실패" });
        return;
      }
      sendResponse({
        authenticated: true,
        email: email,
        supabaseUrl: SUPABASE_URL,
        supabaseKey: SUPABASE_ANON_KEY,
        accessToken: token,
        openaiKey: settings.openai_key || "",
        employeeMap: settings.employee_map || "",
      });
    })();
    return true;
  }

  if (msg.type === "reload-extension") {
    chrome.storage.local.set({ pendingTabReload: true }, () => {
      chrome.runtime.reload();
    });
    return;
  }

  if (msg.type === "trigger-update") {
    // content script에서 토스트 클릭 → 알림 클릭과 동일한 업데이트 흐름
    chrome.notifications.clear("version-update");
    (async () => {
      try {
        const dlData = await supaRest("GET", "settings", "select=value&key=eq.download_url");
        const downloadUrl = dlData && dlData[0] && dlData[0].value;
        if (!downloadUrl) {
          chrome.storage.local.set({ pendingTabReload: true }, () => chrome.runtime.reload());
          return;
        }
        chrome.runtime.sendNativeMessage("com.jungsem.messenger", {
          action: "update", downloadUrl, targetDir: "C:\\extension"
        }, (response) => {
          chrome.storage.local.set({ pendingTabReload: true }, () => chrome.runtime.reload());
        });
      } catch (e) {
        chrome.storage.local.set({ pendingTabReload: true }, () => chrome.runtime.reload());
      }
    })();
    return;
  }

  if (msg.type === "get-next-alarm") {
    chrome.alarms.get("todo-check", (alarm) => {
      sendResponse({ scheduledTime: alarm ? alarm.scheduledTime : null });
    });
    return true; // async sendResponse
  }

  // ─── Supabase 프록시 쿼리 (content script → background fetch) ───
  if (msg.type === "supabase-query") {
    (async () => {
      try {
        const { url, key } = await getKeys();
        const authToken = await getValidToken();
        const headers = {
          apikey: key,
          Authorization: "Bearer " + (authToken || key),
          "Content-Type": "application/json",
        };
        if (msg.method === "POST") headers["Prefer"] = "return=representation";
        if (msg.isSingle) headers["Accept"] = "application/vnd.pgrst.object+json";

        let endpoint = url + "/rest/v1/" + msg.table;
        if (msg.params && msg.params.length > 0) endpoint += "?" + msg.params.join("&");

        const res = await fetch(endpoint, {
          method: msg.method,
          headers,
          body: msg.body ? JSON.stringify(msg.body) : undefined,
        });

        if (!res.ok) {
          const t = await res.text().catch(() => "");
          sendResponse({ data: null, error: { message: t, code: String(res.status) } });
          return;
        }
        const ct = res.headers.get("content-type") || "";
        if (msg.method === "DELETE" && !ct.includes("json")) { sendResponse({ data: null, error: null }); return; }
        if (msg.method === "PATCH" && !msg.wantReturn && !ct.includes("json")) { sendResponse({ data: null, error: null }); return; }
        const d = await res.json().catch(() => null);
        sendResponse({ data: d, error: null });
      } catch (e) {
        sendResponse({ data: null, error: { message: e.message } });
      }
    })();
    return true;
  }

  // 거래처 폴더 열기 (네이티브 메시징)
  if (msg.type === "open-client-folder") {
    chrome.storage.local.get("clientFolderPath", (result) => {
      const basePath = result.clientFolderPath;
      if (!basePath) {
        sendResponse({ success: false, error: "옵션에서 거래처 폴더 경로를 설정해주세요." });
        return;
      }
      chrome.runtime.sendNativeMessage("com.jungsem.messenger", {
        action: "open_folder",
        basePath: basePath,
        clientCode: msg.clientCode,
      }, (res) => {
        if (chrome.runtime.lastError) {
          console.error("[AI BG] 네이티브 호스트 오류:", chrome.runtime.lastError.message);
          sendResponse({ success: false, error: "install_host.bat을 관리자로 실행해주세요." });
        } else {
          sendResponse(res);
        }
      });
    });
    return true;
  }

  // 파일 다운로드 (AI 파일명 적용 + 거래처 폴더로 이동)
  if (msg.type === "ai-download") {
    let filename = msg.filename;
    const clientCode = msg.clientCode || "";
    // .image 확장자인 경우 HEAD 요청으로 실제 타입 확인
    if (filename.endsWith(".image")) {
      fetch(msg.url, { method: "HEAD" }).then(res => {
        const ct = res.headers.get("content-type") || "";
        const extMap = { "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp", "image/bmp": ".bmp" };
        const realExt = extMap[ct.split(";")[0].trim()] || ".jpg";
        filename = filename.replace(/\.image$/, realExt);
        doDownload(filename);
      }).catch(() => {
        filename = filename.replace(/\.image$/, ".jpg");
        doDownload(filename);
      });
    } else {
      doDownload(filename);
    }
    function doDownload(fn) {
      chrome.downloads.download({
        url: msg.url,
        filename: fn,
        saveAs: false,
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          console.error("[AI BG] 다운로드 실패:", chrome.runtime.lastError.message);
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          console.log("[AI BG] 다운로드 시작:", fn, "id:", downloadId);
          if (clientCode && downloadId) {
            pendingMoves[downloadId] = { clientCode, filename: fn };
          }
          sendResponse({ downloadId });
        }
      });
    }
    return true;
  }
});

// ─── 다운로드 완료 시 거래처 폴더로 이동 ───
const pendingMoves = {};
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state && delta.state.current === "complete" && pendingMoves[delta.id]) {
    const { clientCode, filename } = pendingMoves[delta.id];
    delete pendingMoves[delta.id];
    chrome.storage.local.get("clientFolderPath", (result) => {
      const basePath = result.clientFolderPath;
      if (!basePath) return;
      chrome.downloads.search({ id: delta.id }, (items) => {
        if (!items || !items[0] || !items[0].filename) return;
        const srcPath = items[0].filename;
        console.log("[AI BG] 파일 이동 요청:", srcPath);
        chrome.runtime.sendNativeMessage("com.jungsem.messenger", {
          action: "move_file",
          src: srcPath,
          basePath: basePath,
          clientCode: clientCode,
          filename: filename,
        }, (res) => {
          if (chrome.runtime.lastError) {
            console.error("[AI BG] 파일 이동 실패:", chrome.runtime.lastError.message);
          } else if (res && res.success) {
            console.log("[AI BG] 파일 이동 완료:", res.path);
          } else {
            console.error("[AI BG] 파일 이동 실패:", res ? res.error : "unknown");
          }
        });
      });
    });
  }
});
