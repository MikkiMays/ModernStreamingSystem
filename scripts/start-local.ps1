param([string]$JavaHome = 'C:\Java\jdk-25', [switch]$SkipBuild, [switch]$SkipWeb)
$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $workspace
$toolsDirectory = Join-Path $workspace '.local/tools'
New-Item -ItemType Directory -Path $toolsDirectory,(Join-Path $workspace '.local/logs'),(Join-Path $workspace 'server/.local/uploads') -Force | Out-Null

function Get-NativeTool([string]$Name, [string]$Url, [string]$Hash, [string]$Algorithm, [string]$Executable) {
    $directory = Join-Path $toolsDirectory $Name
    $binary = Join-Path $directory $Executable
    if (-not (Test-Path -LiteralPath $binary)) {
        $archive = Join-Path $toolsDirectory "$Name.zip"
        Invoke-WebRequest -Uri $Url -OutFile $archive
        if ((Get-FileHash -LiteralPath $archive -Algorithm $Algorithm).Hash -ne $Hash) { throw "$Name checksum mismatch" }
        Expand-Archive -LiteralPath $archive -DestinationPath $directory -Force
    }
    return $binary
}
$livekit = Get-NativeTool 'livekit' 'https://github.com/livekit/livekit/releases/download/v1.13.6/livekit_1.13.6_windows_amd64.zip' '9DF299B6C6C32F1BE88D3D106A9A63F8F921B424B353CC59F57D6B84532A4475' 'SHA256' 'livekit-server.exe'
$tusd = Get-NativeTool 'tusd' 'https://github.com/tus/tusd/releases/download/v2.10.0/tusd_windows_amd64.zip' '4DF52E9090A58612828ADB7050C8D5D3DDDB63D7EF00BBA983419E940BC5F784' 'SHA256' 'tusd_windows_amd64/tusd.exe'
$caddy = Get-NativeTool 'caddy' 'https://github.com/caddyserver/caddy/releases/download/v2.11.4/caddy_2.11.4_windows_amd64.zip' 'CD5CCFD86A4B40732CF715890D0DCA5BF3F63ADEFEC5A7914DE85ADF240C60CE7E5D2791631B88EF9758E46B23BB1730E020B9C5D696889740B284FFD4788E35' 'SHA512' 'caddy.exe'
$env:JAVA_HOME = $JavaHome
$java = Join-Path $JavaHome 'bin/java.exe'
if (-not (Test-Path -LiteralPath $java)) { throw 'Install Java 25 and pass -JavaHome <path>.' }
if (-not $SkipBuild) {
    & (Join-Path $workspace 'mvnw.cmd') -q -pl server -am package -DskipTests
    if ($LASTEXITCODE -ne 0) { throw 'Server build failed' }
    Push-Location web
    try { npm.cmd ci --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' } }
    finally { Pop-Location }
}
$started = @()
function Start-LocalService([string]$Name,[string]$Executable,[string[]]$Arguments,[string]$Directory,[int]$Port) {
    if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { Write-Host "$Name already listening on $Port; left running."; return }
    $quotedArguments = $Arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }
    $process = Start-Process -FilePath $Executable -ArgumentList $quotedArguments -WorkingDirectory $Directory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $workspace ".local/logs/$Name.out.log") -RedirectStandardError (Join-Path $workspace ".local/logs/$Name.err.log")
    $script:started += @{ name=$Name; pid=$process.Id; executable=$Executable }
}
Start-LocalService 'gateway' $caddy @('run','--config',(Join-Path $workspace 'infra/Caddyfile.local'),'--adapter','caddyfile') $workspace 7883
Start-LocalService 'livekit' $livekit @('--config',(Join-Path $workspace 'infra/livekit.local.yaml')) $workspace 7880
Start-LocalService 'tusd' $tusd @('-host','127.0.0.1','-port','1080','-base-path','/uploads/','-upload-dir',(Join-Path $workspace 'server/.local/uploads'),'-max-size','104857600','-behind-proxy','-disable-download','-disable-concatenation','-hooks-http','http://127.0.0.1:8090/internal/tus','-hooks-http-forward-headers','Authorization','-hooks-enabled-events','pre-create,post-finish','-verbose=false','-show-startup-logs=false') $workspace 1080
Start-LocalService 'core' $java @('-jar',(Join-Path $workspace 'server/target/streaming-server-0.1.0-SNAPSHOT.jar'),'--spring.profiles.active=local') (Join-Path $workspace 'server') 8080
if (-not $SkipWeb) {
    $node = (Get-Command node.exe).Source
    Start-LocalService 'web' $node @((Join-Path $workspace 'web/node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--strictPort') (Join-Path $workspace 'web') 5173
}
$manifest = Join-Path $workspace '.local/processes.json'
$previous = if (Test-Path -LiteralPath $manifest) { @(Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json) } else { @() }
@($previous + $started) | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifest -Encoding utf8
$startupDeadline = [DateTime]::UtcNow.AddSeconds(45)
$ready = $false
do {
    try { $ready = (Invoke-RestMethod -Uri 'http://127.0.0.1:8080/actuator/health' -TimeoutSec 2).status -eq 'UP' }
    catch { Start-Sleep -Milliseconds 250 }
} while (-not $ready -and [DateTime]::UtcNow -lt $startupDeadline)
if (-not $ready) { throw 'Core did not become healthy. Inspect .local/logs/core.err.log and core.out.log.' }
if (-not $SkipWeb) {
    $webDeadline = [DateTime]::UtcNow.AddSeconds(45)
    $webReady = $false
    do {
        try { $webReady = (Invoke-WebRequest -Uri 'http://127.0.0.1:5173/' -TimeoutSec 2).StatusCode -eq 200 }
        catch { $webReady = $false }
        if (-not $webReady) { Start-Sleep -Milliseconds 250 }
    } while (-not $webReady -and [DateTime]::UtcNow -lt $webDeadline)
    if (-not $webReady) { throw 'Web did not become ready. Inspect .local/logs/web.err.log and web.out.log.' }
    Write-Host 'Open http://localhost:5173. Local development uses H2 and loopback media; production uses PostgreSQL, Redis and TURN.'
} else {
    Write-Host 'Local backend is ready. The test runner will manage the web server.'
}
