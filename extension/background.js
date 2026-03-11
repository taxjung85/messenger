// ─── Supabase 설정 (chrome.storage에서 로드) ───
async function getKeys() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["supabaseUrl", "supabaseKey"], (result) => {
      resolve({ url: result.supabaseUrl || "", key: result.supabaseKey || "" });
    });
  });
}

// ─── Supabase REST 헬퍼 ───
async function supaRest(method, table, params, body) {
  const { url, key } = await getKeys();
  if (!url || !key) return null;
  const headers = {
    apikey: key,
    Authorization: "Bearer " + key,
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
function isWeekend(d) { return d.getDay() === 0 || d.getDay() === 6; }
function isHoliday(d) {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return FIXED_HOLIDAYS.includes(mm + "-" + dd);
}
function isBusinessDay(d) { return !isWeekend(d) && !isHoliday(d); }
function prevBusinessDay(dateStr) {
  const d = new Date(dateStr + "T00:00:00+09:00");
  while (!isBusinessDay(d)) d.setDate(d.getDate() - 1);
  return d.toISOString().substring(0, 10);
}
function getKSTNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}
function getKSTToday() {
  return getKSTNow().toISOString().substring(0, 10);
}

// ─── 알람 등록 + 확장프로그램 리로드 후 탭 새로고침 ───
chrome.runtime.onInstalled.addListener(() => {
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

// 알림 클릭 → 확장프로그램 리로드 후 탭 새로고침
chrome.notifications.onClicked.addListener((notifId) => {
  if (notifId === "version-update") {
    chrome.storage.local.set({ pendingTabReload: true }, () => {
      chrome.runtime.reload();
    });
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
  if (msg.type === "reload-extension") {
    // 플래그 저장 후 확장프로그램 리로드 → 재시작 시 탭 새로고침
    chrome.storage.local.set({ pendingTabReload: true }, () => {
      chrome.runtime.reload();
    });
    return;
  }

  if (msg.type === "get-next-alarm") {
    chrome.alarms.get("todo-check", (alarm) => {
      sendResponse({ scheduledTime: alarm ? alarm.scheduledTime : null });
    });
    return true; // async sendResponse
  }

  // 파일 다운로드 (AI 파일명 적용)
  if (msg.type === "ai-download") {
    let filename = msg.filename;
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
          sendResponse({ downloadId });
        }
      });
    }
    return true; // async sendResponse
  }
});
