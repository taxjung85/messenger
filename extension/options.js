document.addEventListener("DOMContentLoaded", () => {
  const fields = {
    supabaseUrl: document.getElementById("supabaseUrl"),
    supabaseKey: document.getElementById("supabaseKey"),
    openaiKey: document.getElementById("openaiKey"),
  };
  const status = document.getElementById("status");
  const saveBtn = document.getElementById("saveBtn");
  const showBtn = document.getElementById("showBtn");

  // 저장된 값 불러오기
  chrome.storage.local.get(["supabaseUrl", "supabaseKey", "openaiKey"], (result) => {
    if (result.supabaseUrl) fields.supabaseUrl.value = result.supabaseUrl;
    if (result.supabaseKey) fields.supabaseKey.value = result.supabaseKey;
    if (result.openaiKey) fields.openaiKey.value = result.openaiKey;
  });

  // 키 보기/숨기기 토글
  showBtn.addEventListener("click", () => {
    const type = fields.supabaseKey.type === "password" ? "text" : "password";
    fields.supabaseKey.type = type;
    fields.openaiKey.type = type;
  });

  // 저장
  saveBtn.addEventListener("click", () => {
    const supabaseUrl = fields.supabaseUrl.value.trim();
    const supabaseKey = fields.supabaseKey.value.trim();
    const openaiKey = fields.openaiKey.value.trim();

    if (!supabaseUrl || !supabaseKey || !openaiKey) {
      status.className = "status error";
      status.textContent = "모든 항목을 입력해주세요.";
      return;
    }

    chrome.storage.local.set({ supabaseUrl, supabaseKey, openaiKey }, () => {
      status.className = "status success";
      status.textContent = "저장되었습니다. 카카오톡 채널 관리자 센터 페이지를 새로고침해주세요.";
      setTimeout(() => { status.style.display = "none"; }, 5000);
    });
  });
});
