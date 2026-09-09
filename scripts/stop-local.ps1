$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$manifest = Join-Path $workspace '.local/processes.json'
if (-not (Test-Path -LiteralPath $manifest)) { Write-Host 'No managed local processes.'; exit 0 }
foreach ($entry in @(Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json)) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($entry.pid)" -ErrorAction SilentlyContinue
    if ($process -and $process.ExecutablePath -eq $entry.executable -and $process.CommandLine.Contains($workspace)) {
        Stop-Process -Id $entry.pid
        Write-Host "Stopped $($entry.name)"
    }
}
Set-Content -LiteralPath $manifest -Value '[]' -Encoding utf8
