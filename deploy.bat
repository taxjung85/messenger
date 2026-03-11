@echo off
chcp 65001 >nul
set /p VERSION="새 버전 입력 (예: 1.2.0): "

:: 1. manifest.json 버전 업데이트
powershell -Command "(Get-Content extension\manifest.json -Encoding UTF8) -replace '\"version\": \".*?\"', '\"version\": \"%VERSION%\"' | Set-Content extension\manifest.json -Encoding UTF8"
echo [1/2] manifest.json → v%VERSION%

:: 2. Git 커밋 + 푸시
git add .
git commit -m "v%VERSION%"
git push origin main
echo [2/2] GitHub 푸시 완료

echo.
echo ===== v%VERSION% 배포 완료 =====
echo.
pause
