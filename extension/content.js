(function () {
  "use strict";

  if (document.getElementById("ai-sidebar-container")) return;
  if (!/\/chats\/\d+/.test(location.pathname)) return;

  // ─── 설정 (chrome.storage에서 로드) ───
  const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
  let SUPABASE_URL = "";
  let SUPABASE_KEY = "";
  let OPENAI_KEY = "";
  let supabase = null;

  // ─── 로그인 이메일 → 직원 이름 매핑 ───
  let currentEmployeeName = "";
  function detectCurrentEmployee() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["employeeMap"], (result) => {
        const mapStr = result.employeeMap || "";
        if (!mapStr) { resolve(""); return; }
        // 페이지에서 로그인 이메일 찾기 (카카오 비즈니스 우상단)
        const emailEl = document.querySelector('[class*="email"], [class*="user_email"], [class*="account"]');
        let pageEmail = "";
        if (emailEl) pageEmail = emailEl.textContent.trim();
        // fallback: 페이지 전체에서 이메일 패턴 찾기
        if (!pageEmail) {
          const allText = document.body ? document.body.innerText : "";
          const emailMatch = allText.match(/[\w.-]+@[\w.-]+\.\w{2,}/);
          if (emailMatch) pageEmail = emailMatch[0];
        }
        if (!pageEmail) { resolve(""); return; }
        // 매핑 파싱: "이메일=이름" 형식
        const lines = mapStr.split("\n").map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
          const [email, name] = line.split("=").map(s => s.trim());
          if (email && name && pageEmail.toLowerCase() === email.toLowerCase()) {
            resolve(name);
            return;
          }
        }
        resolve("");
      });
    });
  }

  async function loadApiKeys() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["supabaseUrl", "supabaseKey", "openaiKey"], (result) => {
        SUPABASE_URL = result.supabaseUrl || "";
        SUPABASE_KEY = result.supabaseKey || "";
        OPENAI_KEY = result.openaiKey || "";
        if (!SUPABASE_URL || !SUPABASE_KEY || !OPENAI_KEY) {
          alert("API 키가 설정되지 않았습니다.\n확장 프로그램 옵션 페이지에서 API 키를 먼저 등록해주세요.\n\n(확장 프로그램 아이콘 우클릭 → 옵션)");
          resolve(false);
          return;
        }
        supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
        resolve(true);
      });
    });
  }

  // ─── 말풍선 배지 시스템 (message ID 기반) ───
  const todoMsgIds = new Set();   // message ID가 todo에 저장됨
  const salaryMsgIds = new Set(); // message ID가 salary에 저장됨
  function normBubble(s) { return (s || "").replace(/\s+/g, "").substring(0, 80); }

  function getBubbleKey(el) {
    if (el.dataset.aiBubbleKey) return el.dataset.aiBubbleKey;
    const clone = el.cloneNode(true);
    const wrap = clone.querySelector(".ai-badge-wrap");
    if (wrap) wrap.remove();
    const key = normBubble(clone.innerText || clone.textContent);
    el.dataset.aiBubbleKey = key;
    return key;
  }

  function addBubbleBadge(el, type) {
    if (el.querySelector(".ai-badge-" + type)) return;
    if (!el.dataset.aiBubbleKey) el.dataset.aiBubbleKey = normBubble(el.innerText || el.textContent);
    let container = el.querySelector(".ai-badge-wrap");
    if (!container) {
      container = document.createElement("div");
      container.className = "ai-badge-wrap";
      Object.assign(container.style, {
        display: "flex", gap: "3px", marginTop: "4px",
        pointerEvents: "none",
      });
      el.appendChild(container);
    }
    const badge = document.createElement("span");
    badge.className = "ai-bubble-badge ai-badge-" + type;
    badge.textContent = type === "todo" ? "TODO" : "SALARY";
    Object.assign(badge.style, {
      fontSize: "9px", fontWeight: "700", lineHeight: "1",
      padding: "2px 5px", borderRadius: "4px",
      color: type === "todo" ? "#4338ca" : "#92400e",
      background: type === "todo" ? "#e0e7ff" : "#fef3c7",
      letterSpacing: "0.5px",
    });
    container.appendChild(badge);
  }

  function removeBubbleBadge(el, type) {
    const badge = el.querySelector(".ai-badge-" + type);
    if (badge) badge.remove();
    const container = el.querySelector(".ai-badge-wrap");
    if (container && container.children.length === 0) container.remove();
  }

  // 말풍선 ↔ messages DB ID 매핑 (최근 2영업일만)
  async function linkBubblesToMsgIds(chatId) {
    // 2영업일 전 날짜 계산 (주말 건너뛰기)
    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    let bdays = 0;
    while (bdays < 2) {
      kst.setDate(kst.getDate() - 1);
      const dow = kst.getDay();
      if (dow !== 0 && dow !== 6) bdays++;
    }
    const sinceDate = kst.toISOString().substring(0, 10) + "T00:00:00+09:00";
    const { data } = await supabase.from("messages")
      .select("id, content, sender_type")
      .eq("chat_id", chatId)
      .gte("sent_at", sinceDate)
      .order("id", { ascending: false })
      .limit(200);
    if (!data) return;
    // content → id 매핑 (같은 content면 최신 id 사용)
    const map = new Map();
    data.forEach(m => {
      const key = normBubble(m.content);
      if (key) map.set(key, String(m.id));
    });
    let matched = 0, unmatched = 0;
    document.querySelectorAll(".bubble_chat").forEach(el => {
      const key = getBubbleKey(el);
      if (map.has(key)) { el.dataset.msgId = map.get(key); matched++; }
      else { unmatched++; console.log("[AI] msgId 매칭실패 | bubbleKey:", JSON.stringify(key.substring(0, 40))); }
    });
    console.log("[AI] linkBubblesToMsgIds: DB=" + data.length + "건, 매칭=" + matched + ", 실패=" + unmatched);
  }

  // ─── todo/salary message_id 백필 ───
  async function backfillMessageIds(clientCode) {
    // message_id가 NULL인 todo/salary 조회
    const [todoRes, salRes] = await Promise.all([
      supabase.from("todos").select("id, content").eq("client_code", clientCode).is("message_id", null).limit(100),
      supabase.from("salary").select("id, content").eq("client_code", clientCode).is("message_id", null).limit(100),
    ]);
    const nullTodos = todoRes.data || [];
    const nullSalary = salRes.data || [];
    if (nullTodos.length === 0 && nullSalary.length === 0) return;

    // messages 테이블에서 해당 거래처 메시지 조회
    const { chatId } = parseChatInfo();
    const { data: msgs } = await supabase.from("messages")
      .select("id, content").eq("chat_id", chatId)
      .order("id", { ascending: false }).limit(500);
    if (!msgs || msgs.length === 0) return;

    // content → message id 매핑 (normBubble로 정규화)
    const msgMap = new Map();
    msgs.forEach(m => {
      const key = normBubble(m.content);
      if (key && !msgMap.has(key)) msgMap.set(key, String(m.id));
    });

    let fixed = 0;
    // todo 백필
    for (const t of nullTodos) {
      const key = normBubble(t.content);
      if (key && msgMap.has(key)) {
        await supabase.from("todos").update({ message_id: msgMap.get(key) }).eq("id", t.id);
        fixed++;
      }
    }
    // salary 백필
    for (const s of nullSalary) {
      const key = normBubble(s.content);
      if (key && msgMap.has(key)) {
        await supabase.from("salary").update({ message_id: msgMap.get(key) }).eq("id", s.id);
        fixed++;
      }
    }
    if (fixed > 0) {
      console.log("[AI] message_id 백필 완료:", fixed + "건 수정 (todo:" + nullTodos.length + ", salary:" + nullSalary.length + ")");
      await restoreBadgesFromDB(clientCode);
    }
  }

  // 상담원 말풍선 여부 판별
  function isAgentBubble(el) {
    const item = el.closest(".item_chat");
    return !!(item && item.classList.contains("item_me"));
  }

  // DB에서 salary/todo의 message_id를 읽어 배지 복원
  async function restoreBadgesFromDB(clientCode) {
    const [salRes, todoRes] = await Promise.all([
      supabase.from("salary").select("message_id").eq("client_code", clientCode),
      supabase.from("todos").select("message_id").eq("client_code", clientCode).eq("status", "pending"),
    ]);
    salaryMsgIds.clear();
    (salRes.data || []).forEach(s => {
      if (s.message_id) s.message_id.split(".").forEach(id => salaryMsgIds.add(id));
    });
    todoMsgIds.clear();
    (todoRes.data || []).forEach(t => {
      if (t.message_id) t.message_id.split(".").forEach(id => todoMsgIds.add(id));
    });
    // 배지 표시 (salary는 고객 말풍선만)
    document.querySelectorAll(".bubble_chat").forEach(el => {
      const msgId = el.dataset.msgId;
      if (!msgId) return;
      if (salaryMsgIds.has(msgId) && !isAgentBubble(el)) addBubbleBadge(el, "salary");
      else removeBubbleBadge(el, "salary");
      if (todoMsgIds.has(msgId)) addBubbleBadge(el, "todo");
      else removeBubbleBadge(el, "todo");
    });
  }

  function refreshBubbleBadges() {
    document.querySelectorAll(".bubble_chat").forEach(el => {
      const msgId = el.dataset.msgId;
      if (!msgId) return;
      if (salaryMsgIds.has(msgId) && !isAgentBubble(el)) addBubbleBadge(el, "salary");
      else removeBubbleBadge(el, "salary");
      if (todoMsgIds.has(msgId)) addBubbleBadge(el, "todo");
      else removeBubbleBadge(el, "todo");
    });
  }

  // ─── 고객 메시지 클릭 팝업 (토글 지원) ───
  function showMessageActionPopup(_e, msgText, bubbleEl) {
    const old = document.getElementById("ai-msg-popup");
    if (old) old.remove();

    const msgId = bubbleEl ? bubbleEl.dataset.msgId : "";
    console.log("[AI] 팝업 msgId:", JSON.stringify(msgId), "| bubbleKey:", JSON.stringify(bubbleEl?.dataset?.aiBubbleKey?.substring(0, 40)), "| dataset:", JSON.stringify(Object.keys(bubbleEl?.dataset || {})));
    const hasTodo = msgId ? todoMsgIds.has(msgId) : false;
    const hasSalary = msgId ? salaryMsgIds.has(msgId) : false;

    const overlay = document.createElement("div");
    overlay.id = "ai-msg-popup";
    Object.assign(overlay.style, {
      position: "fixed", top: "0", left: "0", width: "100%", height: "100%",
      background: "rgba(0,0,0,0.3)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)",
      zIndex: "9999999", display: "flex", alignItems: "center", justifyContent: "center",
    });
    const box = document.createElement("div");
    Object.assign(box.style, {
      background: "rgba(255,255,255,0.97)",
      backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)",
      borderRadius: "16px",
      boxShadow: "0 12px 40px rgba(99,102,241,0.18), 0 4px 12px rgba(0,0,0,0.08)",
      border: "1px solid rgba(226,232,240,0.8)",
      fontFamily: "'Pretendard', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      overflow: "hidden",
    });
    box.innerHTML = `
      <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:6px 0;"></div>
      <div style="display:flex;gap:10px;padding:24px;">
        <button id="ai-popup-todo" style="padding:12px 28px;border:none;border-radius:10px;background:${hasTodo ? "linear-gradient(135deg,#3b82f6,#2563eb)" : "linear-gradient(135deg,#6366f1,#8b5cf6)"};color:white;font-size:14px;font-weight:700;cursor:pointer;transition:all 0.2s;box-shadow:0 2px 8px ${hasTodo ? "rgba(37,99,235,0.25)" : "rgba(99,102,241,0.25)"};">${hasTodo ? "Delete To-Do" : "To-Do"}</button>
        <button id="ai-popup-salary" style="padding:12px 28px;border:none;border-radius:10px;background:${hasSalary ? "#fee2e2" : "linear-gradient(135deg,#f59e0b,#f97316)"};color:${hasSalary ? "#dc2626" : "white"};font-size:14px;font-weight:700;cursor:pointer;transition:all 0.2s;box-shadow:0 2px 8px ${hasSalary ? "rgba(239,68,68,0.15)" : "rgba(245,158,11,0.25)"};">${hasSalary ? "Delete Salary" : "Salary"}</button>
      </div>
    `;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const closePopup = () => overlay.remove();
    setTimeout(() => {
      overlay.addEventListener("click", (ev) => { if (ev.target === overlay) closePopup(); });
    }, 10);

    // ─── To-Do 토글 ───
    box.querySelector("#ai-popup-todo").onclick = async () => {
      closePopup();
      const { clientCode, clientName } = parseClientInfo();
      if (hasTodo) {
        // 부분 삭제: message_id에서 해당 msgId만 제거, content에서 해당 메시지만 제거
        const { data } = await supabase.from("todos").select("id, message_id, content")
          .eq("client_code", clientCode).eq("status", "pending").limit(50);
        const match = (data || []).find(t => {
          if (!t.message_id) return false;
          return t.message_id.split(".").includes(msgId);
        });
        if (match) {
          const ids = match.message_id.split(".").filter(id => id !== msgId);
          const contents = (match.content || "").split("\n").filter(line => {
            // 해당 메시지와 일치하는 줄 제거
            return normBubble(line) !== normBubble(msgText);
          });
          if (ids.length === 0) {
            // 마지막 메시지 → 행 자체 삭제
            await supabase.from("todos").delete().eq("id", match.id);
          } else {
            // 부분 제거 → 업데이트
            await supabase.from("todos").update({
              message_id: ids.join("."),
              content: contents.join("\n") || match.content,
            }).eq("id", match.id);
          }
          todoMsgIds.delete(msgId);
          if (bubbleEl) removeBubbleBadge(bubbleEl, "todo");
          refreshBubbleBadges();
          showToast("To-Do에서 제거되었습니다", true);
        } else {
          showToast("매칭되는 To-Do를 찾지 못했습니다", false);
        }
      } else {
        // 저장
        const todoTitle = await showInputPopup("To-Do 제목", msgText.substring(0, 30), "할 일 내용을 입력하세요");
        if (!todoTitle) return;
        try {
          const { chatId } = parseChatInfo();
          const { error } = await supabase.from("todos").insert({
            chat_id: chatId, content: todoTitle.trim(), status: "pending", assigned_to: currentEmployeeName,
            client_code: clientCode, client_name: clientName,
            message_id: msgId || null, source_type: "human_click",
          });
          if (!error) {
            if (msgId) todoMsgIds.add(msgId);
            if (bubbleEl) addBubbleBadge(bubbleEl, "todo");
          }
          showToast(error ? "To-Do 저장 실패" : "To-Do에 추가되었습니다!", !error);
        } catch (err) { showToast("To-Do 저장 실패", false); }
      }
    };

    // ─── 급여 토글 ───
    box.querySelector("#ai-popup-salary").onclick = async () => {
      closePopup();
      const { clientCode, clientName } = parseClientInfo();
      if (hasSalary) {
        // 삭제: message_id에 해당 msgId가 포함된 salary 찾기
        const { data } = await supabase.from("salary").select("id, content, message_id")
          .eq("client_code", clientCode).limit(50);
        const match = (data || []).find(s => {
          if (!s.message_id) return false;
          return s.message_id.split(".").includes(msgId);
        });
        if (match) {
          const ids = match.message_id.split(".");
          const contents = match.content.split(" / ");
          const idx = ids.indexOf(msgId);

          if (ids.length <= 1) {
            // 마지막 메시지 → 행 전체 삭제
            await supabase.from("salary").delete().eq("id", match.id);
          } else {
            // 해당 메시지만 제거, 나머지 유지
            ids.splice(idx, 1);
            if (idx >= 0 && idx < contents.length) contents.splice(idx, 1);
            await supabase.from("salary").update({
              content: contents.join("\n"),
              message_id: ids.join("."),
            }).eq("id", match.id);
          }
          salaryMsgIds.delete(msgId);
          if (bubbleEl) removeBubbleBadge(bubbleEl, "salary");
          refreshBubbleBadges();
          showToast("급여 메시지 삭제되었습니다", true);
        } else {
          showToast("매칭되는 급여 데이터를 찾지 못했습니다", false);
        }
      } else {
        // 저장
        let period = await showInputPopup("급여 귀속월", "", "예: 2026-03");
        if (period === null) return;
        period = period ? period.trim() : null;
        if (period && !/^\d{4}-\d{2}$/.test(period)) {
          showToast("귀속월은 YYYY-MM 형식으로 입력해주세요 (예: 2026-03)", false);
          return;
        }
        try {
          const now = new Date();
          const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
          const today = kstNow.toISOString().substring(0, 10); // "YYYY-MM-DD"
          const sentAt = kstNow.toISOString().replace("Z", "+09:00");

          // 같은 거래처 + 같은 날짜 행이 있으면 합치기
          const { data: existing } = await supabase.from("salary")
            .select("id, content, message_id")
            .eq("client_code", clientCode)
            .eq("source_type", "human_click")
            .gte("sent_at", today + "T00:00:00+09:00")
            .lte("sent_at", today + "T23:59:59+09:00")
            .limit(1)
            .single();

          let error;
          if (existing) {
            // 기존 행에 합치기
            const newContent = existing.content + " / " + msgText;
            const newMsgId = [existing.message_id, msgId].filter(Boolean).join(".");
            ({ error } = await supabase.from("salary").update({
              content: newContent,
              message_id: newMsgId || null,
              period_guess: period || undefined,
            }).eq("id", existing.id));
          } else {
            // 신규 행
            ({ error } = await supabase.from("salary").insert({
              client_code: clientCode, client_name: clientName,
              content: msgText, payroll_related_yn: "Y",
              period_guess: period,
              sent_at: sentAt,
              message_id: msgId || null,
              source_type: "human_click",
            }));
          }
          if (!error) {
            if (msgId) salaryMsgIds.add(msgId);
            if (bubbleEl) addBubbleBadge(bubbleEl, "salary");
          }
          showToast(error ? "급여 저장 실패" : (existing ? "급여 메시지 추가됨" : "급여 테이블에 저장되었습니다!"), !error);
        } catch (err) { showToast("급여 저장 실패", false); }
      }
    };
  }

  // ─── 토스트 알림 ───
  function showToast(msg, success) {
    const toast = document.createElement("div");
    toast.textContent = msg;
    Object.assign(toast.style, {
      position: "fixed", bottom: "30px", left: "50%", transform: "translateX(-50%)",
      padding: "10px 24px", borderRadius: "8px", fontSize: "13px", fontWeight: "600", zIndex: "999999",
      color: "white", background: success ? "#10b981" : "#ef4444",
      boxShadow: "0 4px 12px rgba(0,0,0,0.15)", transition: "opacity 0.3s",
    });
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = "0"; setTimeout(() => toast.remove(), 300); }, 2000);
  }

  // ─── 커스텀 입력 팝업 (prompt 대체) ───
  function showInputPopup(title, defaultValue, placeholder) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      Object.assign(overlay.style, {
        position: "fixed", top: "0", left: "0", width: "100%", height: "100%",
        background: "rgba(0,0,0,0.3)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)",
        zIndex: "9999999", display: "flex", alignItems: "center", justifyContent: "center",
      });
      const box = document.createElement("div");
      Object.assign(box.style, {
        width: "320px", padding: "24px",
        background: "rgba(255,255,255,0.97)",
        backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)",
        borderRadius: "16px",
        boxShadow: "0 12px 40px rgba(99,102,241,0.18), 0 4px 12px rgba(0,0,0,0.08)",
        border: "1px solid rgba(226,232,240,0.8)",
        fontFamily: "'Pretendard', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      });
      box.innerHTML = `
        <div style="font-size:14px;font-weight:700;color:#0f172a;margin-bottom:14px;">${title}</div>
        <input type="text" id="ai-input-popup-field" value="${(defaultValue || "").replace(/"/g, "&quot;")}"
          placeholder="${(placeholder || "").replace(/"/g, "&quot;")}"
          style="width:100%;box-sizing:border-box;padding:10px 12px;border:1.5px solid #d1d5db;border-radius:10px;font-size:13px;outline:none;transition:border 0.2s;background:#f8fafc;" />
        <div style="display:flex;gap:8px;margin-top:16px;">
          <button id="ai-input-popup-ok" style="flex:1;padding:10px 0;border:none;border-radius:10px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:white;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 2px 8px rgba(99,102,241,0.25);transition:all 0.2s;">확인</button>
          <button id="ai-input-popup-cancel" style="flex:1;padding:10px 0;border:1px solid rgba(226,232,240,0.8);border-radius:10px;background:rgba(255,255,255,0.85);color:#64748b;font-size:13px;font-weight:600;cursor:pointer;transition:all 0.2s;">취소</button>
        </div>
      `;
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      const input = box.querySelector("#ai-input-popup-field");
      input.focus();
      input.select();
      input.addEventListener("focus", () => { input.style.borderColor = "#6366f1"; });
      input.addEventListener("blur", () => { input.style.borderColor = "#d1d5db"; });

      const close = (val) => { overlay.remove(); resolve(val); };
      box.querySelector("#ai-input-popup-ok").onclick = () => {
        close(input.value.trim());
      };
      box.querySelector("#ai-input-popup-cancel").onclick = () => close(null);
      overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(null); });
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { close(input.value.trim()); }
        if (ev.key === "Escape") close(null);
      });
    });
  }

  function parseChatInfo() {
    const parts = location.pathname.split("/").filter(Boolean);
    return { channelId: parts[0] || "unknown", chatId: parts[2] || "unknown" };
  }

  // ─── 거래처코드/거래처명 추출 (페이지 제목에서 "1138_깊이와 통찰 학원(2관학원) - 정셈..." 형식) ───
  function parseClientInfo() {
    const title = document.title || "";
    console.log("[AI] 페이지 제목:", title);
    // "1138_거래처명" 패턴 찾기
    const match = title.match(/(\d{2,})_([^-]+)/);
    if (match) {
      const clientCode = match[1].trim();
      const clientName = match[2].trim().replace(/\s*\d{2,4}-\d{3,4}-\d{4}\s*/, "").trim();
      console.log("[AI] 거래처코드:", clientCode, "거래처명:", clientName);
      return { clientCode, clientName };
    }
    return { clientCode: "", clientName: title.split(" - ")[0].trim() };
  }

  // ─── 파일 카테고리 키워드 판별 ───
  function detectFileCategory(text) {
    const t = text.replace(/\s/g, "");
    // 부가가치세
    if (/부가세|부가가치|매입|매출|세금계산서|계산서합계|전자세금|영세율|면세|과세표준|부가tax|매입매출/.test(t)) return "부가";
    // 원천
    if (/원천|급여|인건비|4대보험|일용직|사업소득|근로소득|주민번호|고용보험|산재|월급|갑근세|원천징수|연말정산|퇴직금|퇴직소득/.test(t)) return "원천";
    // 법인세
    if (/법인세|법인결산|법인조정|세무조정|소득금액조정|법인신고/.test(t)) return "법인세";
    // 종합소득세
    if (/종소세|종합소득|종합소득세|소득세신고/.test(t)) return "종소세";
    // 결산
    if (/결산|재무제표|재무상태|손익계산|대차대조|잔액증명|시산표|합계잔액/.test(t)) return "결산";
    return "기타";
  }

  // ─── 감지된 메시지 기록 (순서대로) ───
  const messageLog = [];       // { senderType, content, senderName }
  const processedCounts = new Map();  // 중복 방지 (키 → DB 카운트)
  const domCounts = new Map();        // DOM에서 발견된 횟수
  let dbDedupReady = false;  // DB 중복 체크 완료 여부

  // ─── 페이지 로드 시 기존 DB 메시지로 중복 방지 세트 초기화 ───
  async function initDedupFromDB() {
    try {
      const { chatId } = parseChatInfo();
      // 기존 메시지 + max seq 동시 조회
      const [dedupRes, seqRes] = await Promise.all([
        supabase.from("messages")
          .select("sender_type, content, sent_at, created_at")
          .eq("chat_id", chatId)
          .order("created_at", { ascending: false })
          .limit(200),
        supabase.from("messages")
          .select("seq")
          .order("seq", { ascending: false })
          .limit(1),
      ]);
      if (dedupRes.data) {
        dedupRes.data.forEach((m) => {
          const key = m.sender_type + "|" + m.content.substring(0, 100);
          processedCounts.set(key, (processedCounts.get(key) || 0) + 1);
        });
        console.log("[AI] DB 중복 방지 초기화:", processedCounts.size + "종류, 총", dedupRes.data.length + "건");
      }
      // seq 카운터를 DB max 이후부터 시작
      if (seqRes.data && seqRes.data.length > 0) {
        msgSeqCounter = seqRes.data[0].seq || 0;
        console.log("[AI] seq 카운터 시작:", msgSeqCounter);
      }
    } catch (e) {
      console.error("[AI] DB 중복 초기화 실패:", e.message);
    }
    dbDedupReady = true;
    // 대기 중이던 메시지 처리
    if (pendingMessages.length > 0) {
      console.log("[AI] 대기 메시지 처리:", pendingMessages.length + "건");
      for (const msg of pendingMessages) {
        onMessageDetected(msg.senderType, msg.senderName, msg.content, msg.sentTime);
      }
      pendingMessages.length = 0;
    }
  }

  // ─── AI 상태 ───
  let isAnalyzing = false;
  let pendingFeedbackId = null; // AI 답변 후 상담원 실제 답변 대기 중인 feedback ID
  let pendingAiReply = ""; // 비교용 AI 답변 텍스트
  let aiDebounceTimer = null;
  let lastProcessedBatch = "";  // 마지막으로 AI 처리한 고객 메시지 뭉치
  let feedbackCache = null; // 피드백 캐시 { commentData, likeData, clientFbData, feedbackText }

  // ─── KST 시간 반환 ───
  function getKSTTimeString() {
    return new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  }

  // ─── 메시지 감지 → DB 저장 + 로그에 추가 ───
  const pendingMessages = []; // dbDedupReady 전에 감지된 메시지 임시 저장
  const savingKeys = new Set(); // 저장 진행 중인 키 (비동기 중복 방지)
  let msgSeqCounter = 0; // DOM 순서 보존용 시퀀스
  async function onMessageDetected(senderType, senderName, content, sentTime) {
    if (!dbDedupReady) {
      pendingMessages.push({ senderType, senderName, content, sentTime });
      return;
    }
    const key = senderType + "|" + content.substring(0, 100);
    // 동기 락: 이미 저장 진행 중이면 스킵
    if (savingKeys.has(key)) return;
    const domCount = (domCounts.get(key) || 0) + 1;
    domCounts.set(key, domCount);
    const dbCount = processedCounts.get(key) || 0;
    if (domCount <= dbCount) return;
    processedCounts.set(key, (processedCounts.get(key) || 0) + 1);
    savingKeys.add(key); // 락 설정

    messageLog.push({ senderType, content, senderName });
    console.log("[AI] 메시지:", senderType, content.substring(0, 40));

    // DB 저장
    const { channelId, chatId } = parseChatInfo();
    const { clientCode, clientName } = parseClientInfo();
    msgSeqCounter++;
    const insertData = {
      channel_id: channelId,
      chat_id: chatId,
      sender_type: senderType,
      sender_name: senderName,
      content: content,
      client_code: clientCode,
      client_name: clientName,
      seq: msgSeqCounter,
    };
    if (sentTime) insertData.sent_at = sentTime;
    const { error } = await supabase.from("messages").insert(insertData);
    if (error) console.error("[AI] DB 저장 실패:", error.message);
    savingKeys.delete(key); // 락 해제

    if (senderType === "customer") {
      // 고객 메시지 → AI 분석 예약 (디바운스)
      if (aiDebounceTimer) clearTimeout(aiDebounceTimer);
      aiDebounceTimer = setTimeout(() => {
        aiDebounceTimer = null;
        tryTriggerAI();
      }, 1500);
    } else if (senderType === "agent") {
      // 상담원이 응답했으면 대기 중인 AI 호출 취소
      if (aiDebounceTimer) {
        clearTimeout(aiDebounceTimer);
        aiDebounceTimer = null;
        console.log("[AI] 상담원 응답 감지 → AI 호출 취소");
      }
      // 대기 중인 AI feedback에 실제 상담원 답변 기록
      if (pendingFeedbackId) {
        const fid = pendingFeedbackId;
        const aiReply = pendingAiReply;
        pendingFeedbackId = null;
        pendingAiReply = "";
        supabase.from("ai_feedbacks").update({ feedback: content }).eq("id", fid).then(({ error }) => {
          if (error) {
            console.error("[AI] 상담원 답변 feedback 업데이트 실패:", error.message);
          } else {
            console.log("[AI] 상담원 실제 답변 feedback 저장 완료 (id:", fid, ")");
            // AI 답변과 상담원 답변 일치 비교 → DB에 GOOD 표시
            const norm = (s) => s.replace(/\s+/g, "").replace(/[.,!?~\-]/g, "");
            const nAi = norm(aiReply), nAgent = norm(content);
            console.log("[AI] 비교 — AI:", nAi.substring(0, 50), "| 상담원:", nAgent.substring(0, 50), "| 일치:", nAi === nAgent);
            if (nAi === nAgent) {
              console.log("[AI] GOOD — AI 답변을 그대로 사용!");
              showToast("GOOD — AI 답변을 그대로 사용했습니다!", true);
              const s = document.getElementById("ai-status");
              if (s) { s.textContent = "GOOD — AI 답변과 상담원 답변이 일치합니다!"; s.style.background = "#ecfdf5"; s.style.color = "#065f46"; s.style.borderColor = "#a7f3d0"; }
              // DB에 GOOD 표시
              supabase.from("ai_feedbacks").update({ good_reply_yn: "Y" }).eq("id", fid).then(({ error: e2 }) => {
                if (e2) console.error("[AI] GOOD 업데이트 실패:", e2.message);
                else console.log("[AI] GOOD DB 저장 완료 (id:", fid, ")");
              });
            } else {
              // 불일치 → N
              supabase.from("ai_feedbacks").update({ good_reply_yn: "N" }).eq("id", fid);
            }
          }
        });
      }
    }
  }

  // ─── 화면 가장 아래 고객 말풍선 텍스트 가져오기 ───
  function getLastVisibleCustomerMessage() {
    const bubbles = document.querySelectorAll(
      '.bubble_chat'
    );
    if (bubbles.length === 0) return "";

    // 화면 위치(bottom)가 가장 큰 말풍선 = 가장 아래 메시지
    let bestEl = null;
    let bestBottom = -Infinity;
    for (const el of bubbles) {
      if (el.closest && el.closest("#ai-sidebar-container")) continue;
      const text = (el.innerText || "").trim();
      if (isNoise(text)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.bottom > bestBottom) {
        bestBottom = rect.bottom;
        bestEl = el;
      }
    }

    if (!bestEl) return "";
    const text = (bestEl.innerText || "").trim();

    // 상담원=item_me 클래스 있음, 고객=없음
    const itemChat = bestEl.closest('.item_chat');
    let isAgent = !!(itemChat && itemChat.classList.contains("item_me"));

    console.log("[AI] 화면 최하단 메시지:", text.substring(0, 40), isAgent ? "(상담원)" : "(고객)");

    // 상담원이 마지막으로 답변했으면 → 이미 대응 완료, AI 불필요
    if (isAgent) {
      console.log("[AI] 마지막 메시지가 상담원 → AI 대기");
      return "";
    }

    return text;
  }

  // ─── AI 호출 판단 (새 고객 메시지 감지 시) ───
  async function tryTriggerAI() {
    console.log("[AI] tryTriggerAI: isAnalyzing=" + isAnalyzing);
    // 분석 중이면 최대 30초 대기
    let waitCount = 0;
    while (isAnalyzing && waitCount < 30) {
      await new Promise(r => setTimeout(r, 1000));
      waitCount++;
    }
    if (isAnalyzing) { console.warn("[AI] tryTriggerAI: 대기 시간 초과, 스킵"); return; }
    // DB에서 최근 미응답 고객 메시지 가져오기 (재분석과 동일 로직)
    const { chatId } = parseChatInfo();
    const { data } = await supabase
      .from("messages")
      .select("sender_type, content")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: false })
      .limit(10);
    if (!data || data.length === 0) return;
    const recent = data.reverse();
    let lastAgentIdx = -1;
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].sender_type === "agent") { lastAgentIdx = i; break; }
    }
    const unanswered = recent.slice(lastAgentIdx + 1).filter(m => m.sender_type === "customer");
    if (unanswered.length === 0) {
      console.log("[AI] 미응답 고객 메시지 없음 → 스킵");
      return;
    }
    const newMsgText = unanswered.map(m => m.content).join("\n");
    if (newMsgText === lastProcessedBatch) {
      console.log("[AI] 동일한 메시지 → 스킵");
      return;
    }
    console.log("[AI] 미응답 고객 메시지:", unanswered.length + "건");
    callOpenAI(unanswered.map(m => ({ senderType: m.sender_type, content: m.content, senderName: "" })));
  }

  // ─── 강제 재분석: DB 최근 고객 메시지 무조건 분석 ───
  async function forceReanalyze() {
    if (isAnalyzing) return;
    const { chatId } = parseChatInfo();
    const { data } = await supabase
      .from("messages")
      .select("sender_type, content")
      .eq("chat_id", chatId)
      .order("created_at", { ascending: false })
      .limit(10);
    if (!data || data.length === 0) {
      showError("최근 메시지가 없습니다");
      return;
    }
    const recent = data.reverse(); // 오래된 순
    const customerMsgs = recent.filter(m => m.sender_type === "customer");
    if (customerMsgs.length === 0) {
      showError("고객 메시지가 없습니다");
      return;
    }
    // 최근 고객 메시지 중 마지막 것을 분석 (답변 API만)
    const lastCustomerMsg = customerMsgs[customerMsgs.length - 1];
    console.log("[AI] 재분석: 최근 고객 메시지 강제 분석 (답변만)");
    callOpenAI([{ senderType: "customer", content: lastCustomerMsg.content, senderName: "" }], true, true);
  }

  // ─── OpenAI API 호출 헬퍼 (재시도 포함) ───
  async function fetchAI(prompt, label, maxTokens, model) {
    label = label || "OpenAI";
    model = model || "gpt-5.4";
    const body = JSON.stringify({
      model: model,
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: maxTokens || 4096,
      response_format: { type: "json_object" },
    });
    const headers = {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + OPENAI_KEY,
    };
    let res = await fetch(OPENAI_URL, { method: "POST", headers, body });
    if (res.status === 500 || res.status === 503 || res.status === 429) {
      console.log("[AI] " + label + " " + res.status + " 에러 → 3초 후 재시도");
      await new Promise(r => setTimeout(r, 3000));
      res = await fetch(OPENAI_URL, { method: "POST", headers, body });
      if (!res.ok) throw new Error(label + " 서버 에러 (재시도 실패): " + res.status);
    } else if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(label + " 서버 에러 " + res.status + ": " + (errBody.error?.message || ""));
    }
    const json = await res.json();
    const text = json.choices?.[0]?.message?.content || "";
    const usage = json.usage || {};
    console.log("[AI] " + label + " 토큰:", "입력=" + (usage.prompt_tokens || "?") + " 출력=" + (usage.completion_tokens || "?") + " 합계=" + (usage.total_tokens || "?"));
    console.log("[AI] " + label + " 원본 응답:", text.substring(0, 200));
    if (!text) console.warn("[AI] " + label + " 빈 응답! finish_reason:", json.choices?.[0]?.finish_reason, "model:", json.model, "usage:", JSON.stringify(json.usage));
    const result_usage = { prompt_tokens: usage.prompt_tokens || 0, completion_tokens: usage.completion_tokens || 0, total_tokens: usage.total_tokens || 0 };
    try {
      const parsed = JSON.parse(text);
      parsed._usage = result_usage;
      return parsed;
    } catch (e) {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { const p = JSON.parse(jsonMatch[0]); p._usage = result_usage; return p; } catch (e2) {}
      }
      // JSON 파싱 완전 실패 시 텍스트에서 내용 추출 시도
      console.warn("[AI] " + label + " JSON 파싱 실패, 텍스트에서 추출 시도:", text.substring(0, 200));
      if (label.includes("To-Do")) {
        // To-Do: 텍스트 자체를 todo로 사용
        const cleaned = text.replace(/```json|```/g, "").trim();
        if (cleaned) return { todos: [cleaned.substring(0, 100)], _usage: result_usage };
        return { todos: [], _usage: result_usage };
      }
      if (label.includes("답변")) {
        // 답변: 텍스트 자체를 reply로 사용
        const cleaned = text.replace(/```json|```/g, "").trim();
        if (cleaned) return { replies: [cleaned], _usage: result_usage };
        return { replies: [], _usage: result_usage };
      }
      throw new Error(label + " JSON 파싱 실패");
    }
  }

  // ─── AI 병렬 호출 (To-Do + 추천 답변 동시) ───
  async function callOpenAI(newMessages, force, replyOnly) {
    isAnalyzing = true;
    showLoading();
    const { chatId } = parseChatInfo();
    const { clientCode, clientName } = parseClientInfo();

    try {
      // DB에서 미응답 고객 메시지 추출 (최신→상담원 답변 전까지)
      const unansweredObjs = await getUnansweredCustomerMessages(chatId);
      const unanswered = unansweredObjs.map(u => u.content);
      const unansweredIds = unansweredObjs.map(u => u.id).filter(Boolean);
      const newMsgText = unanswered.length > 0 ? unanswered.join("\n") : (
        Array.isArray(newMessages) ? newMessages.map(m => m.content).join("\n") : newMessages
      );
      const displayMsg = unanswered.length > 0 ? unanswered.join(" / ") : (
        Array.isArray(newMessages) ? newMessages.filter(m => m.senderType === "customer").map(m => m.content).join(" / ") : newMessages
      );
      console.log("[AI] 미응답 고객 메시지:", unanswered.length + "건");
      unanswered.forEach((msg, i) => console.log("[AI]   (" + (i+1) + ")", msg.substring(0, 60)));

      const history = await getRecentMessages(chatId);
      const historyText = history
        .map((m) => (m.sender_type === "customer" ? "고객" : "상담원") + ": " + m.content)
        .join("\n");

      // 과거 피드백 로드 (캐시 사용)
      let feedbackText = "";
      try {
        feedbackText = await loadFeedbackCached(clientCode, clientName);
      } catch (e) { console.warn("[AI] 피드백 로드 실패:", e.message); }

      const todoPrompt = `고객의 새 메시지 전체를 보고, 직원이 처리해야 할 업무를 1건으로 요약하세요.

새 메시지:
${newMsgText}

JSON으로 응답: { "todos": ["요약된 업무 1건"] }
규칙:
- 여러 요청이 있으면 하나로 합쳐서 요약 (예: "부가가치세 과세표준증명 3개년 + 재무제표확인원 전달")
- 최대 1건만
- 질문/인사/감사는 제외
- 없으면 빈배열`;

      const replyPrompt = `너는 세무사사무실 직원이야. 거래처(고객사) 담당자가 카카오톡으로 문의하면 답변을 추천해줘.
${feedbackText ? "\n★★★ 최우선 참고사항 (아래 코멘트/좋은답변이 프롬프트 규칙보다 우선함. 코멘트와 규칙이 충돌하면 코멘트를 따를 것) ★★★" + feedbackText + "\n" : ""}
이전 대화:
${historyText}

★ 새 고객 메시지:
${newMsgText}

반드시 답변 1개만 생성하세요.
JSON 응답 형식: {"replies":["여기에 실제 답변 내용"]}

답변 스타일:
- 존댓말, 카톡 어투
- 2~3문장

유형별 답변법:
1) 세법 질문 (공제 가능여부, 세금 관련):
   → 결론 먼저 (가능/불가/경우에 따라 다름)
   → 확실히 되는 건 "가능합니다"로 끝. 조건/단서 붙이지 말 것
   → 안 되는 건 "추천드리지 않습니다" + 리스크 한 줄
   → 예: "네, 직원 식비 법인카드 결제는 복리후생비로 부가세 공제 가능합니다."
   → 예: "개인 차량 주유비 공제는 추천드리지 않습니다. 업무용 입증이 안 되면 가산세 리스크가 있어요."
   → "확인해보겠습니다"만 하는 답변 금지. 반드시 결론을 말할 것

2) 서류 요청 (과세표준증명, 납세증명 등):
   → "네, 준비해서 전달드리겠습니다"

3) 일반 문의/인사:
   → 자연스럽게 응대

금지사항:
- "고객님", "OO님" 등 상대방을 지칭하는 호칭 일체 금지
- "확인 후 회신드리겠습니다" 같은 떠넘기기 답변
- 법조문 인용
- 장문 설명`;

      // 병렬 호출: 각각 독립 실행, 먼저 끝나는 것부터 즉시 처리
      const startTime = Date.now();
      console.log("[AI] To-Do API 호출합니다");
      console.log("[AI] 답변 API 호출합니다");
      console.log("[AI] 답변 프롬프트:\n", replyPrompt);

      // 토큰 사용량 저장용
      let replyTokens = 0;
      let todoTokens = 0;

      // 답변 API — 완료 즉시 화면에 표시
      const replyPromise = fetchAI(replyPrompt, "답변 API", 1300, "gpt-4.1-nano").then((r) => {
        const sec = ((Date.now() - startTime) / 1000).toFixed(1);
        const replies = (r.replies || []).slice(0, 1); // 최대 1개만 사용
        replyTokens = r._usage?.total_tokens || 0;
        console.log("[AI] 답변 API 완료 (" + sec + "초) — 결과:", replies.length, "개, 토큰:", replyTokens);
        showRecommendations(replies, displayMsg, replyTokens, todoTokens);
        lastProcessedBatch = newMsgText;
      });

      // To-Do API — replyOnly면 스킵
      const todoPromise = replyOnly ? Promise.resolve() : fetchAI(todoPrompt, "To-Do API", 800, "gpt-4.1-nano").then(async (r) => {
        const sec = ((Date.now() - startTime) / 1000).toFixed(1);
        todoTokens = r._usage?.total_tokens || 0;
        console.log("[AI] To-Do API 완료 (" + sec + "초) — 결과:", r.todos?.length || 0, "건, 토큰:", todoTokens);
        const todos = r.todos || [];
        if (todos.length > 0) {
          const empName = currentEmployeeName;
          const { clientCode, clientName } = parseClientInfo();
          // 기존 To-Do 조회 (같은 거래처의 pending 항목)
          // 중복 체크: 담당자 무관, 최근 7일 이내 모든 todo 대상
          const sevenDaysAgo = new Date(Date.now() + 9 * 60 * 60 * 1000 - 7 * 24 * 60 * 60 * 1000).toISOString();
          const { data: existingTodos } = await supabase
            .from("todos")
            .select("content")
            .eq("client_code", clientCode)
            .gte("created_at", sevenDaysAgo);
          const existingList = (existingTodos || []).map(t => t.content.replace(/\s+/g, ""));

          let savedCount = 0;
          for (const todo of todos) {
            // 중복 체크: 공백 제거 후 완전일치 또는 70% 이상 포함 시 스킵
            const normTodo = todo.replace(/\s+/g, "");
            const isDup = existingList.some(ex => {
              if (ex === normTodo) return true;
              // 짧은 쪽이 긴 쪽에 70% 이상 포함되면 중복
              const shorter = ex.length < normTodo.length ? ex : normTodo;
              const longer = ex.length < normTodo.length ? normTodo : ex;
              return longer.includes(shorter.substring(0, Math.floor(shorter.length * 0.7)));
            });
            if (isDup) {
              console.log("[AI] To-Do 중복 스킵:", todo.substring(0, 40));
              continue;
            }
            const messageIdStr = unansweredIds.length > 0 ? unansweredIds.join(".") : null;
            await supabase.from("todos").insert({
              chat_id: chatId, content: todo, status: "pending", assigned_to: empName,
              client_code: clientCode, client_name: clientName,
              message_id: messageIdStr, source_type: "ai_auto",
            });
            savedCount++;
          }
          console.log("[AI] To-Do 저장:", savedCount + "건 (중복 제외)", "담당:", empName);
          if (savedCount > 0) {
            unansweredIds.forEach(id => todoMsgIds.add(String(id)));
            refreshBubbleBadges();
          }
        }
      }).catch((e) => {
        console.error("[AI] To-Do API 실패 (" + ((Date.now() - startTime) / 1000).toFixed(1) + "초):", e.message);
      });

      // 둘 다 끝날 때까지 대기
      await Promise.all([replyPromise, todoPromise]);
      // 두 API 모두 완료 후 토큰 사용량 DB 업데이트
      if (pendingFeedbackId && (replyTokens > 0 || todoTokens > 0)) {
        supabase.from("ai_feedbacks")
          .update({ reply_tokens: replyTokens, todo_tokens: todoTokens })
          .eq("id", pendingFeedbackId)
          .then(() => console.log("[AI] 토큰 사용량 저장:", "답변=" + replyTokens, "To-Do=" + todoTokens));
      }
    } catch (err) {
      console.error("[AI] 분석 실패:", err);
      showError("AI 분석 실패: " + err.message);
    } finally {
      isAnalyzing = false;
    }
  }

  // ─── 급여 백필: 전체 대화 스캔 → 급여 여부 판단 → 원문 그대로 저장 ───
  async function backfillSalaryFromChat(chatId, clientCode) {
    try {
      const minDate = getMinBusinessDate();
      const { data: allMsgs } = await supabase.from("messages")
        .select("id, sender_type, content, sent_at, is_sent_salary_yn")
        .eq("chat_id", chatId)
        .gte("sent_at", minDate + "T00:00:00+09:00")
        .order("sent_at", { ascending: true })
        .limit(100);
      if (!allMsgs || allMsgs.length === 0) return;

      // 이미 salary에 저장된 message_id 조회
      const { data: existingSalary } = await supabase.from("salary")
        .select("message_id")
        .eq("client_code", clientCode)
        .limit(200);
      const existingMsgIds = new Set((existingSalary || []).map(s => s.message_id).filter(Boolean));

      const unsent = allMsgs.filter(m => m.is_sent_salary_yn !== "Y");
      const customerMsgs = unsent.filter(m => m.sender_type === "customer");
      if (customerMsgs.length === 0) {
        console.log("[AI] 급여 백필: 미전송 고객 메시지 없음 → 스킵");
        return;
      }

      // 급여 키워드 사전체크
      const salaryKeywords = /급여|인건비|일용직|4대보험|원천|사업소득|근로소득|주민번호|주민등록|보험료|고용보험|산재|월급|부업|인건|알바/;
      const allText = customerMsgs.map(m => m.content).join(" ");
      if (!salaryKeywords.test(allText)) {
        console.log("[AI] 급여 백필: 급여 키워드 없음 → API 스킵");
        return;
      }

      const chatText = unsent.map(m =>
        (m.sender_type === "customer" ? "고객" : "상담원") + ": " + m.content
      ).join("\n");

      // 급여 여부만 판단 (구조화는 별도 API에서 처리)
      const prompt = `대화에서 급여 등록/변경 요청이 있는지 판단.
인사/질문/일반 문의만 있으면 is_salary:false.
대화:
${chatText}
JSON: {"is_salary":bool}`;

      const r = await fetchAI(prompt, "급여 판단 API", 300, "gpt-4.1-nano");
      if (!r.is_salary) {
        console.log("[AI] 급여 백필: 급여 관련 내용 없음");
        return;
      }

      const { clientName } = parseClientInfo();

      // 고객 메시지를 " / "로 합쳐서 1행으로 저장
      const bfMsgIds = customerMsgs.map(m => m.id).filter(Boolean);
      const bfMessageIdStr = bfMsgIds.length > 0 ? bfMsgIds.join(".") : null;

      // message_id 기반 중복 체크
      if (bfMessageIdStr && existingMsgIds.has(bfMessageIdStr)) {
        console.log("[AI] 급여 백필 message_id 중복 스킵:", bfMessageIdStr);
        return;
      }

      const content = customerMsgs.map(m => m.content).join("\n");
      const sentAt = customerMsgs[customerMsgs.length - 1].sent_at;

      const { error: insErr } = await supabase.from("salary").insert({
        client_code: clientCode, client_name: clientName,
        content: content,
        payroll_related_yn: "Y",
        period_guess: null,
        sent_at: sentAt,
        message_id: bfMessageIdStr,
        source_type: "ai_backfill",
      });

      if (insErr) {
        console.error("[AI] 급여 백필 저장 실패:", insErr.message);
      } else {
        console.log("[AI] 급여 백필 완료: 원문 저장 (" + customerMsgs.length + "건 합침)");
        const sentIds = bfMsgIds;
        if (sentIds.length > 0) {
          await supabase.from("messages").update({ is_sent_salary_yn: "Y" }).in("id", sentIds);
        }
        await restoreBadgesFromDB(clientCode);
        showToast("급여 자동 감지 저장됨", true);
      }
    } catch (e) {
      console.error("[AI] 급여 백필 실패:", e.message);
    }
  }

  // 이전 대화 맥락용: 최근 5건 (시간순)
  // ─── 피드백 캐시 로드 (페이지 내 첫 호출만 DB 조회, 이후 캐시) ───
  async function loadFeedbackCached(clientCode, clientName) {
    if (feedbackCache) {
      console.log("[AI] 피드백 캐시 사용");
      return feedbackCache;
    }
    const fbStart = Date.now();
    const [commentRes, likeRes, clientFbRes] = await Promise.all([
      supabase.from("ai_feedbacks")
        .select("customer_message, ai_reply, feedback, client_code, client_name")
        .neq("feedback", "👍 좋은 답변")
        .not("feedback", "is", null)
        .order("created_at", { ascending: false })
        .limit(10),
      supabase.from("ai_feedbacks")
        .select("customer_message, ai_reply, feedback, client_code, client_name")
        .eq("good_reply_yn", "Y")
        .order("created_at", { ascending: false })
        .limit(10),
      clientCode
        ? supabase.from("ai_feedbacks")
            .select("customer_message, ai_reply, feedback, client_code, client_name")
            .eq("client_code", clientCode)
            .order("created_at", { ascending: false })
        : Promise.resolve({ data: [] }),
    ]);
    const commentData = commentRes.data || [];
    const likeData = likeRes.data || [];
    const clientFbData = clientFbRes.data || [];
    console.log("[AI] 피드백 DB 로드:", (Date.now() - fbStart) + "ms");
    console.log("[AI] 참고 코멘트 (최근 10개):", commentData.length > 0
      ? commentData.map(f => "고객: " + (f.customer_message || "").substring(0, 50) + " → 코멘트: " + (f.feedback || "")).join(" | ")
      : "없음");
    console.log("[AI] 참고 좋은답변 (최근 10개):", likeData.length > 0
      ? likeData.map(f => "고객: " + (f.customer_message || "").substring(0, 50) + " → AI: " + (f.ai_reply || "").substring(0, 50)).join(" | ")
      : "없음");
    console.log("[AI] 같은 거래처(" + (clientCode || "없음") + ") 코멘트:", clientFbData.length > 0
      ? clientFbData.map(f => "고객: " + (f.customer_message || "").substring(0, 50) + " → " + (f.feedback || "")).join(" | ")
      : "없음");
    const parts = [];
    if (commentData.length > 0) {
      parts.push("최근 상담원 코멘트 (이걸 참고해서 답변 품질을 높여줘):\n" +
        commentData.map(f => "- 고객질문: " + (f.customer_message || "").substring(0, 50) + " → AI답변: " + (f.ai_reply || "").substring(0, 50) + " → 코멘트: " + (f.feedback || "")).join("\n"));
    }
    if (likeData.length > 0) {
      parts.push("좋은 답변 예시 (이런 식으로 답변해줘):\n" +
        likeData.map(f => "- 고객질문: " + (f.customer_message || "").substring(0, 50) + " → 좋은답변: " + (f.ai_reply || "").substring(0, 80)).join("\n"));
    }
    if (clientFbData.length > 0) {
      parts.push("이 거래처(" + clientCode + " " + (clientName || "") + ") 전용 코멘트 (이 거래처 답변 시 반드시 참고):\n" +
        clientFbData.map(f => "- 고객질문: " + (f.customer_message || "").substring(0, 50) + " → " + (f.feedback === "👍 좋은 답변" ? "좋은답변: " + (f.ai_reply || "").substring(0, 80) : "코멘트: " + (f.feedback || ""))).join("\n"));
    }
    feedbackCache = parts.length > 0 ? "\n\n" + parts.join("\n\n") : "";
    return feedbackCache;
  }

  async function getRecentMessages(chatId) {
    const { data, error } = await supabase
      .from("messages")
      .select("sender_type, sender_name, content, sent_at, seq")
      .eq("chat_id", chatId)
      .order("sent_at", { ascending: false })
      .order("seq", { ascending: false })
      .limit(5);
    if (error || !data) return [];
    return data.reverse();
  }

  // 답변 API용: 가장 최신 대화부터 상담원 답변 직전까지의 고객 메시지만 추출
  async function getUnansweredCustomerMessages(chatId) {
    const { data, error } = await supabase
      .from("messages")
      .select("id, sender_type, content, sent_at, seq")
      .eq("chat_id", chatId)
      .order("sent_at", { ascending: false })
      .order("seq", { ascending: false })
      .limit(30);
    if (error || !data) return [];

    // 최신순으로 탐색, 상담원 메시지 나오면 중단
    const unanswered = [];
    for (const m of data) {
      if (m.sender_type === "agent") break;
      if (m.sender_type === "customer") unanswered.push({ id: m.id, content: m.content });
    }
    return unanswered.reverse(); // 시간순으로 반환
  }

  // ─── 백그라운드: feedback=NULL인 ai_feedbacks 행에 상담원 답변 매칭 ───
  async function backfillMissingFeedback() {
    try {
      // feedback이 NULL인 행 조회 (최근 50건)
      const { data: nullRows, error } = await supabase.from("ai_feedbacks")
        .select("id, customer_message, ai_reply, chat_id, client_code, created_at")
        .is("feedback", null)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error || !nullRows || nullRows.length === 0) {
        console.log("[AI] backfill: 미매칭 피드백 없음");
        return;
      }
      console.log("[AI] backfill: feedback=NULL 행", nullRows.length + "건 발견");

      let filled = 0;
      for (const row of nullRows) {
        if (!row.customer_message) continue;

        // customer_message가 " / "로 합쳐진 경우 첫 번째 메시지로 매칭 (원래 질문)
        const msgParts = row.customer_message.split(" / ");
        const lastCustMsg = msgParts[0].trim();

        // 1단계: 해당 채팅방의 전체 메시지를 sent_at 순으로 가져오기
        let resolvedChatId = row.chat_id || null;
        let chatQuery = supabase.from("messages")
          .select("id, sender_type, content, sent_at, seq")
          .order("sent_at", { ascending: true })
          .order("seq", { ascending: true });
        if (resolvedChatId) {
          chatQuery = chatQuery.eq("chat_id", resolvedChatId);
        } else {
          // chat_id 없으면 customer_message로 채팅방 찾기
          const { data: finder } = await supabase.from("messages")
            .select("chat_id").eq("sender_type", "customer").eq("content", lastCustMsg).limit(1);
          if (!finder || finder.length === 0) {
            console.log("[AI] backfill: id=" + row.id, "채팅방 못 찾음:", lastCustMsg.substring(0, 40));
            continue;
          }
          resolvedChatId = finder[0].chat_id;
          chatQuery = chatQuery.eq("chat_id", resolvedChatId);
        }
        const { data: allMsgs } = await chatQuery;
        if (!allMsgs || allMsgs.length === 0) continue;

        // 2단계: 고객 메시지 위치 찾고, 같은 sent_at 또는 이후에서 상담원 답변 찾기
        // seq 순서 = DOM 순서이므로 앞쪽(이후)에서만 탐색
        let custIdx = -1;
        for (let i = allMsgs.length - 1; i >= 0; i--) {
          if (allMsgs[i].sender_type === "customer" && allMsgs[i].content === lastCustMsg) {
            custIdx = i;
            break;
          }
        }
        if (custIdx === -1) {
          console.log("[AI] backfill: id=" + row.id, "메시지 목록에서 못 찾음:", lastCustMsg.substring(0, 40));
          continue;
        }

        let agentMsgs = null;
        for (let i = custIdx + 1; i < allMsgs.length; i++) {
          if (allMsgs[i].sender_type === "agent") {
            agentMsgs = [{ content: allMsgs[i].content }];
            break;
          }
        }
        const targetChatId = resolvedChatId;

        if (!agentMsgs || agentMsgs.length === 0) continue;

        const agentReply = agentMsgs[0].content;
        const norm = (s) => s.replace(/\s+/g, "").replace(/[.,!?~\-]/g, "");
        const goodYn = (row.ai_reply && norm(row.ai_reply) === norm(agentReply)) ? "Y" : "N";

        // feedback + chat_id 동시 업데이트
        const updateObj = { feedback: agentReply, good_reply_yn: goodYn };
        if (!row.chat_id && targetChatId) updateObj.chat_id = targetChatId;

        const { error: upErr } = await supabase.from("ai_feedbacks")
          .update(updateObj)
          .eq("id", row.id);

        if (!upErr) {
          filled++;
          console.log("[AI] backfill: id=" + row.id, "고객:" + lastCustMsg.substring(0, 30), "→ 상담원:" + agentReply.substring(0, 30), "(GOOD=" + goodYn + ")");
        }
      }
      console.log("[AI] backfill 완료:", filled + "/" + nullRows.length + "건 채움");

      // feedback은 있는데 good_reply_yn이 NULL인 행 보정
      const { data: noGoodRows } = await supabase.from("ai_feedbacks")
        .select("id, ai_reply, feedback")
        .not("feedback", "is", null)
        .is("good_reply_yn", null)
        .limit(50);
      if (noGoodRows && noGoodRows.length > 0) {
        const norm = (s) => s.replace(/\s+/g, "").replace(/[.,!?~\-]/g, "");
        let fixed = 0;
        for (const r of noGoodRows) {
          const goodYn = (r.ai_reply && r.feedback && norm(r.ai_reply) === norm(r.feedback)) ? "Y" : "N";
          await supabase.from("ai_feedbacks").update({ good_reply_yn: goodYn }).eq("id", r.id);
          fixed++;
        }
        console.log("[AI] backfill good_reply_yn 보정:", fixed + "건");
      }
    } catch (e) {
      console.error("[AI] backfill 에러:", e.message);
    }
  }

  // ─── UI 함수들 ───
  function showLoading() {
    const s = document.getElementById("ai-status");
    if (s) {
      s.className = "ai-status loading";
      s.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;gap:8px;">' +
        '<span class="ai-spinner"></span><span>AI가 분석 중입니다...</span></div>';
    }
    const l = document.getElementById("ai-recommendations");
    if (l) l.innerHTML =
      '<div style="text-align:center;padding:30px 20px;color:#6366f1;">' +
      '<div class="ai-spinner-large"></div>' +
      '<div style="margin-top:12px;font-size:13px;">고객 메시지를 분석하고 있습니다</div>' +
      '<div style="margin-top:4px;font-size:11px;color:#9ca3af;">잠시만 기다려주세요</div></div>';
  }

  function showError(msg) {
    const s = document.getElementById("ai-status");
    if (s) { s.className = "ai-status error"; s.textContent = msg; }
  }

  function showRecommendations(replies, customerMsg, replyTokens, todoTokens) {
    const { clientCode, clientName } = parseClientInfo();
    const s = document.getElementById("ai-status");
    if (s) { s.className = "ai-status success"; s.textContent = "추천 답변이 준비되었습니다"; }
    const list = document.getElementById("ai-recommendations");
    if (!list) return;
    list.innerHTML = "";

    if (customerMsg) {
      const msgBox = document.createElement("div");
      msgBox.style.cssText = "padding:10px 12px;background:var(--ai-bg-card);border:1px solid #e2e8f0;border-radius:var(--ai-radius-md);margin-bottom:12px;font-size:12px;color:var(--ai-text-main);line-height:1.4;box-shadow:var(--ai-shadow-sm);backdrop-filter:var(--ai-blur);";
      const preview = customerMsg.length > 80 ? customerMsg.substring(0, 80) + "..." : customerMsg;
      msgBox.innerHTML = '<div style="font-size:10px;font-weight:700;color:var(--ai-primary);margin-bottom:6px;display:flex;align-items:center;gap:4px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>분석 대상 메시지</div>' +
        '<div style="word-break:keep-all;">' + preview.replace(/</g, "&lt;").replace(/\n/g, " | ") + '</div>';
      list.appendChild(msgBox);
    }

    replies.forEach(async (reply, i) => {
      const card = document.createElement("div");
      card.className = "ai-card ai-reply-block";
      card.innerHTML =
        '<div style="font-size:11px;color:var(--ai-primary);font-weight:800;margin-bottom:6px;display:flex;align-items:center;gap:4px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg>추천 답변</div>' +
        '<div class="ai-reply-text" style="font-size:13px;color:#1e293b;line-height:1.5;cursor:pointer;padding:10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;" title="클릭하여 입력창에 삽입">' + reply.replace(/</g, "&lt;") + '</div>' +
        '<div style="margin-top:10px;">' +
          '<button class="ai-btn ai-btn-insert ai-btn-full" style="background:var(--ai-primary);color:white;border:none;">입력창에 삽입</button>' +
        '</div>';
      card.querySelector(".ai-reply-text").addEventListener("click", () => insertIntoChatInput(reply));
      card.querySelector(".ai-btn-insert").addEventListener("click", (e) => { e.stopPropagation(); insertIntoChatInput(reply); });
      list.appendChild(card);

      // AI 답변을 ai_feedbacks에 저장 (feedback NULL인 기존 행 있으면 ai_reply 대체, 없으면 신규 삽입)
      const { chatId: fbChatId } = parseChatInfo();
      const { data: existingFb } = await supabase.from("ai_feedbacks")
        .select("id")
        .eq("client_code", clientCode || "")
        .eq("chat_id", fbChatId || "")
        .is("feedback", null)
        .order("created_at", { ascending: false })
        .limit(1);
      console.log("[AI] ai_feedbacks 기존 미답변 행:", existingFb?.length || 0, "건", existingFb?.[0]?.id || "없음");

      let fbPromise;
      if (existingFb && existingFb.length > 0) {
        // 기존 미답변 행의 ai_reply 업데이트
        fbPromise = supabase.from("ai_feedbacks")
          .update({ ai_reply: reply, customer_message: customerMsg || "", reply_tokens: replyTokens || 0, todo_tokens: todoTokens || 0 })
          .eq("id", existingFb[0].id)
          .select("id").single();
      } else {
        // 신규 삽입
        fbPromise = supabase.from("ai_feedbacks").insert({
          customer_message: customerMsg || "",
          ai_reply: reply,
          feedback: null,
          client_code: clientCode || "",
          client_name: clientName || "",
          chat_id: fbChatId || "",
          reply_tokens: replyTokens || 0,
          todo_tokens: todoTokens || 0,
        }).select("id").single();
      }
      fbPromise.then(({ data, error }) => {
        if (!error && data) {
          pendingFeedbackId = data.id;
          pendingAiReply = reply;
          console.log("[AI] ai_feedbacks 저장, 상담원 답변 대기 중 (id:", data.id, ")");
        }
      });
    });
  }

  function insertIntoChatInput(text) {
    const selectors = ['textarea[placeholder*="메시지"]', 'textarea[placeholder*="보내기"]', 'textarea', '[contenteditable="true"]', 'input[type="text"]'];
    let input = null;
    for (const sel of selectors) { input = document.querySelector(sel); if (input) break; }
    if (!input) { console.error("[AI] 입력창 못 찾음"); return; }

    if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set
        || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(input, text); else input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      input.textContent = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    input.focus();

    const s = document.getElementById("ai-status");
    if (s) { s.className = "ai-status success"; s.textContent = "✅ 입력창에 텍스트를 삽입했습니다."; }
  }

  // ─── 노이즈 필터 ───
  const NOISE_PATTERNS = [
    /^(오전|오후)\s?\d{1,2}:\d{2}$/,
    /^\d{4}\.\d{2}\.\d{2}/,
    /여기까지 읽었습니다/,
    /님이\s*보냄/,
    /챗봇이\s*보냄/,
    /채팅방\s*레이어/,
    /메시지\s*입력\s*폼/,
    /연결\s*끊김/,
    /대화가\s*불가능한\s*상태/,
    /상담\s*상태/,
    /친구\s*아님/,
    /친구아님/,
    /중요\s*채팅방/,
    /메모\s*내용/,
    /사이드\s*메뉴/,
    /알림톡\/친구톡/,
    /관리자센터에서\s*확인할\s*수\s*없습니다/,
    /^전송$/,
    /^상담중$/,
    /^상담종료$/,
    /^[  \n\r\t]+$/, // 공백/줄바꿈만
  ];
  function isNoise(text) {
    if (!text || text.length < 2) return true;
    // 줄바꿈 제거 후에도 체크
    const flat = text.replace(/[\n\r]+/g, " ").trim();
    if (!flat || flat.length < 2) return true;
    for (const pat of NOISE_PATTERNS) {
      if (pat.test(flat)) return true;
    }
    return false;
  }

  // ─── 최근 영업일 계산 (오늘 + 직전 영업일) ───
  function getMinBusinessDate() {
    const KST_OFFSET = 9 * 60 * 60 * 1000;
    const now = new Date(Date.now() + KST_OFFSET);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    // 직전 영업일 찾기 (주말/공휴일 건너뛰기)
    const holidays = new Set([
      // 2026 대한민국 공휴일 (월-일 형식, 필요시 추가)
      "01-01", "01-28", "01-29", "01-30", "03-01",
      "05-05", "05-24", "06-06", "08-15",
      "09-24", "09-25", "09-26", "10-03", "10-09", "12-25",
    ]);
    const yr = today.getFullYear();

    let prev = new Date(today);
    for (let i = 0; i < 10; i++) {
      prev.setDate(prev.getDate() - 1);
      const day = prev.getDay(); // 0=일, 6=토
      if (day === 0 || day === 6) continue;
      const mmdd = String(prev.getMonth() + 1).padStart(2, "0") + "-" + String(prev.getDate()).padStart(2, "0");
      if (holidays.has(mmdd)) continue;
      break; // 영업일 발견
    }
    return prev.toISOString().substring(0, 10); // "YYYY-MM-DD"
  }

  // ─── 메시지 추출 (검증된 로직) ───
  function extractMessages(rootNode) {
    const insertPromises = [];
    if (!rootNode || !rootNode.querySelectorAll) return insertPromises;
    if (rootNode.closest && rootNode.closest("#ai-sidebar-container")) return insertPromises;
    if (rootNode.id === "ai-sidebar-container") return insertPromises;

    const bubbleSelector = '.bubble_chat';
    const candidates = rootNode.querySelectorAll(bubbleSelector);
    const isSelfBubble = rootNode.matches && rootNode.matches(bubbleSelector);
    const toCheck = candidates.length > 0 ? candidates : (isSelfBubble ? [rootNode] : []);

    if (!extractMessages._processedSet) extractMessages._processedSet = new Set();

    for (const el of toCheck) {
      if (el.closest && el.closest("#ai-sidebar-container")) continue;
      const text = (el.innerText || el.textContent || "").trim();
      if (isNoise(text)) continue;
      // DOM 속성 체크 (빠른 경로)
      if (el.dataset && el.dataset.aiProcessed === "1") continue;
      if (el.dataset) el.dataset.aiProcessed = "1";

      let senderType = "customer";

      // 상담원=item_me 클래스 있음, 고객=없음
      const itemChat = el.closest('.item_chat');
      if (itemChat && itemChat.classList.contains("item_me")) senderType = "agent";

      let senderName = "";
      const group = el.closest('[class*="group"], [class*="wrap"], [class*="item"]');
      if (group) {
        const nameEl = group.querySelector('[class*="name"], [class*="Name"], [class*="nick"], [class*="sender"]');
        if (nameEl) senderName = nameEl.textContent.trim();
      }

      // ─── 클릭 핸들러: 날짜 필터와 무관하게 모든 말풍선에 부착 ───
      const isBubble = el.matches && el.matches(bubbleSelector);

      // 상담원 메시지 → 템플릿 저장
      if (senderType === "agent" && isBubble && !el.dataset.aiTemplateReady) {
        el.dataset.aiTemplateReady = "1";
        el.style.cursor = "pointer";
        el.title = "클릭하면 자주 쓰는 답변에 저장";
        el.addEventListener("click", async (e) => {
          e.stopPropagation();
          const msgText = (el.innerText || "").trim();
          if (!msgText || msgText.length < 2) return;
          navigator.clipboard.writeText(msgText).then(() => {
            console.log("[AI] 상담원 메시지 클립보드 복사 완료");
          }).catch(() => {});
          const title = await showInputPopup("템플릿 제목", msgText.substring(0, 20), "템플릿 제목을 입력하세요");
          if (!title) return;
          await supabase.from("templates").insert({ title: title.trim(), content: msgText });
          const list = document.getElementById("ai-template-list");
          if (list && typeof window._refreshTemplates === "function") {
            window._refreshTemplates();
          }
          showToast("템플릿에 저장되었습니다!", true);
        });
      }

      // 고객 메시지 → To-Do / 급여 저장 + 클립보드 복사 + 배지 표시
      if (senderType === "customer" && isBubble && !el.dataset.aiTodoReady) {
        el.dataset.aiTodoReady = "1";
        el.style.cursor = "pointer";
        el.title = "클릭하면 To-Do 또는 급여 저장";
        // 원본 키 저장 + message ID 기반 배지 표시
        if (!el.dataset.aiBubbleKey) el.dataset.aiBubbleKey = normBubble(text);
        const elMsgId = el.dataset.msgId;
        if (elMsgId && todoMsgIds.has(elMsgId)) addBubbleBadge(el, "todo");
        if (elMsgId && salaryMsgIds.has(elMsgId)) addBubbleBadge(el, "salary");
        el.addEventListener("click", async (e) => {
          e.stopPropagation();
          // 배지 텍스트 제외한 원본 메시지 추출
          const clone = el.cloneNode(true);
          const badgeWrap = clone.querySelector(".ai-badge-wrap");
          if (badgeWrap) badgeWrap.remove();
          const msgText = (clone.innerText || clone.textContent || "").trim();
          if (!msgText || msgText.length < 2) return;
          navigator.clipboard.writeText(msgText).then(() => {
            console.log("[AI] 고객 메시지 클립보드 복사 완료");
          }).catch(() => {});
          showMessageActionPopup(e, msgText, el);
        });
      }

      // 보낸 시간 추출 (근처에서 "오전 09:32" 또는 "오후 03:24" 패턴 찾기)
      let sentTime = "";
      // 날짜 구분: 메시지의 item_chat 기준으로 이전 형제를 역추적하여 날짜 구분선 찾기
      let dateStr = "";
      const dateAnchor = el.closest('.item_chat') || el.parentElement;
      if (dateAnchor) {
        let sibling = dateAnchor.previousElementSibling;
        for (let i = 0; i < 50 && sibling; i++) {
          const txt = (sibling.textContent || "").trim();
          const dm = txt.match(/(\d{4})\.(\d{2})\.(\d{2})/);
          if (dm) {
            dateStr = dm[1] + "-" + dm[2] + "-" + dm[3];
            break;
          }
          sibling = sibling.previousElementSibling;
        }
      }
      // fallback: 마지막으로 발견한 날짜 or 오늘 날짜
      if (!dateStr && extractMessages._lastDateStr) {
        dateStr = extractMessages._lastDateStr;
      }
      if (!dateStr) {
        const now = new Date();
        const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
        dateStr = kst.toISOString().substring(0, 10);
      }
      extractMessages._lastDateStr = dateStr;
      // 시간 추출: groupEl → 주변 형제 → 마지막 추출 시간 fallback
      const groupEl = el.closest('[class*="group"], [class*="wrap"], [class*="item"], [class*="message"]') || el.parentElement;
      let timeMatch = null;
      if (groupEl) {
        timeMatch = (groupEl.textContent || "").match(/(오전|오후)\s*(\d{1,2}):(\d{2})/);
      }
      // groupEl에서 못 찾으면 다음/이전 형제에서 시간 찾기
      if (!timeMatch && el.parentElement) {
        let sibling = el.parentElement.nextElementSibling;
        for (let i = 0; i < 3 && sibling && !timeMatch; i++) {
          timeMatch = (sibling.textContent || "").match(/(오전|오후)\s*(\d{1,2}):(\d{2})/);
          sibling = sibling.nextElementSibling;
        }
      }
      if (timeMatch) {
        let h = parseInt(timeMatch[2]);
        const m = timeMatch[3];
        if (timeMatch[1] === "오후" && h < 12) h += 12;
        if (timeMatch[1] === "오전" && h === 12) h = 0;
        sentTime = dateStr + "T" + String(h).padStart(2, "0") + ":" + m + ":00+09:00";
        extractMessages._lastSentTime = sentTime; // 캐시
      } else if (extractMessages._lastSentTime) {
        // 같은 시간대 그룹이면 마지막 추출 시간 사용
        sentTime = extractMessages._lastSentTime;
      }

      // 날짜 필터: sent_at을 추출 못한 메시지 or 직전 영업일 이전 메시지는 스킵
      if (!sentTime) {
        if (el.dataset) el.dataset.aiProcessed = "1";
        continue;
      }
      const msgDate = sentTime.substring(0, 10); // "YYYY-MM-DD"
      if (!extractMessages._minDate) extractMessages._minDate = getMinBusinessDate();
      if (msgDate < extractMessages._minDate) {
        if (el.dataset) el.dataset.aiProcessed = "1";
        continue;
      }

      // 콘텐츠+발신자+시간 기반 중복 체크: DOM 노드 교체되어도 같은 메시지면 스킵
      const contentKey = senderType + "|" + text.substring(0, 100) + "|" + sentTime;
      if (extractMessages._processedSet.has(contentKey)) continue;
      extractMessages._processedSet.add(contentKey);

      insertPromises.push(onMessageDetected(senderType, senderName, text, sentTime));
    }
    return insertPromises;
  }

  // ─── 파일 다운로드 가로채기 (파일명 AI 추천) ───
  function setupDownloadInterceptor() {
    document.addEventListener("click", async (e) => {
      // 1차: <a> 태그 (href 있는 것)
      let anchor = e.target.closest('a[href]');
      let href = "";
      let originalFilename = "";

      if (anchor) {
        href = anchor.getAttribute("href") || "";
        const hasDownload = anchor.hasAttribute("download");
        const fileExtMatch = href.match(/\.(\w{2,5})(\?|$)/);
        if (!hasDownload && !fileExtMatch) anchor = null; // 다운로드 링크 아님
      }

      // 2차: 카카오 다운로드 아이콘 (.ico_download) 전용
      if (!anchor) {
        const btn = e.target.closest('.ico_download');
        if (!btn) return;
        // 부모 영역에서 다운로드 링크 찾기 (여러 단계 탐색)
        let parent = btn.parentElement;
        for (let i = 0; i < 5 && parent && !anchor; i++) {
          anchor = parent.querySelector('a[download]') || parent.querySelector('a[href*="."]') || parent.querySelector('a[href]');
          parent = parent.parentElement;
        }
        if (!anchor) return;
        href = anchor.getAttribute("href") || "";
      }

      // 사이드바 내부 클릭 무시
      if (anchor.closest("#ai-sidebar-container")) return;

      e.preventDefault();
      e.stopPropagation();

      // 파일명 추출: download 속성 → 주변 텍스트에서 파일명 → URL → fallback
      originalFilename = anchor.getAttribute("download") || "";
      if (!originalFilename || originalFilename === "true" || !/\.\w{2,5}$/.test(originalFilename)) {
        // 주변 영역에서 실제 파일명 찾기 (확장자 포함된 텍스트)
        const fileArea = anchor.closest('[class*="file"], [class*="attach"], [class*="download"], .bundle_file') || anchor.parentElement;
        const areaText = fileArea ? fileArea.textContent : "";
        const fnMatch = areaText.match(/([^\s/\\<>"]+\.(xlsx?|pdf|docx?|hwp|csv|zip|pptx?|jpg|jpeg|png|gif|txt|hwpx?))/i);
        if (fnMatch) {
          originalFilename = fnMatch[1].trim();
        } else {
          originalFilename = originalFilename || href.split("/").pop().split("?")[0] || "file";
        }
      }

      // 확장자 추출
      let ext = "";
      const extMatch = originalFilename.match(/\.(\w{2,5})$/);
      if (extMatch) {
        ext = "." + extMatch[1].toLowerCase();
      } else {
        const urlExtMatch = href.match(/\.(\w{2,5})(?:\?|$)/);
        if (urlExtMatch) {
          ext = "." + urlExtMatch[1];
        } else {
          ext = ".image";
        }
      }
      console.log("[AI] 다운로드 가로채기:", originalFilename, "확장자:", ext);

      // 주변 대화 5개씩 수집
      const bubble = anchor.closest(".item_chat") || anchor.closest(".bubble_chat") || anchor.parentElement;
      const contextMsgs = [];
      if (bubble) {
        // 이전 5개
        let prev = bubble.previousElementSibling;
        const befores = [];
        for (let i = 0; i < 5 && prev; i++) {
          const txt = (prev.innerText || "").trim();
          if (txt && txt.length > 1 && !txt.match(/^\d{4}\.\d{2}\.\d{2}/)) befores.unshift(txt.substring(0, 100));
          prev = prev.previousElementSibling;
        }
        contextMsgs.push(...befores);
        // 현재
        const curTxt = (bubble.innerText || "").trim();
        if (curTxt) contextMsgs.push("[파일] " + originalFilename + " | " + curTxt.substring(0, 100));
        // 이후 5개
        let next = bubble.nextElementSibling;
        for (let i = 0; i < 5 && next; i++) {
          const txt = (next.innerText || "").trim();
          if (txt && txt.length > 1 && !txt.match(/^\d{4}\.\d{2}\.\d{2}/)) contextMsgs.push(txt.substring(0, 100));
          next = next.nextElementSibling;
        }
      }

      const { clientCode, clientName } = parseClientInfo();
      const safeClientName = (clientName || "unknown").replace(/[\\/:"*?<>|]/g, "_");
      const safeOrigName = originalFilename.replace(/\.\w+$/, "").replace(/[\\/:"*?<>|]/g, "_");

      // 키워드 기반 카테고리 판별
      const allText = (originalFilename + " " + contextMsgs.join(" ")).toLowerCase();
      const category = detectFileCategory(allText);

      const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const dateTag = kstNow.toISOString().substring(2, 10).replace(/-/g, "");
      const finalName = (clientCode || "unknown") + "_" + safeClientName + "_" + safeOrigName + "_" + category + "_" + dateTag + ext;
      console.log("[AI] 최종 파일명:", finalName);

      // background에 다운로드 요청
      const downloadUrl = href.startsWith("http") ? href : new URL(href, location.origin).href;
      chrome.runtime.sendMessage({
        type: "ai-download",
        url: downloadUrl,
        filename: finalName,
        clientCode: clientCode,
      }, (resp) => {
        if (resp && resp.error) {
          console.error("[AI] 다운로드 실패:", resp.error);
          // 실패 시 원본 다운로드 fallback
          const fallbackA = document.createElement("a");
          fallbackA.href = href;
          fallbackA.download = finalName;
          fallbackA.click();
        } else {
          showToast("다운로드: " + finalName, true);
        }
      });
    }, true); // capture phase로 등록하여 기본 핸들러보다 먼저 실행
    console.log("[AI] 다운로드 가로채기 활성화");
    // toast 제거 — 콘솔 로그만
  }

  // ─── 자료 일괄 다운로드 ───
  async function bulkDownloadFiles() {
    const { clientCode, clientName } = parseClientInfo();
    const safeClientName = (clientName || "unknown").replace(/[\\/:"*?<>|]/g, "_");
    const minDate = getMinBusinessDate(); // 2영업일 이내

    // 이미 다운로드한 URL 기록 (중복 방지)
    const storageKey = "ai_downloaded_" + (clientCode || "all");
    const stored = await new Promise(r => chrome.storage.local.get(storageKey, d => r(d[storageKey] || [])));
    const downloadedSet = new Set(stored);

    // 화면에서 다운로드 가능한 파일 링크 수집
    const allAnchors = [];

    // 1) <a download> 링크
    document.querySelectorAll('a[download]').forEach(a => {
      if (a.closest("#ai-sidebar-container")) return;
      allAnchors.push(a);
    });

    // 2) .ico_download 아이콘 → 부모에서 <a> 찾기
    document.querySelectorAll('.ico_download').forEach(btn => {
      if (btn.closest("#ai-sidebar-container")) return;
      let parent = btn.parentElement;
      for (let i = 0; i < 5 && parent; i++) {
        const a = parent.querySelector('a[download]') || parent.querySelector('a[href*="."]') || parent.querySelector('a[href]');
        if (a && !allAnchors.includes(a)) {
          allAnchors.push(a);
          break;
        }
        parent = parent.parentElement;
      }
    });

    if (allAnchors.length === 0) {
      showToast("다운로드할 파일이 없습니다", false);
      return;
    }

    // 날짜 필터: 파일 근처 말풍선의 날짜 확인
    const filtered = [];
    for (const a of allAnchors) {
      const href = a.getAttribute("href") || "";
      if (!href || downloadedSet.has(href)) continue;

      // 날짜 확인: 가장 가까운 날짜 구분선에서 추출
      const itemChat = a.closest('.item_chat') || a.parentElement;
      let dateStr = "";
      if (itemChat) {
        let sib = itemChat.previousElementSibling;
        for (let i = 0; i < 50 && sib; i++) {
          const txt = (sib.textContent || "").trim();
          const dm = txt.match(/(\d{4})\.(\d{2})\.(\d{2})/);
          if (dm) { dateStr = dm[1] + "-" + dm[2] + "-" + dm[3]; break; }
          sib = sib.previousElementSibling;
        }
      }
      // 날짜 없으면 오늘로 간주
      if (!dateStr) {
        const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
        dateStr = kst.toISOString().substring(0, 10);
      }
      if (dateStr < minDate) continue; // 2영업일 이전 → 스킵
      filtered.push(a);
    }

    if (filtered.length === 0) {
      showToast("2영업일 이내 다운로드 파일 없음", false);
      return;
    }

    showToast("일괄 다운로드 시작: " + filtered.length + "개 파일", true);
    const newDownloaded = [];

    for (let idx = 0; idx < filtered.length; idx++) {
      const a = filtered[idx];
      const href = a.getAttribute("href") || "";
      // 파일명 추출: download 속성 → 주변 텍스트 → URL → fallback
      let originalFilename = a.getAttribute("download") || "";
      if (!originalFilename || originalFilename === "true" || !/\.\w{2,5}$/.test(originalFilename)) {
        const fileArea = a.closest('[class*="file"], [class*="attach"], [class*="download"], .bundle_file') || a.parentElement;
        const areaText = fileArea ? fileArea.textContent : "";
        const fnMatch = areaText.match(/([^\s/\\<>"]+\.(xlsx?|pdf|docx?|hwp|csv|zip|pptx?|jpg|jpeg|png|gif|txt|hwpx?))/i);
        if (fnMatch) {
          originalFilename = fnMatch[1].trim();
        } else {
          originalFilename = originalFilename || href.split("/").pop().split("?")[0] || "file";
        }
      }

      let ext = "";
      const extMatch = originalFilename.match(/\.(\w{2,5})$/);
      if (extMatch) {
        ext = "." + extMatch[1].toLowerCase();
      } else {
        const urlExtMatch = href.match(/\.(\w{2,5})(?:\?|$)/);
        if (urlExtMatch) ext = "." + urlExtMatch[1];
        else ext = ".file";
      }

      // 주변 대화 수집 (전후 5개)
      const bubble = a.closest(".item_chat") || a.closest(".bubble_chat") || a.parentElement;
      const contextMsgs = [];
      if (bubble) {
        let prev = bubble.previousElementSibling;
        const befores = [];
        for (let i = 0; i < 5 && prev; i++) {
          const txt = (prev.innerText || "").trim();
          if (txt && txt.length > 1 && !txt.match(/^\d{4}\.\d{2}\.\d{2}/)) befores.unshift(txt.substring(0, 100));
          prev = prev.previousElementSibling;
        }
        contextMsgs.push(...befores);
        const curTxt = (bubble.innerText || "").trim();
        if (curTxt) contextMsgs.push("[파일] " + originalFilename + " | " + curTxt.substring(0, 100));
        let next = bubble.nextElementSibling;
        for (let i = 0; i < 5 && next; i++) {
          const txt = (next.innerText || "").trim();
          if (txt && txt.length > 1 && !txt.match(/^\d{4}\.\d{2}\.\d{2}/)) contextMsgs.push(txt.substring(0, 100));
          next = next.nextElementSibling;
        }
      }

      const safeOrigName = originalFilename.replace(/\.\w+$/, "").replace(/[\\/:"*?<>|]/g, "_") || "file";
      const allText = (originalFilename + " " + contextMsgs.join(" ")).toLowerCase();
      const category = detectFileCategory(allText);

      const kstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
      const dateTag = kstNow.toISOString().substring(2, 10).replace(/-/g, "");
      const finalName = (clientCode || "unknown") + "_" + safeClientName + "_" + safeOrigName + "_" + category + "_" + dateTag + ext;

      // 다운로드 요청
      const downloadUrl = href.startsWith("http") ? href : new URL(href, location.origin).href;
      await new Promise(resolve => {
        chrome.runtime.sendMessage({
          type: "ai-download",
          url: downloadUrl,
          filename: finalName,
          clientCode: clientCode,
        }, (resp) => {
          if (resp && resp.error) {
            console.error("[AI] 일괄 다운로드 실패:", finalName, resp.error);
          } else {
            console.log("[AI] 일괄 다운로드:", finalName);
            newDownloaded.push(href);
          }
          resolve();
        });
      });

      // 연속 다운로드 차단 방지
      if (idx < filtered.length - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // 다운로드 기록 저장 (중복 방지)
    if (newDownloaded.length > 0) {
      const updated = [...stored, ...newDownloaded];
      chrome.storage.local.set({ [storageKey]: updated });
    }
    showToast("일괄 다운로드 완료: " + newDownloaded.length + "/" + filtered.length + "개", true);
  }

  // ─── 일괄 다운로드 버튼 삽입 ───
  function insertBulkDownloadButton() {
    if (document.getElementById("ai-bulk-download-btn")) return;
    // 하단 툴바 영역 찾기 (메시지 입력 주변)
    const toolbar = document.querySelector('.write_menu');
    if (!toolbar) {
      console.log("[AI] 하단 툴바 못 찾음, 0.5초 후 재시도");
      setTimeout(insertBulkDownloadButton, 500);
      return;
    }
    const btn = document.createElement("button");
    btn.id = "ai-bulk-download-btn";
    btn.textContent = "📥";
    btn.title = "자료 일괄 다운로드 (2영업일 이내)";
    Object.assign(btn.style, {
      width: "32px", height: "32px",
      border: "1px solid #d1d5db", borderRadius: "6px",
      background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
      color: "white", fontSize: "16px",
      cursor: "pointer", display: "inline-flex",
      alignItems: "center", justifyContent: "center",
      marginLeft: "6px", verticalAlign: "middle",
      transition: "all 0.2s",
    });
    btn.addEventListener("mouseenter", () => { btn.style.transform = "scale(1.1)"; });
    btn.addEventListener("mouseleave", () => { btn.style.transform = "scale(1)"; });
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.disabled = true;
      btn.style.opacity = "0.5";
      btn.textContent = "⏳";
      bulkDownloadFiles().finally(() => {
        btn.disabled = false;
        btn.style.opacity = "1";
        btn.textContent = "📥";
      });
    });
    toolbar.appendChild(btn);
    console.log("[AI] 일괄 다운로드 버튼 삽입 완료");

    // ─── 거래처 폴더 열기 버튼 ───
    if (!document.getElementById("ai-open-folder-btn")) {
      const folderBtn = document.createElement("button");
      folderBtn.id = "ai-open-folder-btn";
      folderBtn.textContent = "\uD83D\uDCC2";
      folderBtn.title = "거래처 폴더 열기";
      Object.assign(folderBtn.style, {
        width: "32px", height: "32px",
        border: "1px solid #d1d5db", borderRadius: "6px",
        background: "linear-gradient(135deg, #f59e0b, #d97706)",
        color: "white", fontSize: "16px",
        cursor: "pointer", display: "inline-flex",
        alignItems: "center", justifyContent: "center",
        marginLeft: "6px", verticalAlign: "middle",
        transition: "all 0.2s",
      });
      folderBtn.addEventListener("mouseenter", () => { folderBtn.style.transform = "scale(1.1)"; });
      folderBtn.addEventListener("mouseleave", () => { folderBtn.style.transform = "scale(1)"; });
      folderBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const { clientCode } = parseClientInfo();
        if (!clientCode) {
          showToast("거래처 코드를 찾을 수 없습니다.", false);
          return;
        }
        chrome.runtime.sendMessage({ type: "open-client-folder", clientCode }, (res) => {
          if (res && !res.success) showToast(res.error || "폴더 열기 실패", false);
        });
      });
      toolbar.appendChild(folderBtn);
      console.log("[AI] 거래처 폴더 열기 버튼 삽입 완료");
    }
  }

  // ─── MutationObserver ───
  function startObserver() {
    let pendingNodes = [];
    let rafId = null;

    function processPending() {
      const nodes = pendingNodes.slice();
      pendingNodes = [];
      rafId = null;
      // 부모-자식 중복 제거: 부모가 이미 목록에 있으면 자식 스킵
      const filtered = nodes.filter((node, i) => {
        if (node.nodeType !== 1) return false;
        for (let j = 0; j < nodes.length; j++) {
          if (i !== j && nodes[j].nodeType === 1 && nodes[j].contains(node) && nodes[j] !== node) return false;
        }
        return true;
      });
      for (const node of filtered) {
        extractMessages(node);
      }
    }

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const added of m.addedNodes) {
          if (added.id === "ai-sidebar-container") continue;
          if (added.closest && added.closest("#ai-sidebar-container")) continue;
          pendingNodes.push(added);
        }
      }
      if (pendingNodes.length > 0 && !rafId) {
        rafId = requestAnimationFrame(processPending);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    console.log("[AI] Observer 시작");

    // 초기 로드: DB 중복 체크 → 화면 스캔 → DB에 미응답 고객 메시지 있으면 AI 호출
    setTimeout(async () => {
      await initDedupFromDB();
      const dbCount = processedCounts.size;
      console.log("[AI] 초기 스캔 시작 (DB 기존:", dbCount + "건)");
      const insertPromises = extractMessages(document.body);
      if (insertPromises.length > 0) {
        console.log("[AI] DB 삽입 대기 중:", insertPromises.length + "건");
        await Promise.all(insertPromises);
      }
      const newCount = messageLog.length;
      console.log("[AI] 새 메시지:", newCount + "건 (DB에 없던 것만)");

      // ai_feedbacks에서 해당 거래처의 feedback=NULL 행 확인 → 미답변이면 AI 호출
      const { chatId } = parseChatInfo();
      const { clientCode } = parseClientInfo();
      const { data: pendingFb } = await supabase
        .from("ai_feedbacks")
        .select("id")
        .eq("client_code", clientCode || "")
        .eq("chat_id", chatId || "")
        .is("feedback", null)
        .limit(1);
      const hasPending = pendingFb && pendingFb.length > 0;

      // messages 테이블에서도 미응답 고객 메시지 확인
      const unansweredInit = await getUnansweredCustomerMessages(chatId);

      if (unansweredInit.length > 0) {
        if (hasPending) {
          console.log("[AI] 미답변 AI 피드백 존재 + 미응답 고객 메시지:", unansweredInit.length + "건 → AI 재호출 (ai_reply 갱신)");
        } else {
          console.log("[AI] 미응답 고객 메시지 발견:", unansweredInit.length + "건 →", unansweredInit.map(u => u.content).join(" / ").substring(0, 80));
        }
        callOpenAI(unansweredInit.map(u => ({ senderType: "customer", content: u.content, senderName: "" })));
      } else {
        console.log("[AI] 미응답 고객 메시지 없음 → API 스킵");
      }

      // todo/salary의 message_id NULL 백필 (가장 먼저)
      await backfillMessageIds(clientCode);

      // 말풍선 ↔ message ID 매핑 → DB에서 배지 복원
      await linkBubblesToMsgIds(chatId);
      await restoreBadgesFromDB(clientCode);

      // 백그라운드: feedback=NULL인 과거 행에 상담원 답변 매칭 (API 응답과 무관)
      backfillMissingFeedback();

      // 백그라운드: 전체 대화에서 급여 관련 내용 스캔 → salary 테이블에 미저장분 자동 저장
      backfillSalaryFromChat(chatId, clientCode);

      // 파일 다운로드 가로채기 활성화
      setupDownloadInterceptor();

      // 일괄 다운로드 버튼 삽입
      insertBulkDownloadButton();
    }, 2000);
  }

  // ─── 사이드바 삽입 ───
  const container = document.createElement("div");
  container.id = "ai-sidebar-container";

  loadApiKeys().then(async (keysLoaded) => {
    if (!keysLoaded) return;
    // 페이지 로그인 이메일로 현재 직원 감지
    currentEmployeeName = await detectCurrentEmployee();
    // fallback: 매핑 못 찾으면 기존 employeeName 사용
    if (!currentEmployeeName) {
      const stored = await new Promise(r => chrome.storage.local.get("employeeName", r));
      currentEmployeeName = stored.employeeName || "";
    }
    console.log("[AI] 현재 직원:", currentEmployeeName);
    return fetch(chrome.runtime.getURL("sidebar.html")).then((res) => res.text());
  }).then((html) => {
    if (!html) return;
      container.innerHTML = html;
      document.body.appendChild(container);

      const toggleBtn = container.querySelector("#ai-sidebar-toggle");
      const sidebar = container.querySelector("#ai-sidebar");
      sidebar.classList.add("collapsed");
      const toggleText = toggleBtn.querySelector(".ai-toggle-text");
      if (toggleText) toggleText.textContent = "AI";

      toggleBtn.addEventListener("click", () => {
        sidebar.classList.toggle("collapsed");
        const collapsed = sidebar.classList.contains("collapsed");
        if (toggleText) toggleText.textContent = collapsed ? "AI" : "닫기";
        document.body.style.width = collapsed ? "" : "calc(100vw - 300px)";
        document.body.style.overflowX = collapsed ? "" : "hidden";
      });

      const refreshBtn = container.querySelector("#ai-refresh-btn");
      if (refreshBtn) {
        refreshBtn.addEventListener("click", () => forceReanalyze());
      }

      // ─── 템플릿 기능 ───
      async function loadTemplates() {
        const { data, error } = await supabase
          .from("templates")
          .select("id, title, content, created_at")
          .order("created_at", { ascending: false })
          .limit(20);
        if (error) { console.error("[AI] 템플릿 조회 실패:", error.message); return []; }
        return data || [];
      }

      function renderTemplates(templates) {
        const list = container.querySelector("#ai-template-list");
        if (!list) return;
        list.innerHTML = "";
        if (templates.length === 0) {
          list.innerHTML = '<div style="text-align:center;padding:8px;color:#9ca3af;font-size:11px;">저장된 템플릿이 없습니다</div>';
          return;
        }
        templates.forEach((t) => {
          const item = document.createElement("div");
          item.className = "ai-template-item";
          item.innerHTML =
            '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
              '<span class="ai-template-item-title" style="cursor:pointer;flex:1;">' + t.title.replace(/</g, "&lt;") + '</span>' +
              '<button class="ai-template-del-btn" title="삭제" style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:14px;padding:2px 4px;font-weight:bold;transition:color 0.2s;">✕</button>' +
            '</div>' +
            '<div class="ai-template-item-preview" style="font-size:12px;color:#64748b;cursor:pointer;line-height:1.4;word-break:keep-all;">' +
              (t.content.length > 50 ? t.content.substring(0, 50).replace(/</g, "&lt;") + "..." : t.content.replace(/</g, "&lt;")) +
            '</div>';

          // 클릭 → 입력창에 삽입
          item.querySelector(".ai-template-item-title").addEventListener("click", () => insertIntoChatInput(t.content));
          item.querySelector(".ai-template-item-preview").addEventListener("click", () => insertIntoChatInput(t.content));

          // 삭제
          item.querySelector(".ai-template-del-btn").addEventListener("click", async () => {
            await supabase.from("templates").delete().eq("id", t.id);
            renderTemplates(await loadTemplates());
          });

          list.appendChild(item);
        });
      }

      // 템플릿 추가 폼 토글
      const addBtn = container.querySelector("#ai-template-add-btn");
      const form = container.querySelector("#ai-template-form");
      const saveBtn = container.querySelector("#ai-template-save-btn");
      const cancelBtn = container.querySelector("#ai-template-cancel-btn");

      if (addBtn && form) {
        addBtn.addEventListener("click", () => {
          form.style.display = form.style.display === "none" ? "block" : "none";
        });
      }
      if (cancelBtn && form) {
        cancelBtn.addEventListener("click", () => { form.style.display = "none"; });
      }
      if (saveBtn) {
        saveBtn.addEventListener("click", async () => {
          const title = container.querySelector("#ai-template-title").value.trim();
          const content = container.querySelector("#ai-template-content").value.trim();
          if (!title || !content) return;
          await supabase.from("templates").insert({ title, content });
          container.querySelector("#ai-template-title").value = "";
          container.querySelector("#ai-template-content").value = "";
          form.style.display = "none";
          renderTemplates(await loadTemplates());
        });
      }

      // 초기 템플릿 로드 + 전역 갱신 함수
      window._refreshTemplates = async () => {
        renderTemplates(await loadTemplates());
      };
      loadTemplates().then(renderTemplates);

      // ─── 직원 설정 (chrome.storage) ───
      chrome.storage.local.get("employeeName", async (result) => {
        if (!result.employeeName) {
          const name = await showInputPopup("직원 이름 설정", "", "이름을 입력하세요 (To-Do 할당용)");
          if (name) {
            chrome.storage.local.set({ employeeName: name });
          }
        }
      });

      startObserver();
    })
    .catch((err) => console.error("[AI] 로드 실패:", err));

})();
