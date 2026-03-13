@echo off
chcp 65001 >nul
echo === 채널에이전트 네이티브 호스트 설치 ===
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup_host.ps1"
pause
