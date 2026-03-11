# Chrome Native Messaging Host (PowerShell)
$input_stream = [System.Console]::OpenStandardInput()
$output_stream = [System.Console]::OpenStandardOutput()

# Read 4-byte length
$lenBytes = New-Object byte[] 4
$input_stream.Read($lenBytes, 0, 4) | Out-Null
$msgLen = [System.BitConverter]::ToUInt32($lenBytes, 0)

# Read message
$msgBytes = New-Object byte[] $msgLen
$read = 0
while ($read -lt $msgLen) {
    $read += $input_stream.Read($msgBytes, $read, $msgLen - $read)
}
$msgJson = [System.Text.Encoding]::UTF8.GetString($msgBytes)
$msg = $msgJson | ConvertFrom-Json

function Send-Response($obj) {
    $json = $obj | ConvertTo-Json -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $len = [System.BitConverter]::GetBytes([uint32]$bytes.Length)
    $output_stream.Write($len, 0, 4)
    $output_stream.Write($bytes, 0, $bytes.Length)
    $output_stream.Flush()
}

function Find-ClientFolder($basePath, $clientCode) {
    if (-not $basePath -or -not $clientCode) { return $null }
    $folders = Get-ChildItem -Path $basePath -Directory -Filter "$clientCode`_*" -ErrorAction SilentlyContinue
    if ($folders.Count -gt 0) { return $folders[0].FullName }
    # underscore 없이 space로 시작하는 경우도 체크
    $folders2 = Get-ChildItem -Path $basePath -Directory -Filter "$clientCode *" -ErrorAction SilentlyContinue
    if ($folders2.Count -gt 0) { return $folders2[0].FullName }
    return $null
}

switch ($msg.action) {
    "open_folder" {
        $folder = Find-ClientFolder $msg.basePath $msg.clientCode
        if ($folder) {
            Start-Process explorer.exe $folder
            Send-Response @{ success = $true; path = $folder }
        } else {
            Send-Response @{ success = $false; error = "$($msg.clientCode) 폴더 없음" }
        }
    }
    "move_file" {
        $folder = Find-ClientFolder $msg.basePath $msg.clientCode
        if (-not $folder) {
            Send-Response @{ success = $false; error = "$($msg.clientCode) 폴더 없음" }
            return
        }
        $dst = Join-Path $folder $msg.filename
        # 파일 대기 (최대 5초)
        for ($i = 0; $i -lt 10; $i++) {
            if (Test-Path $msg.src) { break }
            Start-Sleep -Milliseconds 500
        }
        if (-not (Test-Path $msg.src)) {
            Send-Response @{ success = $false; error = "원본 파일 없음" }
            return
        }
        try {
            Move-Item -Path $msg.src -Destination $dst -Force
            Send-Response @{ success = $true; path = $dst }
        } catch {
            Send-Response @{ success = $false; error = $_.Exception.Message }
        }
    }
    "ping" {
        Send-Response @{ success = $true; message = "pong" }
    }
    default {
        Send-Response @{ success = $false; error = "unknown action" }
    }
}
