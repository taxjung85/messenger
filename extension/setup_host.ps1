param([string]$ExtId)

if (-not $ExtId) {
    $ExtId = Read-Host "Chrome extension ID"
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$batPath = Join-Path $scriptDir "native_host.bat"
$manifestPath = Join-Path $scriptDir "com.jungsem.messenger.json"

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
Write-Host "Restart Chrome."
Read-Host "Press Enter"
