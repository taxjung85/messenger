document.addEventListener("DOMContentLoaded", () => {
  const fields = {
    supabaseUrl: document.getElementById("supabaseUrl"),
    supabaseKey: document.getElementById("supabaseKey"),
    openaiKey: document.getElementById("openaiKey"),
    clientFolderPath: document.getElementById("clientFolderPath"),
  };
  const status = document.getElementById("status");
  const saveBtn = document.getElementById("saveBtn");

  // 저장된 값 불러오기
  chrome.storage.local.get(["supabaseUrl", "supabaseKey", "openaiKey", "clientFolderPath"], (result) => {
    if (result.supabaseUrl) fields.supabaseUrl.value = result.supabaseUrl;
    if (result.supabaseKey) fields.supabaseKey.value = result.supabaseKey;
    if (result.openaiKey) fields.openaiKey.value = result.openaiKey;
    if (result.clientFolderPath) fields.clientFolderPath.value = result.clientFolderPath;
  });

  // 저장
  saveBtn.addEventListener("click", () => {
    const supabaseUrl = fields.supabaseUrl.value.trim();
    const supabaseKey = fields.supabaseKey.value.trim();
    const openaiKey = fields.openaiKey.value.trim();
    const clientFolderPath = fields.clientFolderPath.value.trim();

    if (!supabaseUrl || !supabaseKey || !openaiKey) {
      status.className = "ai-status error";
      status.textContent = "API 키 항목을 모두 입력해주세요.";
      return;
    }

    chrome.storage.local.set({ supabaseUrl, supabaseKey, openaiKey, clientFolderPath }, () => {
      status.className = "ai-status success";
      status.textContent = "저장되었습니다. 카카오톡 채널 관리자 센터 페이지를 새로고침해주세요.";
      setTimeout(() => { status.style.display = "none"; }, 5000);
    });
  });
});
