(function () {
  "use strict";

  // ─── OAuth 콜백 감지 (Google 로그인 후 리다이렉트) ───
  if (window.location.hash && window.location.hash.includes("access_token")) {
    const hashParams = new URLSearchParams(window.location.hash.substring(1));
    const accessToken = hashParams.get("access_token");
    const refreshToken = hashParams.get("refresh_token");
    if (accessToken) {
      chrome.runtime.sendMessage({
        type: "oauth-callback",
        accessToken: accessToken,
        refreshToken: refreshToken || "",
      });
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }

  // 채팅방 안이면 실행하지 않음 (content.js가 담당)
  if (/\/chats\/\d+/.test(location.pathname)) return;
  if (document.getElementById("ai-sidebar-container")) return;

  // ─── Supabase 설정 (chrome.storage에서 로드) ───
  let supabase = null;

  // ─── Supabase 프록시 클라이언트 (background.js 경유) ───
  function createProxyClient() {
    function from(table) {
      let method = "GET", params = [], body = null, isSingle = false, wantReturn = false;
      const b = {
        select(cols) { if (cols) params.push("select=" + encodeURIComponent(cols)); else params.push("select=*"); method = method === "GET" ? "GET" : method; wantReturn = true; return b; },
        eq(col, val) { params.push(encodeURIComponent(col) + "=eq." + encodeURIComponent(val)); return b; },
        neq(col, val) { params.push(encodeURIComponent(col) + "=neq." + encodeURIComponent(val)); return b; },
        gt(col, val) { params.push(encodeURIComponent(col) + "=gt." + encodeURIComponent(val)); return b; },
        gte(col, val) { params.push(encodeURIComponent(col) + "=gte." + encodeURIComponent(val)); return b; },
        lt(col, val) { params.push(encodeURIComponent(col) + "=lt." + encodeURIComponent(val)); return b; },
        lte(col, val) { params.push(encodeURIComponent(col) + "=lte." + encodeURIComponent(val)); return b; },
        is(col, val) { params.push(encodeURIComponent(col) + "=is." + val); return b; },
        in(col, vals) { params.push(encodeURIComponent(col) + "=in.(" + vals.map(v => encodeURIComponent(v)).join(",") + ")"); return b; },
        not(col, op, val) { params.push(encodeURIComponent(col) + "=not." + op + "." + encodeURIComponent(val)); return b; },
        or(expr) { params.push("or=(" + expr + ")"); return b; },
        order(col, opts) { params.push("order=" + encodeURIComponent(col) + "." + (opts && opts.ascending === false ? "desc" : "asc")); return b; },
        limit(n) { params.push("limit=" + n); return b; },
        single() { isSingle = true; return b; },
        insert(data) { method = "POST"; body = data; return b; },
        update(data) { method = "PATCH"; body = data; return b; },
        delete() { method = "DELETE"; return b; },
        upsert(data) { method = "POST"; body = data; return b; },
        then(resolve, reject) {
          chrome.runtime.sendMessage({
            type: "supabase-query",
            table, method, params, body, isSingle, wantReturn,
          }, (res) => {
            if (chrome.runtime.lastError) {
              resolve({ data: null, error: { message: chrome.runtime.lastError.message } });
            } else {
              resolve(res || { data: null, error: { message: "no response" } });
            }
          });
        },
      };
      return b;
    }
    return { from };
  }

  let currentFilter = "all"; // "all" | 직원이름

  // ─── 한국 공휴일 (고정 + 대체) ───
  const FIXED_HOLIDAYS = [
    "01-01", "03-01", "05-05", "06-06", "08-15", "10-03", "10-09", "12-25",
  ];
  function isWeekend(d) { const day = d.getUTCDay(); return day === 0 || day === 6; }
  function isHoliday(d) {
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return FIXED_HOLIDAYS.includes(mm + "-" + dd);
  }
  function isBusinessDay(d) { return !isWeekend(d) && !isHoliday(d); }
  function prevBusinessDay(dateStr) {
    // dateStr: "YYYY-MM-DD" → 해당일이 휴일이면 전 영업일 반환 (UTC로 계산)
    const d = new Date(dateStr + "T00:00:00Z");
    while (!isBusinessDay(d)) {
      d.setUTCDate(d.getUTCDate() - 1);
    }
    return d.toISOString().substring(0, 10);
  }
  function getKSTToday() {
    const now = new Date();
    const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
    return kst.toISOString().substring(0, 10);
  }
  // ─── 커스텀 입력 팝업 ───
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
          <button id="ai-input-popup-ok" style="flex:1;padding:10px 0;border:none;border-radius:10px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:white;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 2px 8px rgba(99,102,241,0.25);">확인</button>
          <button id="ai-input-popup-cancel" style="flex:1;padding:10px 0;border:1px solid rgba(226,232,240,0.8);border-radius:10px;background:rgba(255,255,255,0.85);color:#64748b;font-size:13px;font-weight:600;cursor:pointer;">취소</button>
        </div>
      `;
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      const input = box.querySelector("#ai-input-popup-field");
      input.focus(); input.select();
      input.addEventListener("focus", () => { input.style.borderColor = "#6366f1"; });
      input.addEventListener("blur", () => { input.style.borderColor = "#d1d5db"; });
      const close = (val) => { overlay.remove(); resolve(val); };
      box.querySelector("#ai-input-popup-ok").onclick = () => { close(input.value.trim() || null); };
      box.querySelector("#ai-input-popup-cancel").onclick = () => close(null);
      overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(null); });
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") close(input.value.trim() || null);
        if (ev.key === "Escape") close(null);
      });
    });
  }

  // ─── 달력 팝업 (월간 캘린더 UI) ───
  function showDayPopup(title, currentDay) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "ai-popup-overlay";
      const box = document.createElement("div");
      box.className = "ai-popup-box";
      box.style.width = "300px";
      box.style.padding = "20px";

      const now = new Date();
      const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
      const todayY = kst.getFullYear(), todayM = kst.getMonth(), todayD = kst.getDate();
      let viewY = todayY, viewM = todayM;
      let selectedDate = null;

      // 기존 값이 있으면 선택 상태로
      if (currentDay) {
        selectedDate = { year: todayY, month: todayM + 1, day: parseInt(currentDay) };
      }

      const DAYS = ["일", "월", "화", "수", "목", "금", "토"];

      function render() {
        const firstDay = new Date(viewY, viewM, 1).getDay();
        const lastDate = new Date(viewY, viewM + 1, 0).getDate();
        const monthLabel = `${viewY}년 ${String(viewM + 1).padStart(2, "0")}월`;

        box.innerHTML = `
          <div class="ai-popup-title" style="margin-bottom:12px;">${title}</div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
            <button id="ai-cal-prev" style="border:none;background:none;cursor:pointer;font-size:18px;padding:4px 8px;border-radius:6px;color:#6366f1;font-weight:700;">◀</button>
            <span style="font-size:14px;font-weight:700;color:#6366f1;">${monthLabel}</span>
            <button id="ai-cal-next" style="border:none;background:none;cursor:pointer;font-size:18px;padding:4px 8px;border-radius:6px;color:#6366f1;font-weight:700;">▶</button>
          </div>
          <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;margin-bottom:8px;">
            ${DAYS.map((d, i) => `<div style="text-align:center;font-size:11px;font-weight:600;padding:4px 0;color:${i === 0 ? '#ef4444' : i === 6 ? '#3b82f6' : '#6b7280'};">${d}</div>`).join("")}
          </div>
          <div id="ai-cal-grid" style="display:grid;grid-template-columns:repeat(7,1fr);gap:2px;"></div>
          <div style="display:flex;gap:8px;margin-top:14px;">
            <button id="ai-day-popup-ok" class="ai-btn ai-btn-gradient" style="flex:1;">확인</button>
            <button id="ai-day-popup-cancel" class="ai-btn ai-btn-secondary" style="flex:1;">취소</button>
            <button id="ai-day-popup-clear" class="ai-btn" style="flex:0.6;background:#fee2e2;color:#dc2626;font-size:12px;">삭제</button>
          </div>
        `;

        const grid = box.querySelector("#ai-cal-grid");

        // 빈 셀 (첫째 주 앞)
        for (let i = 0; i < firstDay; i++) {
          const empty = document.createElement("div");
          empty.style.cssText = "width:36px;height:36px;";
          grid.appendChild(empty);
        }

        // 날짜 셀
        for (let d = 1; d <= lastDate; d++) {
          const cell = document.createElement("div");
          const dayOfWeek = (firstDay + d - 1) % 7;
          const isToday = (viewY === todayY && viewM === todayM && d === todayD);
          const isSelected = selectedDate && (viewY === selectedDate.year && (viewM + 1) === selectedDate.month && d === selectedDate.day);

          cell.textContent = d;
          cell.style.cssText = `
            width:36px;height:36px;display:flex;align-items:center;justify-content:center;
            border-radius:50%;font-size:13px;font-weight:600;cursor:pointer;transition:all 0.15s;
            ${isSelected ? 'background:#6366f1;color:white;' : isToday ? 'box-shadow:inset 0 0 0 2px #6366f1;color:#6366f1;' : ''}
            ${!isSelected && dayOfWeek === 0 ? 'color:#ef4444;' : ''}
            ${!isSelected && dayOfWeek === 6 ? 'color:#3b82f6;' : ''}
          `;

          cell.addEventListener("mouseenter", () => {
            if (!isSelected) cell.style.background = "#e0e7ff";
          });
          cell.addEventListener("mouseleave", () => {
            if (!isSelected) cell.style.background = "";
          });
          cell.addEventListener("click", () => {
            selectedDate = { year: viewY, month: viewM + 1, day: d };
            render();
          });

          grid.appendChild(cell);
        }

        // 이벤트 바인딩
        box.querySelector("#ai-cal-prev").onclick = () => { viewM--; if (viewM < 0) { viewM = 11; viewY--; } render(); };
        box.querySelector("#ai-cal-next").onclick = () => { viewM++; if (viewM > 11) { viewM = 0; viewY++; } render(); };

        const close = (val) => { overlay.remove(); resolve(val); };
        box.querySelector("#ai-day-popup-ok").onclick = () => {
          if (!selectedDate) return;
          close(selectedDate);
        };
        box.querySelector("#ai-day-popup-cancel").onclick = () => close(null);
        box.querySelector("#ai-day-popup-clear").onclick = () => close(-1);
        overlay.onclick = (ev) => { if (ev.target === overlay) close(null); };
      }

      overlay.appendChild(box);
      document.body.appendChild(overlay);
      render();
    });
  }

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

  // ─── To-Do 목록 조회 ───
  async function loadTodos() {
    let query = supabase
      .from("todos")
      .select("*")
      .order("sort_order", { ascending: true })
      .limit(50);

    if (currentFilter !== "all") {
      query = query.or("assigned_to.eq." + currentFilter + ",assigned_to.eq.전체");
    }

    const { data, error } = await query;
    if (error) {
      console.error("[AI To-Do] 조회 실패:", error.message || "");
      return [];
    }
    return data || [];
  }

  // ─── To-Do 상태 업데이트 ───
  async function updateTodoStatus(id, newStatus) {
    const { error } = await supabase
      .from("todos")
      .update({ status: newStatus })
      .eq("id", id);

    if (error) {
      console.error("[AI To-Do] 상태 변경 실패:", error.message || "");
    }
  }

  // ─── To-Do 삭제 ───
  async function deleteTodo(id) {
    const { error } = await supabase
      .from("todos")
      .delete()
      .eq("id", id);

    if (error) {
      console.error("[AI To-Do] 삭제 실패:", error.message || "");
    }
  }

  // ─── 담당자 재할당 ───
  async function reassignTodo(id, newName) {
    await supabase.from("todos").update({ assigned_to: newName }).eq("id", id);
  }

  // ─── 순서 저장 (병렬) ───
  async function saveTodoOrder(ids) {
    console.log("[AI To-Do] 순서 저장:", ids.length + "건");
    const results = await Promise.all(
      ids.map((id, i) => supabase.from("todos").update({ sort_order: i }).eq("id", id))
    );
    const errors = results.filter((r) => r.error);
    if (errors.length > 0) {
      console.error("[AI To-Do] 순서 저장 실패:", errors[0].error.message);
    } else {
      console.log("[AI To-Do] 순서 저장 완료");
    }
  }

  // ─── 전체 직원 이름 목록 (To-Do + 반복일정에서 추출) ───
  let knownEmployees = [];
  async function refreshEmployeeList() {
    const [todoRes, recurRes] = await Promise.all([
      supabase.from("todos").select("assigned_to").not("assigned_to", "eq", "").limit(200),
      supabase.from("recurring_todos").select("assigned_to").eq("is_active", true).limit(100),
    ]);
    const names = [
      ...((todoRes.data || []).map(d => d.assigned_to)),
      ...((recurRes.data || []).map(d => d.assigned_to)),
    ].filter(Boolean);
    knownEmployees = [...new Set(names)].filter(n => n !== "전체");
    // chrome.storage에 저장된 이름들 추가 (내 이름 + 직원 목록)
    try {
      const res = await new Promise((r) => chrome.storage.local.get(["employeeName", "employeeList"], r));
      if (res.employeeName && !knownEmployees.includes(res.employeeName)) {
        knownEmployees.unshift(res.employeeName);
      }
      if (Array.isArray(res.employeeList)) {
        for (const n of res.employeeList) {
          if (n && !knownEmployees.includes(n)) knownEmployees.push(n);
        }
      }
    } catch (e) {}
  }

  // ─── 반복 일정 CRUD ───
  async function loadRecurringTodos() {
    const { data, error } = await supabase
      .from("recurring_todos")
      .select("*")
      .eq("is_active", true)
      .order("day_of_month", { ascending: true });
    if (error) { console.error("[AI 반복] 조회 실패:", error.message); return []; }
    return data || [];
  }

  async function createRecurringTodo(dayOfMonth, title, assignedTo) {
    console.log("[AI 반복] 생성 시도:", dayOfMonth + "일", title);
    const { data, error } = await supabase.from("recurring_todos").insert({
      day_of_month: dayOfMonth,
      title: title,
      assigned_to: assignedTo || "",
      holiday_rule: "before",
      is_active: true,
    }).select("id").single();
    if (error) {
      console.error("[AI 반복] 생성 실패:", error.message, error);
      showToast("반복 등록 실패: " + error.message, false);
      return null;
    }
    return data.id;
  }

  async function deleteRecurringTodo(id) {
    await supabase.from("recurring_todos").update({ is_active: false }).eq("id", id);
  }

  // ─── 반복 일정 → 이번 달 To-Do 자동 생성 ───
  async function generateRecurringTodos() {
    const today = getKSTToday(); // "YYYY-MM-DD"
    const yearMonth = today.substring(0, 7); // "YYYY-MM"

    const recurring = await loadRecurringTodos();
    if (recurring.length === 0) return;

    // 이번 달 이미 생성된 반복 todo 확인
    const { data: existingTodos } = await supabase
      .from("todos")
      .select("recurring_id, created_at")
      .not("recurring_id", "is", null)
      .gte("created_at", yearMonth + "-01T00:00:00+09:00")
      .limit(200);
    const createdSet = new Set((existingTodos || []).map(t => String(t.recurring_id)));

    let created = 0;
    for (const r of recurring) {
      if (createdSet.has(String(r.id))) continue;

      // 해당 월의 실행일 계산
      const lastDay = new Date(parseInt(yearMonth.substring(0, 4)), parseInt(yearMonth.substring(5, 7)), 0).getDate();
      const targetDay = Math.min(r.day_of_month, lastDay);
      const targetDate = yearMonth + "-" + String(targetDay).padStart(2, "0");
      const actualDate = prevBusinessDay(targetDate); // 휴일→전 영업일

      // 아직 실행일이 안 됐으면 스킵 (단, 당월 1일 이후에만 체크)
      // 매월 초 생성이므로 오늘이 해당월이면 무조건 생성
      const { error } = await supabase.from("todos").insert({
        content: r.title,
        status: "pending",
        assigned_to: r.assigned_to || "",
        recurring_id: r.id,
        recurring_date: actualDate,
      });
      if (!error) created++;
    }
    if (created > 0) {
      console.log("[AI 반복] 이번 달 반복 To-Do", created + "건 생성");
    }
  }

  // ─── 반복 설정 팝업 (To-Do 카드 클릭 시) ───
  function showRecurringPopup(todo) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      Object.assign(overlay.style, {
        position: "fixed", top: "0", left: "0", width: "100%", height: "100%",
        background: "rgba(0,0,0,0.3)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)",
        zIndex: "9999999", display: "flex", alignItems: "center", justifyContent: "center",
      });
      const box = document.createElement("div");
      Object.assign(box.style, {
        width: "300px", padding: "24px",
        background: "rgba(255,255,255,0.97)",
        backdropFilter: "blur(16px)", WebkitBackdropFilter: "blur(16px)",
        borderRadius: "16px",
        boxShadow: "0 12px 40px rgba(99,102,241,0.18), 0 4px 12px rgba(0,0,0,0.08)",
        border: "1px solid rgba(226,232,240,0.8)",
        fontFamily: "'Pretendard', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      });

      // 날짜 옵션 생성 (1~31, 31=말일)
      let dayOptions = "";
      for (let i = 1; i <= 31; i++) {
        dayOptions += '<option value="' + i + '">' + (i === 31 ? "말일" : i + "일") + '</option>';
      }

      box.innerHTML = `
        <div style="font-size:14px;font-weight:700;color:#0f172a;margin-bottom:6px;">매월 반복 설정</div>
        <div style="font-size:11px;color:#64748b;margin-bottom:16px;line-height:1.4;background:#f1f5f9;padding:8px 10px;border-radius:8px;">${(todo.content || "").substring(0, 60)}</div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;">
          <span style="font-size:13px;font-weight:600;color:#334155;white-space:nowrap;">매월</span>
          <select id="ai-recurring-day" style="flex:1;padding:8px 10px;border:1.5px solid #d1d5db;border-radius:10px;font-size:13px;background:#f8fafc;outline:none;">
            ${dayOptions}
          </select>
        </div>
        <div style="font-size:10px;color:#9ca3af;margin-bottom:16px;">* 휴일인 경우 전 영업일에 자동 생성됩니다</div>
        <div style="display:flex;gap:8px;">
          <button id="ai-recurring-save" style="flex:1;padding:10px 0;border:none;border-radius:10px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:white;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 2px 8px rgba(99,102,241,0.25);">반복 등록</button>
          <button id="ai-recurring-cancel" style="flex:1;padding:10px 0;border:1px solid rgba(226,232,240,0.8);border-radius:10px;background:rgba(255,255,255,0.85);color:#64748b;font-size:13px;font-weight:600;cursor:pointer;">취소</button>
        </div>
      `;
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      const close = (val) => { overlay.remove(); resolve(val); };
      box.querySelector("#ai-recurring-save").onclick = () => {
        const day = parseInt(box.querySelector("#ai-recurring-day").value);
        close(day); // 31 = 말일
      };
      box.querySelector("#ai-recurring-cancel").onclick = () => close(null);
      overlay.addEventListener("click", (ev) => { if (ev.target === overlay) close(null); });
    });
  }

  // ─── 반복 일정 목록 렌더링 ───
  async function renderRecurringList() {
    const listEl = document.getElementById("ai-recurring-list");
    if (!listEl) return;
    const recurring = await loadRecurringTodos();
    listEl.innerHTML = "";

    if (recurring.length === 0) {
      listEl.innerHTML = '<div style="text-align:center;padding:10px;color:#9ca3af;font-size:11px;">등록된 반복 일정이 없습니다</div>';
      return;
    }


    const today = getKSTToday();
    const yearMonth = today.substring(0, 7);

    // 이번 달 반복 todo 상태 조회
    const { data: monthTodos } = await supabase
      .from("todos")
      .select("recurring_id, status")
      .not("recurring_id", "is", null)
      .gte("created_at", yearMonth + "-01T00:00:00+09:00")
      .limit(100);
    const todoStatusMap = {};
    (monthTodos || []).forEach(t => { todoStatusMap[t.recurring_id] = t.status; });

    // 반복 일정 헤더 집계 업데이트 (접혀있어도 보임)
    const statsEl = document.getElementById("ai-recurring-stats");
    if (statsEl) {
      const recDone = recurring.filter(r => todoStatusMap[r.id] === "completed").length;
      const recPending = recurring.filter(r => todoStatusMap[r.id] !== "completed").length;
      statsEl.textContent = "(" + recPending + "건 미완료 / " + recDone + "건 완료)";
    }

    // 담당자 필터 적용
    const filtered = currentFilter === "all" ? recurring : recurring.filter(r => r.assigned_to === currentFilter || r.assigned_to === "전체");

    if (filtered.length === 0) {
      listEl.innerHTML = '<div style="text-align:center;padding:10px;color:#9ca3af;font-size:11px;">' +
        (recurring.length === 0 ? '등록된 반복 일정이 없습니다' : '해당 담당자의 반복 일정이 없습니다') + '</div>';
      return;
    }

    // 미완료 먼저, 완료는 아래로
    filtered.sort((a, b) => {
      const aDone = todoStatusMap[a.id] === "completed" ? 1 : 0;
      const bDone = todoStatusMap[b.id] === "completed" ? 1 : 0;
      return aDone - bDone;
    });

    filtered.forEach((r) => {
      const item = document.createElement("div");
      item.className = "ai-card";
      item.draggable = true;
      item.dataset.recurringId = r.id;

      // 해당 월의 실행일 계산
      const lastDay = new Date(parseInt(yearMonth.substring(0, 4)), parseInt(yearMonth.substring(5, 7)), 0).getDate();
      const targetDay = Math.min(r.day_of_month, lastDay);
      const targetDate = yearMonth + "-" + String(targetDay).padStart(2, "0");
      const actualDate = prevBusinessDay(targetDate);
      const isToday = actualDate === today;
      const isDone = todoStatusMap[r.id] === "completed";
      const dayLabel = r.day_of_month === 31 ? "말일" : r.day_of_month + "일";
      const assigneeOptions = '<option value=""' + (!r.assigned_to ? ' selected' : '') + '>미지정</option>' +
        '<option value="전체"' + (r.assigned_to === "전체" ? ' selected' : '') + '>전체</option>' +
        knownEmployees.map(n => '<option value="' + n.replace(/"/g, '&quot;') + '"' + (r.assigned_to === n ? ' selected' : '') + '>' + n.replace(/</g, '&lt;') + '</option>').join('');

      // 2줄 레이아웃: 1줄=체크+제목+삭제, 2줄=거래처+일자+담당자
      item.innerHTML =
        '<div class="ai-todo-row">' +
          '<input type="checkbox" ' + (isDone ? "checked" : "") + ' class="ai-recurring-check ai-checkbox"' +
            (!todoStatusMap[r.id] ? ' disabled title="이번 달 미생성"' : '') + ' />' +
          '<span class="ai-recurring-title ai-content-editable" style="' + (isDone ? "text-decoration:line-through;color:#9ca3af;" : "") + '">' + (r.title || "").replace(/</g, "&lt;") + '</span>' +
          '<button class="ai-recurring-del ai-delete-btn" title="삭제">✕</button>' +
        '</div>' +
        '<div class="ai-todo-meta-row">' +
          '<span class="ai-client-tag ai-recurring-client' + (r.client_name ? '' : ' ai-client-tag-empty') + '" title="거래처: ' + (r.client_name || "미지정").replace(/"/g, '&quot;') + '">' + (r.client_name ? r.client_name.replace(/</g, "&lt;").substring(0, 8) : '거래처') + '</span>' +
          '<span class="ai-day-chip' + (isToday ? ' ai-day-chip-fire' : '') + '" title="클릭하여 날짜 변경">' + dayLabel + '</span>' +
          '<select class="ai-recurring-assignee ai-assignee-chip">' + assigneeOptions + '</select>' +
        '</div>';

      // 체크박스 → 이번 달 해당 todo 상태 변경
      item.querySelector(".ai-recurring-check").addEventListener("change", async (e) => {
        const newStatus = e.target.checked ? "completed" : "pending";
        await supabase.from("todos").update({ status: newStatus })
          .eq("recurring_id", r.id)
          .gte("created_at", yearMonth + "-01T00:00:00+09:00");
        renderRecurringList();
        renderTodos(await loadTodos());
      });

      item.querySelector(".ai-recurring-del").onclick = async () => {
        await deleteRecurringTodo(r.id);
        renderRecurringList();
        showToast("반복 일정 삭제됨", true);
      };

      // 담당자 변경
      item.querySelector(".ai-recurring-assignee").addEventListener("change", async (e) => {
        const newName = e.target.value;
        await supabase.from("recurring_todos").update({ assigned_to: newName }).eq("id", r.id);
        await supabase.from("todos").update({ assigned_to: newName })
          .eq("recurring_id", r.id)
          .gte("created_at", yearMonth + "-01T00:00:00+09:00");
        await refreshEmployeeList();
        renderRecurringList();
        renderTodos(await loadTodos());
      });

      // 거래처 클릭 → 팝업 변경
      item.querySelector(".ai-recurring-client").addEventListener("click", async (e) => {
        e.stopPropagation();
        const newName = await showInputPopup("거래처명 변경", r.client_name || "", "거래처명");
        if (newName !== null) {
          await supabase.from("recurring_todos").update({ client_name: newName }).eq("id", r.id);
          renderRecurringList();
        }
      });

      // 일자 클릭 → 달력 팝업
      item.querySelector(".ai-day-chip").addEventListener("click", async (e) => {
        e.stopPropagation();
        const result = await showDayPopup("반복 일자 변경", r.day_of_month);
        if (result === null || result === -1) return;
        const newDay = result.day;
        if (newDay !== r.day_of_month) {
          await supabase.from("recurring_todos").update({ day_of_month: newDay }).eq("id", r.id);
          const todayStr = getKSTToday();
          const ym = todayStr.substring(0, 7);
          const ld = new Date(parseInt(ym.substring(0, 4)), parseInt(ym.substring(5, 7)), 0).getDate();
          const td = Math.min(newDay, ld);
          const tDate = ym + "-" + String(td).padStart(2, "0");
          const aDate = prevBusinessDay(tDate);
          await supabase.from("todos").update({ recurring_date: aDate })
            .eq("recurring_id", r.id)
            .gte("created_at", ym + "-01T00:00:00+09:00");
          showToast((newDay === 31 ? "말일" : newDay + "일") + "로 변경됨", true);
        }
        renderRecurringList();
      });

      // 더블클릭 → 제목 팝업 편집
      item.querySelector(".ai-recurring-title").addEventListener("dblclick", async (e) => {
        e.stopPropagation();
        const newTitle = await showInputPopup("제목 수정", r.title || "", "반복 일정 제목");
        if (newTitle !== null && newTitle !== r.title) {
          await supabase.from("recurring_todos").update({ title: newTitle }).eq("id", r.id);
          await supabase.from("todos").update({ content: newTitle }).eq("recurring_id", r.id);
          showToast("수정됨", true);
          renderRecurringList();
          renderTodos(await loadTodos());
        }
      });

      // 드래그 → 일반 할일로 변환용
      item.addEventListener("dragstart", (e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", "recurring:" + r.id);
        requestAnimationFrame(() => item.classList.add("ai-dragging"));
      });
      item.addEventListener("dragend", () => {
        item.classList.remove("ai-dragging");
      });

      listEl.appendChild(item);
    });
  }

  // ─── 사이드바에 To-Do 렌더링 ───
  function renderTodos(todos) {
    const list = document.getElementById("ai-recommendations");
    if (!list) return;
    list.innerHTML = "";

    // 반복 등록된 todo는 일반 목록에서 제외 (반복 일정 섹션에서 표시)
    const filtered = todos.filter((t) => !t.recurring_id);

    const status = document.getElementById("ai-status");

    const pending = filtered.filter((t) => t.status === "pending");
    const completed = filtered.filter((t) => t.status === "completed");

    if (status) {
      status.textContent = "미완료: " + pending.length + "건 / 완료: " + completed.length + "건";
      status.style.background = "#eef2ff";
      status.style.color = "#3730a3";
      status.style.borderColor = "#c7d2fe";
    }

    if (filtered.length === 0) {
      list.innerHTML = '<div style="text-align:center;padding:20px;color:#999;font-size:13px;">등록된 할 일이 없습니다.</div>';
      return;
    }

    const today = getKSTToday();

    // 정렬: 완료 맨 아래, 미완료는 due_date 그룹별
    // 그룹 0: due_date < 오늘 (지난 기한, 가장 위)
    // 그룹 1: due_date = 오늘
    // 그룹 2: due_date = NULL (기한 없음)
    // 그룹 3: due_date > 오늘 (미래)
    // 그룹 4: 완료 (맨 아래)
    function dueDateGroup(t) {
      if (t.status === "completed") return 4;
      if (!t.due_date) return 2;
      const dd = t.due_date.substring(0, 10); // normalize to YYYY-MM-DD
      if (dd === today) return 1;
      if (dd < today) return 0;
      return 3;
    }
    const sorted = [...pending, ...completed].sort((a, b) => {
      const ga = dueDateGroup(a), gb = dueDateGroup(b);
      if (ga !== gb) return ga - gb;
      return (a.sort_order ?? 0) - (b.sort_order ?? 0);
    });

    // 담당자 필터 드롭다운 업데이트
    const filterSelect = document.getElementById("ai-employee-filter");
    if (filterSelect) {
      const prevValue = filterSelect.value;
      filterSelect.innerHTML = '<option value="all">전체</option>';
      knownEmployees.forEach((name) => {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        filterSelect.appendChild(opt);
      });
      filterSelect.value = (prevValue && prevValue !== "all") ? prevValue : (currentFilter !== "all" ? currentFilter : "all");
    }

    sorted.forEach((todo) => {
      const card = document.createElement("div");
      card.className = "ai-card";
      card.draggable = true;
      card.dataset.todoId = todo.id;
      card.dataset.todoStatus = todo.status;
      const isDone = todo.status === "completed";
      const dueDate = todo.due_date ? todo.due_date.substring(0, 10) : null;
      const isDueToday = dueDate === today;
      const dueDay = dueDate ? parseInt(dueDate.substring(8, 10)) : null;
      const dueDayLabel = dueDay ? dueDay + "일" : "기한";

      const assigneeOptions = '<option value=""' + (!todo.assigned_to ? ' selected' : '') + '>미지정</option>' +
        '<option value="전체"' + (todo.assigned_to === "전체" ? ' selected' : '') + '>전체</option>' +
        knownEmployees.map((n) => '<option value="' + n.replace(/"/g, "&quot;") + '"' + (todo.assigned_to === n ? ' selected' : '') + '>' + n.replace(/</g, "&lt;") + '</option>').join('');

      card.innerHTML =
        '<div class="ai-todo-row">' +
          '<input type="checkbox" class="ai-checkbox" ' + (isDone ? "checked" : "") + ' />' +
          '<span class="ai-todo-content ai-content-editable" ' +
            (isDone ? 'style="text-decoration:line-through;color:#9ca3af;"' : '') + '>' +
            todo.content.replace(/</g, "&lt;") +
          '</span>' +
          '<button class="ai-todo-delete ai-delete-btn" title="삭제">✕</button>' +
        '</div>' +
        '<div class="ai-todo-meta-row">' +
          '<span class="ai-client-tag' + (todo.client_name ? '' : ' ai-client-tag-empty') + '" title="거래처: ' + (todo.client_name || "미지정").replace(/"/g, '&quot;') + '">' + (todo.client_name ? todo.client_name.replace(/</g, "&lt;").substring(0, 8) : '거래처') + '</span>' +
          '<span class="ai-day-chip' + (isDueToday ? ' ai-day-chip-fire' : '') + (dueDay ? '' : ' ai-day-chip-empty') + '" title="기한 설정">' + dueDayLabel + '</span>' +
          '<select class="ai-todo-assignee-select ai-assignee-chip">' + assigneeOptions + '</select>' +
        '</div>';

      // 체크박스
      card.querySelector("input[type=checkbox]").addEventListener("change", async (e) => {
        await updateTodoStatus(todo.id, e.target.checked ? "completed" : "pending");
        renderTodos(await loadTodos());
      });

      // 삭제
      card.querySelector(".ai-todo-delete").addEventListener("click", async () => {
        await deleteTodo(todo.id);
        renderTodos(await loadTodos());
      });

      // 더블클릭 → 내용 팝업 편집
      card.querySelector(".ai-todo-content").addEventListener("dblclick", async (e) => {
        e.stopPropagation();
        const newContent = await showInputPopup("내용 수정", todo.content || "", "할 일 내용");
        if (newContent !== null && newContent !== todo.content) {
          await supabase.from("todos").update({ content: newContent }).eq("id", todo.id);
          showToast("수정됨", true);
          renderTodos(await loadTodos());
        }
      });

      // 거래처 클릭 → 팝업 변경
      card.querySelector(".ai-client-tag").addEventListener("click", async (e) => {
        e.stopPropagation();
        const newName = await showInputPopup("거래처명 변경", todo.client_name || "", "거래처명");
        if (newName !== null) {
          await supabase.from("todos").update({ client_name: newName }).eq("id", todo.id);
          renderTodos(await loadTodos());
        }
      });

      // 기한 클릭 → 달력 팝업
      card.querySelector(".ai-day-chip").addEventListener("click", async (e) => {
        e.stopPropagation();
        const result = await showDayPopup("기한 설정", dueDay || "");
        if (result === null) return; // 취소
        if (result === -1) {
          // 삭제
          await supabase.from("todos").update({ due_date: null }).eq("id", todo.id);
        } else {
          const yyyy = result.year;
          const mm = String(result.month).padStart(2, "0");
          const dd = String(result.day).padStart(2, "0");
          await supabase.from("todos").update({ due_date: yyyy + "-" + mm + "-" + dd }).eq("id", todo.id);
        }
        renderTodos(await loadTodos());
      });

      // 담당자 드롭다운 변경
      card.querySelector(".ai-todo-assignee-select").addEventListener("change", async (e) => {
        await reassignTodo(todo.id, e.target.value);
        await refreshEmployeeList();
        renderTodos(await loadTodos());
      });

      // ─── 드래그 앤 드롭 ───
      card.draggable = true;

      card.addEventListener("dragstart", (e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", "todo:" + todo.id);
        requestAnimationFrame(() => card.classList.add("ai-dragging"));
      });
      card.addEventListener("dragend", () => {
        card.classList.remove("ai-dragging");
        list.querySelectorAll(".ai-drag-over").forEach((el) => el.classList.remove("ai-drag-over"));
      });
      card.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        list.querySelectorAll(".ai-drag-over").forEach((el) => el.classList.remove("ai-drag-over"));
        card.classList.add("ai-drag-over");
      });
      card.addEventListener("dragleave", (e) => {
        if (!card.contains(e.relatedTarget)) {
          card.classList.remove("ai-drag-over");
        }
      });
      card.addEventListener("drop", async (e) => {
        e.preventDefault();
        card.classList.remove("ai-drag-over");
        const raw = e.dataTransfer.getData("text/plain");
        if (!raw.startsWith("todo:")) return; // 반복→todo는 상위 핸들러에서 처리
        const draggedId = raw.replace("todo:", "");
        if (draggedId === String(todo.id)) return;

        const draggedCard = list.querySelector('[data-todo-id="' + draggedId + '"]');
        if (!draggedCard) return;
        const rect = card.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (e.clientY < midY) {
          list.insertBefore(draggedCard, card);
        } else {
          list.insertBefore(draggedCard, card.nextSibling);
        }

        const newIds = [...list.querySelectorAll(".ai-card")].map((c) => c.dataset.todoId);
        await saveTodoOrder(newIds);
      });

      list.appendChild(card);
    });

    // 리스트 컨테이너 드롭 핸들러 (카드 사이 빈 공간 + 첫 번째 카드 위)
    list.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    list.addEventListener("drop", async (e) => {
      e.preventDefault();
      const raw = e.dataTransfer.getData("text/plain");
      if (!raw.startsWith("todo:")) return;
      const draggedId = raw.replace("todo:", "");
      const draggedCard = list.querySelector('[data-todo-id="' + draggedId + '"]');
      if (!draggedCard) return;

      // 드롭 위치의 가장 가까운 카드 찾기
      const cards = [...list.querySelectorAll(".ai-card:not(.ai-dragging)")];
      let target = null;
      for (const c of cards) {
        const rect = c.getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) {
          target = c;
          break;
        }
      }
      if (target) {
        list.insertBefore(draggedCard, target);
      } else {
        list.appendChild(draggedCard);
      }

      const newIds = [...list.querySelectorAll(".ai-card")].map((c) => c.dataset.todoId);
      await saveTodoOrder(newIds);
    });
  }

  // ─── 사이드바 UI 삽입 ───
  const container = document.createElement("div");
  container.id = "ai-sidebar-container";

  const sidebarURL = chrome.runtime.getURL("sidebar-list.html");

  (async function loadConfig() {
    // 1) 인증 기반 설정 로딩
    try {
      const authConfig = await new Promise((r) => chrome.runtime.sendMessage({ type: "get-auth-config" }, r));
      if (authConfig && authConfig.authenticated && authConfig.supabaseUrl) {
        supabase = createProxyClient();
        if (authConfig.employeeMap) {
          chrome.storage.local.set({ employeeMap: authConfig.employeeMap });
        }
        return true;
      }
    } catch (e) { /* fallback */ }
    // 2) fallback: 수동 입력 값
    return new Promise((resolve) => {
      chrome.storage.local.get(["supabaseUrl", "supabaseKey"], (result) => {
        if (!result.supabaseUrl || !result.supabaseKey) {
          showToast("로그인이 필요합니다. 채팅 페이지에서 로그인해주세요.", false);
          resolve(false);
          return;
        }
        supabase = createProxyClient();
        resolve(true);
      });
    });
  })().then((ok) => {
    if (!ok) return;
    return fetch(sidebarURL).then((res) => res.text());
  }).then(async (html) => {
    if (!html) return;
      container.innerHTML = html;
      document.body.appendChild(container);

      const toggleBtn = container.querySelector("#ai-sidebar-toggle");
      const sidebar = container.querySelector("#ai-sidebar");

      sidebar.classList.remove("collapsed");
      const toggleText = toggleBtn.querySelector(".ai-toggle-text");
      if (toggleText) toggleText.textContent = "닫기";

      // 버전 표시
      const vBadge = container.querySelector("#ai-version-badge");
      if (vBadge) {
        const ver = chrome.runtime.getManifest().version;
        vBadge.textContent = "v" + ver;
      }

      // ─── 직원 필터 ───
      const filterSelect = container.querySelector("#ai-employee-filter");
      const settingBtn = container.querySelector("#ai-employee-setting");

      if (filterSelect) {
        filterSelect.addEventListener("change", async () => {
          currentFilter = filterSelect.value;
          renderTodos(await loadTodos());
          renderRecurringList();
        });
      }

      // 현재 직원 이름 표시
      function updateSettingBtn(name) {
        if (settingBtn) {
          settingBtn.textContent = name ? name : "이름 설정";
          settingBtn.title = name ? "현재: " + name + " (클릭하여 변경)" : "직원 이름을 설정해주세요";
        }
      }

      chrome.storage.local.get("employeeName", (res) => {
        updateSettingBtn(res.employeeName || "");
      });

      if (settingBtn) {
        settingBtn.addEventListener("click", async () => {
          const current = await new Promise(r => chrome.storage.local.get(["employeeName", "employeeList"], r));
          const currentList = Array.isArray(current.employeeList) ? current.employeeList : [];
          const currentStr = currentList.length > 0 ? currentList.join(", ") : (current.employeeName || "");
          const input = await showInputPopup("직원 목록 설정", currentStr, "쉼표로 구분 (예: 정정교, 강문정)");
          if (input !== null) {
            const names = input.split(",").map(n => n.trim()).filter(Boolean);
            const myName = names[0] || "";
            chrome.storage.local.set({ employeeName: myName, employeeList: names });
            updateSettingBtn(myName);
            await refreshEmployeeList();
            renderTodos(await loadTodos());
            renderRecurringList();
            showToast("직원 목록: " + names.join(", "), true);
          }
        });
      }

      // ─── To-Do 직접 입력 ───
      const todoInput = container.querySelector("#ai-todo-input");
      const todoAddBtn = container.querySelector("#ai-todo-add-btn");

      async function addTodoFromInput() {
        const text = todoInput.value.trim();
        if (!text) return;
        todoInput.value = "";
        const empName = await new Promise(r => chrome.storage.local.get("employeeName", r)).then(r => r.employeeName || "");
        const { error } = await supabase.from("todos").insert({
          content: text, status: "pending", assigned_to: empName,
        });
        if (error) {
          showToast("추가 실패: " + error.message, false);
        } else {
          showToast("할 일 추가됨", true);
          renderTodos(await loadTodos());
        }
      }

      if (todoAddBtn) todoAddBtn.addEventListener("click", addTodoFromInput);
      if (todoInput) {
        todoInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addTodoFromInput(); });
        todoInput.addEventListener("focus", () => { todoInput.style.borderColor = "#6366f1"; });
        todoInput.addEventListener("blur", () => { todoInput.style.borderColor = "#d1d5db"; });
      }

      // ─── 반복 일정 토글 ───
      const recurringToggle = container.querySelector("#ai-recurring-toggle");
      const recurringList = container.querySelector("#ai-recurring-list");
      const recurringArrow = container.querySelector("#ai-recurring-arrow");
      if (recurringToggle && recurringList) {
        recurringToggle.addEventListener("click", () => {
          const hidden = recurringList.style.display === "none";
          recurringList.style.display = hidden ? "flex" : "none";
          if (recurringArrow) recurringArrow.style.transform = hidden ? "rotate(180deg)" : "";
          if (hidden) renderRecurringList();
        });
      }

      // ─── 반복 일정 섹션을 드롭 존으로 (todo → 반복) ───
      const recurringSection = container.querySelector("#ai-recurring-section");
      if (recurringSection) {
        recurringSection.addEventListener("dragover", (e) => {
          const data = e.dataTransfer.types.includes("text/plain");
          if (!data) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          recurringSection.classList.add("ai-recurring-drag-over");
        });
        recurringSection.addEventListener("dragleave", (e) => {
          if (!recurringSection.contains(e.relatedTarget)) {
            recurringSection.classList.remove("ai-recurring-drag-over");
          }
        });
        recurringSection.addEventListener("drop", async (e) => {
          e.preventDefault();
          recurringSection.classList.remove("ai-recurring-drag-over");
          const raw = e.dataTransfer.getData("text/plain");
          if (raw.startsWith("recurring:")) return; // 반복→반복 무시
          if (!raw.startsWith("todo:")) return;

          const todoId = raw.replace("todo:", "");
          // todo 정보 조회
          const { data: todoData } = await supabase.from("todos").select("*").eq("id", todoId).single();
          if (!todoData) return;

          // 날짜 선택 팝업
          const day = await showRecurringPopup(todoData);
          if (!day) return;

          const recurringId = await createRecurringTodo(day, todoData.content, todoData.assigned_to);
          if (recurringId) {
            const today = getKSTToday();
            const yearMonth = today.substring(0, 7);
            const lastDay = new Date(parseInt(yearMonth.substring(0, 4)), parseInt(yearMonth.substring(5, 7)), 0).getDate();
            const targetDay = Math.min(day, lastDay);
            const targetDate = yearMonth + "-" + String(targetDay).padStart(2, "0");
            const actualDate = prevBusinessDay(targetDate);
            await supabase.from("todos").update({
              recurring_id: recurringId,
              recurring_date: actualDate,
            }).eq("id", todoId);
            const dayLabel = day === 31 ? "말일" : day + "일";
            showToast("매월 " + dayLabel + " 반복 등록됨", true);
            // 반복 목록 열기
            if (recurringList) recurringList.style.display = "flex";
            if (recurringArrow) recurringArrow.style.transform = "rotate(180deg)";
            renderRecurringList();
            renderTodos(await loadTodos());
          }
        });
      }

      // ─── 할일 목록을 드롭 존으로 (반복 → 일반 todo) ───
      const todoList = container.querySelector("#ai-recommendations");
      if (todoList) {
        todoList.addEventListener("dragover", (e) => {
          const raw = e.dataTransfer.types.includes("text/plain");
          if (!raw) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        });
        todoList.addEventListener("drop", async (e) => {
          const raw = e.dataTransfer.getData("text/plain");
          if (!raw.startsWith("recurring:")) return; // todo→todo는 기존 핸들러에서 처리
          e.preventDefault();
          e.stopPropagation();

          const recurringId = raw.replace("recurring:", "");
          // 반복 일정 정보 조회
          const { data: recData } = await supabase.from("recurring_todos").select("*").eq("id", recurringId).single();
          if (!recData) return;

          // 반복에 연결된 이번 달 todo의 recurring_id 해제
          const today = getKSTToday();
          const yearMonth = today.substring(0, 7);
          await supabase.from("todos").update({ recurring_id: null, recurring_date: null })
            .eq("recurring_id", recurringId)
            .gte("created_at", yearMonth + "-01T00:00:00+09:00");

          // 반복 일정 비활성화
          await deleteRecurringTodo(recurringId);

          showToast("반복 해제 → 일반 할일로 변환", true);
          renderRecurringList();
          renderTodos(await loadTodos());
        });
      }

      // 기본 필터: 자기 이름으로 설정 (refreshEmployeeList보다 먼저 설정해야 select UI에 반영됨)
      const myNameRes = await new Promise(r => chrome.storage.local.get("employeeName", r));
      if (myNameRes.employeeName) {
        currentFilter = myNameRes.employeeName;
      }

      await refreshEmployeeList();

      // select UI에도 반영
      if (myNameRes.employeeName && filterSelect) {
        filterSelect.value = myNameRes.employeeName;
      }

      // 신규 직원: employeeName 미설정 시 DB 기반 선택 팝업
      const stored = await new Promise(r => chrome.storage.local.get("employeeName", r));
      if (!stored.employeeName && knownEmployees.length > 0) {
        const overlay = document.createElement("div");
        overlay.id = "ai-employee-select-popup";
        Object.assign(overlay.style, {
          position: "fixed", top: "0", left: "0", width: "100%", height: "100%",
          background: "rgba(0,0,0,0.3)", backdropFilter: "blur(4px)", WebkitBackdropFilter: "blur(4px)",
          zIndex: "9999999", display: "flex", alignItems: "center", justifyContent: "center",
        });
        const box = document.createElement("div");
        Object.assign(box.style, {
          background: "#fff", borderRadius: "16px", padding: "0", minWidth: "260px",
          boxShadow: "0 16px 40px rgba(0,0,0,0.15)", overflow: "hidden",
        });
        const header = document.createElement("div");
        Object.assign(header.style, {
          background: "linear-gradient(135deg, #6366f1, #8b5cf6)", color: "#fff",
          padding: "14px 20px", fontSize: "15px", fontWeight: "700", textAlign: "center",
        });
        header.textContent = "본인 이름을 선택하세요";
        box.appendChild(header);
        const btnWrap = document.createElement("div");
        Object.assign(btnWrap.style, { padding: "16px 20px", display: "flex", flexDirection: "column", gap: "10px" });
        const selectPromise = new Promise(resolve => {
          knownEmployees.forEach(name => {
            const btn = document.createElement("button");
            btn.textContent = name;
            Object.assign(btn.style, {
              padding: "12px", border: "1px solid #e0e7ff", borderRadius: "10px",
              background: "#f8fafc", fontSize: "14px", fontWeight: "600", color: "#4f46e5",
              cursor: "pointer", transition: "all 0.2s",
            });
            btn.addEventListener("mouseenter", () => { btn.style.background = "#6366f1"; btn.style.color = "#fff"; });
            btn.addEventListener("mouseleave", () => { btn.style.background = "#f8fafc"; btn.style.color = "#4f46e5"; });
            btn.addEventListener("click", () => resolve(name));
            btnWrap.appendChild(btn);
          });
        });
        box.appendChild(btnWrap);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        const selectedName = await selectPromise;
        overlay.remove();
        chrome.storage.local.set({ employeeName: selectedName });
        if (typeof updateSettingBtn === "function") updateSettingBtn(selectedName);
        currentFilter = selectedName;
        if (filterSelect) filterSelect.value = selectedName;
        showToast("'" + selectedName + "' (으)로 설정됨", true);
      }

      // 반복 todo 자동 생성 (매월 초)
      await generateRecurringTodos();

      // 초기 로드 — sort_order가 전부 0이면 자동 순번 부여
      const initTodos = await loadTodos();
      const allZero = initTodos.length > 1 && initTodos.every((t) => (t.sort_order ?? 0) === 0);
      if (allZero) {
        await saveTodoOrder(initTodos.map((t) => t.id));
        const refreshed = await loadTodos();
        renderTodos(refreshed);
      } else {
        renderTodos(initTodos);
      }

      // 반복 일정 헤더 집계 표시 (접혀있어도 보이도록 초기 로드)
      renderRecurringList();

      // 버전 체크 (접속 시 1회) — remote > local 일 때만
      function isNewerVersion(remote, local) {
        const r = remote.split(".").map(Number), l = local.split(".").map(Number);
        for (let i = 0; i < Math.max(r.length, l.length); i++) {
          if ((r[i] || 0) > (l[i] || 0)) return true;
          if ((r[i] || 0) < (l[i] || 0)) return false;
        }
        return false;
      }
      try {
        const { data: verData } = await supabase.from("settings").select("value").eq("key", "app_version").single();
        if (verData && isNewerVersion(verData.value, chrome.runtime.getManifest().version)) {
          const toast = document.createElement("div");
          toast.innerHTML = '🔄 새 버전 <b>v' + verData.value + '</b> 사용 가능 — <u>클릭하여 새로고침</u>';
          Object.assign(toast.style, {
            position: "fixed", bottom: "30px", left: "50%", transform: "translateX(-50%)",
            padding: "12px 24px", borderRadius: "10px", fontSize: "13px", fontWeight: "600", zIndex: "999999",
            color: "white", background: "linear-gradient(135deg,#6366f1,#8b5cf6)",
            boxShadow: "0 4px 16px rgba(99,102,241,0.35)", cursor: "pointer",
          });
          toast.addEventListener("click", () => {
            toast.innerHTML = '⏳ 업데이트 중...';
            toast.style.pointerEvents = 'none';
            chrome.runtime.sendMessage({ type: "trigger-update" });
          });
          document.body.appendChild(toast);
        }
      } catch (e) {}

      toggleBtn.addEventListener("click", async () => {
        sidebar.classList.toggle("collapsed");
        const isCollapsed = sidebar.classList.contains("collapsed");
        if (toggleText) toggleText.textContent = isCollapsed ? "할일" : "닫기";

        if (!isCollapsed) {
          const todos = await loadTodos();
          renderTodos(todos);
        }
      });

      // 새로고침 버튼
      const refreshBtn = container.querySelector("#ai-refresh-btn");
      if (refreshBtn) {
        refreshBtn.addEventListener("click", async () => {
          refreshBtn.disabled = true;
          refreshBtn.textContent = "불러오는 중...";
          await refreshEmployeeList();
          await generateRecurringTodos();
          const todos = await loadTodos();
          renderTodos(todos);
          renderRecurringList();
          refreshBtn.textContent = "새로고침 완료!";
          refreshBtn.disabled = false;
          setTimeout(() => { refreshBtn.textContent = "새로고침"; }, 1500);
        });
      }

      // ─── 다음 푸시 알림 카운트다운 ───
      const pushEl = container.querySelector("#ai-next-push");
      let countdownInterval = null;
      function updateCountdown() {
        if (!pushEl) return;
        try {
          chrome.runtime.sendMessage({ type: "get-next-alarm" }, (res) => {
            if (chrome.runtime.lastError) {
              pushEl.textContent = "다음 알림: 대기 중...";
              if (countdownInterval) clearInterval(countdownInterval);
              return;
            }
            if (!res || !res.scheduledTime) {
              pushEl.textContent = "다음 알림: 대기 중...";
              return;
            }
            const remaining = Math.max(0, Math.round((res.scheduledTime - Date.now()) / 1000));
            if (remaining >= 60) {
              const min = Math.floor(remaining / 60);
              const sec = remaining % 60;
              pushEl.textContent = "다음 알림: " + min + "분 " + sec + "초 후";
            } else {
              pushEl.textContent = "다음 알림: " + remaining + "초 후";
            }
          });
        } catch (e) {
          if (countdownInterval) clearInterval(countdownInterval);
        }
      }
      updateCountdown();
      countdownInterval = setInterval(updateCountdown, 1000);

      // 접속 시 버전 체크 요청
      chrome.runtime.sendMessage({ type: "check-version" });

      // background에서 알람 발생 시 자동 갱신
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === "next-alarm") {
          updateCountdown();
        }
        if (msg.type === "version-update") {
          const toast = document.createElement("div");
          toast.innerHTML = '🔄 새 버전 <b>v' + msg.version + '</b> 사용 가능 — <u>클릭하여 업데이트</u>';
          Object.assign(toast.style, {
            position: "fixed", bottom: "30px", left: "50%", transform: "translateX(-50%)",
            padding: "12px 24px", borderRadius: "10px", fontSize: "13px", fontWeight: "600", zIndex: "999999",
            color: "white", background: "linear-gradient(135deg,#6366f1,#8b5cf6)",
            boxShadow: "0 4px 16px rgba(99,102,241,0.35)", cursor: "pointer",
          });
          toast.addEventListener("click", () => {
            toast.innerHTML = '⏳ 업데이트 중...';
            toast.style.pointerEvents = 'none';
            chrome.runtime.sendMessage({ type: "trigger-update" });
          });
          document.body.appendChild(toast);
        }
      });
    })
    .catch((err) => {
      console.error("[AI To-Do] 사이드바 로드 실패:", err);
    });
})();
