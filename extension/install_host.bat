@echo off
chcp 65001 >nul
echo === 채널에이전트 네이티브 호스트 설치 ===
echo.

set /p EXT_ID="Chrome 확장프로그램 ID 입력 (chrome://extensions 에서 확인): "
if "%EXT_ID%"=="" (
    echo ID를 입력해주세요.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_host.ps1" -ExtId "%EXT_ID%"
pause
