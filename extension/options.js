document.addEventListener("DOMContentLoaded", () => {
  // ─── OAuth 콜백 처리 (Supabase 리다이렉트 후 토큰 감지) ───
  if (window.location.hash && window.location.hash.includes("access_token")) {
    const hashParams = new URLSearchParams(window.location.hash.substring(1));
    const accessToken = hashParams.get("access_token");
    const refreshToken = hashParams.get("refresh_token");
    if (accessToken) {
      chrome.storage.local.set({
        authAccessToken: accessToken,
        authRefreshToken: refreshToken || "",
      });
      chrome.runtime.sendMessage({
        type: "oauth-callback",
        accessToken: accessToken,
        refreshToken: refreshToken || "",
      });
      history.replaceState(null, "", window.location.pathname);
    }
  }

  const clientFolderPath = document.getElementById("clientFolderPath");
  const status = document.getElementById("status");
  const saveBtn = document.getElementById("saveBtn");
  const loginBtn = document.getElementById("loginBtn");
  const logoutBtn = document.getElementById("logoutBtn");
  const authStatus = document.getElementById("auth-status");

  // 인증 상태 표시
  chrome.storage.local.get(["authUserEmail", "authAccessToken"], (result) => {
    if (result.authAccessToken && result.authUserEmail) {
      authStatus.style.display = "block";
      authStatus.style.background = "#ecfdf5";
      authStatus.style.color = "#059669";
      authStatus.style.border = "1px solid #a7f3d0";
      authStatus.textContent = result.authUserEmail + " 로그인됨";
      loginBtn.style.display = "none";
      logoutBtn.style.display = "inline-flex";
    } else {
      authStatus.style.display = "block";
      authStatus.style.background = "#fef2f2";
      authStatus.style.color = "#dc2626";
      authStatus.style.border = "1px solid #fecaca";
      authStatus.textContent = "로그인되지 않음 — Google 로그인 필요";
      loginBtn.style.display = "inline-flex";
      logoutBtn.style.display = "none";
    }
  });

  // 저장된 값 불러오기
  chrome.storage.local.get(["clientFolderPath"], (result) => {
    if (result.clientFolderPath) clientFolderPath.value = result.clientFolderPath;
  });

  // Google 로그인
  loginBtn.addEventListener("click", () => {
    loginBtn.textContent = "로그인 중...";
    loginBtn.disabled = true;
    chrome.runtime.sendMessage({ type: "google-login" }, (res) => {
      if (res && res.success) {
        authStatus.style.display = "block";
        authStatus.style.background = "#ecfdf5";
        authStatus.style.color = "#059669";
        authStatus.style.border = "1px solid #a7f3d0";
        authStatus.textContent = (res.email || "") + " 로그인 성공!";
        loginBtn.style.display = "none";
        logoutBtn.style.display = "inline-flex";
      } else {
        authStatus.style.display = "block";
        authStatus.style.background = "#fef2f2";
        authStatus.style.color = "#dc2626";
        authStatus.textContent = "로그인 실패: " + (res?.error || "알 수 없음");
        loginBtn.textContent = "Google 로그인";
        loginBtn.disabled = false;
      }
    });
  });

  // 로그아웃
  logoutBtn.addEventListener("click", () => {
    chrome.storage.local.remove(["authAccessToken", "authRefreshToken", "authUserEmail"], () => {
      authStatus.textContent = "로그아웃됨";
      authStatus.style.background = "#fef2f2";
      authStatus.style.color = "#dc2626";
      authStatus.style.border = "1px solid #fecaca";
      loginBtn.style.display = "inline-flex";
      logoutBtn.style.display = "none";
    });
  });

  // 저장
  saveBtn.addEventListener("click", () => {
    const folder = clientFolderPath.value.trim();

    chrome.storage.local.set({ clientFolderPath: folder }, () => {
      status.className = "ai-status success";
      status.textContent = "저장되었습니다.";
      setTimeout(() => { status.style.display = "none"; }, 5000);
    });
  });
});
