/**
 * Native Messaging Host 설치 스크립트
 * 사용법: node install_host.js <확장프로그램ID>
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const extId = process.argv[2];
if (!extId) {
  console.log("사용법: node install_host.js <확장프로그램ID>");
  console.log("확장프로그램 ID는 chrome://extensions 에서 확인");
  process.exit(1);
}

const scriptDir = __dirname;
const batPath = path.join(scriptDir, "native_host.bat");
const manifestPath = path.join(scriptDir, "com.jungsem.messenger.json");

// 1) 매니페스트 생성
const manifest = {
  name: "com.jungsem.messenger",
  description: "Jungsem Messenger Native Host",
  path: batPath,
  type: "stdio",
  allowed_origins: [`chrome-extension://${extId}/`],
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
console.log("[OK] 매니페스트 생성:", manifestPath);

// 2) 레지스트리 등록
const regKey = "HKCU\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\com.jungsem.messenger";
try {
  execSync(`reg add "${regKey}" /ve /t REG_SZ /d "${manifestPath}" /f`, { stdio: "pipe" });
  console.log("[OK] 레지스트리 등록 완료");
} catch (e) {
  console.error("[ERROR] 레지스트리 등록 실패:", e.message);
  process.exit(1);
}

console.log();
console.log("  확장프로그램 ID:", extId);
console.log("  매니페스트:", manifestPath);
console.log("  네이티브 호스트:", batPath);
console.log();
console.log("Chrome을 재시작해주세요.");
