param([string]$ExtId = "kombcjpmcbmglgjelkbeaadajcdgnkkp")

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$batPath = Join-Path $scriptDir "native_host.bat"

# JSON을 로컬 전용 폴더에 저장 (Google Drive 동기화 안 되는 곳)
$localDir = Join-Path $env:LOCALAPPDATA "JungsemMessenger"
if (-not (Test-Path $localDir)) { New-Item -ItemType Directory -Path $localDir -Force | Out-Null }
$manifestPath = Join-Path $localDir "com.jungsem.messenger.json"

# Write manifest
$manifest = @{
    name = "com.jungsem.messenger"
    description = "Jungsem Messenger Native Host"
    path = $batPath
    type = "stdio"
    allowed_origins = @("chrome-extension://$ExtId/")
}
$manifest | ConvertTo-Json | Set-Content -Encoding UTF8 $manifestPath
Write-Host "[OK] Manifest: $manifestPath"

# Registry
$regPath = "HKCU:\SOFTWARE\Google\Chrome\NativeMessagingHosts\com.jungsem.messenger"
New-Item -Path $regPath -Force | Out-Null
Set-ItemProperty -Path $regPath -Name "(Default)" -Value $manifestPath
Write-Host "[OK] Registry done"
Write-Host ""
Write-Host "Chrome을 재시작하세요."
Read-Host "Enter를 누르세요"
