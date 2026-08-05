#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Roon Controller - Windows installer
.DESCRIPTION
    Builds from source and installs as a Windows service using NSSM.
    Must be run as Administrator from the repository root.
.PARAMETER Port
    HTTP port (default: 3333; on reinstall, an existing .env PORT wins
    unless -Port is passed explicitly)
.PARAMETER InstallDir
    Install path (default: C:\Program Files\RoonController)
.PARAMETER NoStart
    Install but do not start the service
.PARAMETER Reinstall
    Overwrite an existing installation. Preserved across reinstall:
    config\ (pairing token), data\ (caches, recently-played), and .env —
    which is the SOURCE OF TRUTH for the regenerated NSSM service
    environment, so .env edits survive and take effect on reinstall.
    Rebuilt: dist\, ui\build, node_modules, and the NSSM service.
.EXAMPLE
    .\scripts\install-windows.ps1
    .\scripts\install-windows.ps1 -Port 8080 -Reinstall
#>

param(
    [int]$Port = 3333,
    [string]$InstallDir = "$env:ProgramFiles\RoonController",
    [switch]$NoStart,
    [switch]$Reinstall
)

$ErrorActionPreference = "Stop"
$ServiceName = "RoonController"
$PortExplicit = $PSBoundParameters.ContainsKey('Port')

# ── Colour helpers ─────────────────────────────────────────────────────────────
function Info($msg)    { Write-Host "[install] $msg" -ForegroundColor Cyan }
function Success($msg) { Write-Host "[install] $msg" -ForegroundColor Green }
function Warn($msg)    { Write-Host "[install] $msg" -ForegroundColor Yellow }
function Die($msg)     { Write-Host "[install] ERROR: $msg" -ForegroundColor Red; exit 1 }

# ── Pre-flight checks ──────────────────────────────────────────────────────────
if (-not (Test-Path "package.json") -or -not (Test-Path "src") -or -not (Test-Path "ui")) {
    Die "Run this script from the repository root (directory containing package.json, src\, ui\)."
}

$NodeBin = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeBin) { Die "Node.js is not installed. Install Node 20+ and re-run." }
$NodeBin = $NodeBin.Source

$NodeMajor = & $NodeBin -e "process.stdout.write(String(process.versions.node.split('.')[0]))"
if ([int]$NodeMajor -lt 20) { Die "Node.js 20 or newer is required (found $(& $NodeBin --version))." }

$NpmBin = Get-Command npm -ErrorAction SilentlyContinue
if (-not $NpmBin) { Die "npm is not installed." }
$NpmBin = $NpmBin.Source

if ((Test-Path $InstallDir) -and -not $Reinstall) {
    Die "$InstallDir already exists. Use -Reinstall to overwrite."
}

# Check for NSSM (Non-Sucking Service Manager) — needed because node.exe
# is not a native Windows service binary.
$NssmBin = Get-Command nssm -ErrorAction SilentlyContinue
if (-not $NssmBin) {
    Die "NSSM is required but not found. Install it: winget install nssm  or  choco install nssm"
}
$NssmBin = $NssmBin.Source

# ── Resolve effective config against any existing .env ────────────────────────
# The NSSM service environment below is REGENERATED from .env on every
# install, so .env is the single source of truth for service config on
# Windows. An existing .env is preserved; only its PORT line is synced
# when -Port is passed explicitly.
$EnvFile = Join-Path $InstallDir ".env"

function Get-EnvValue([string]$Key, [string]$Default) {
    if (Test-Path $EnvFile) {
        $line = Select-String -Path $EnvFile -Pattern "^$Key=" | Select-Object -First 1
        if ($line) { return ($line.Line.Substring($Key.Length + 1)).Trim() }
    }
    return $Default
}

if (Test-Path $EnvFile) {
    if ($PortExplicit) {
        $existingPort = Get-EnvValue "PORT" ""
        if ($existingPort -and $existingPort -ne "$Port") {
            Info "Updating PORT in existing .env: $existingPort -> $Port"
            (Get-Content $EnvFile) -replace '^PORT=.*', "PORT=$Port" | Set-Content -Path $EnvFile -Encoding UTF8
        } elseif (-not $existingPort) {
            Info "Appending PORT=$Port to existing .env (no PORT= line found)"
            Add-Content -Path $EnvFile -Value "PORT=$Port" -Encoding UTF8
        }
    } else {
        # No -Port passed; the existing .env wins so a reinstall never
        # silently resets a customized port back to the script default.
        $envPort = Get-EnvValue "PORT" "$Port"
        $Port = [int]$envPort
    }
}

# ── Summary ────────────────────────────────────────────────────────────────────
Write-Host ""
Info "Roon Controller Windows installer"
Info "  Install dir : $InstallDir"
Info "  Port        : $Port"
Info "  Node        : $(& $NodeBin --version)"
Write-Host ""

# ── Build ──────────────────────────────────────────────────────────────────────
Info "Installing backend dependencies..."
& $NpmBin ci --prefer-offline 2>&1 | ForEach-Object { "  $_" }
if ($LASTEXITCODE -ne 0) { Die "Backend dependency install failed." }

Info "Building backend..."
& $NpmBin run build 2>&1 | ForEach-Object { "  $_" }
if ($LASTEXITCODE -ne 0) { Die "Backend build failed." }

Info "Installing frontend dependencies..."
& $NpmBin --prefix ui ci --prefer-offline 2>&1 | ForEach-Object { "  $_" }
if ($LASTEXITCODE -ne 0) { Die "Frontend dependency install failed." }

Info "Building frontend..."
& $NpmBin --prefix ui run build 2>&1 | ForEach-Object { "  $_" }
if ($LASTEXITCODE -ne 0) { Die "Frontend build failed." }

Success "Build complete."

# ── Stop existing service ──────────────────────────────────────────────────────
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Info "Stopping existing service..."
    & $NssmBin stop $ServiceName 2>$null
    & $NssmBin remove $ServiceName confirm 2>$null
    Start-Sleep -Seconds 2
}

# ── Deploy files ───────────────────────────────────────────────────────────────
Info "Deploying to $InstallDir..."

$dirs = @("config", "data\image-cache", "ui")
foreach ($d in $dirs) {
    $full = Join-Path $InstallDir $d
    if (-not (Test-Path $full)) { New-Item -ItemType Directory -Path $full -Force | Out-Null }
}

# Wipe build artefacts before re-copying so files removed in a newer build
# don't survive as stale leftovers. config\ and data\ are NOT touched.
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "$InstallDir\dist"
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "$InstallDir\ui\build"
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "$InstallDir\vendor"

Copy-Item -Recurse -Force "dist"          "$InstallDir\"
Copy-Item -Recurse -Force "ui\build"      "$InstallDir\ui\"
Copy-Item -Recurse -Force "vendor"        "$InstallDir\"
Copy-Item -Force          "package.json"   "$InstallDir\"
Copy-Item -Force          "package-lock.json" "$InstallDir\"

Info "Installing production dependencies in $InstallDir..."
& $NpmBin ci --omit=dev --prefix $InstallDir --prefer-offline 2>&1 | ForEach-Object { "  $_" }
if ($LASTEXITCODE -ne 0) { Die "Production dependency install failed." }

# ── Environment file ───────────────────────────────────────────────────────────
# NSSM doesn't read .env files — the AppEnvironmentExtra string below is
# the runtime environment — but it is GENERATED FROM this .env, which is
# the file to edit. After editing .env, re-run this installer with
# -Reinstall to apply.
# Keep this template in sync with .env.example at the repo root.
if (Test-Path $EnvFile) {
    Warn ".env already exists - preserving (PORT was synced if -Port was passed)."
} else {
    Info "Writing .env (the NSSM service environment is generated from it)..."
    @"
NODE_ENV=production
HOST=0.0.0.0
PORT=$Port
LOG_LEVEL=info
ROON_TOKEN_PATH=$InstallDir\config\roon-token.json
IMAGE_CACHE_PATH=$InstallDir\data\image-cache
IMAGE_CACHE_MAX_BYTES=10737418240
RECENTLY_PLAYED_PATH=$InstallDir\data\recently-played.json
# RECENTLY_PLAYED_CAP=50
# CLIENT_ORIGIN=http://roon.lan,http://192.168.1.10:$Port
# TRUST_PROXY=true
"@ | Set-Content -Path $EnvFile -Encoding UTF8
}

# ── Install service via NSSM ──────────────────────────────────────────────────
Info "Installing Windows service via NSSM..."

& $NssmBin install $ServiceName "$NodeBin" "dist\index.js"
& $NssmBin set $ServiceName AppDirectory "$InstallDir"
& $NssmBin set $ServiceName DisplayName "Roon Controller"
& $NssmBin set $ServiceName Description "Web-based controller for Roon music playback"
& $NssmBin set $ServiceName Start SERVICE_AUTO_START
& $NssmBin set $ServiceName AppStdout (Join-Path $InstallDir "logs\out.log")
& $NssmBin set $ServiceName AppStderr (Join-Path $InstallDir "logs\error.log")
& $NssmBin set $ServiceName AppRotateFiles 1
& $NssmBin set $ServiceName AppRotateBytes 10485760

New-Item -ItemType Directory -Path (Join-Path $InstallDir "logs") -Force | Out-Null

# Set environment variables for the service — every value is read from
# the preserved .env so hand edits there survive reinstall and take
# effect. Optional vars are included only when set in .env.
$envParts = @(
    "NODE_ENV=production",
    "HOST=$(Get-EnvValue 'HOST' '0.0.0.0')",
    "PORT=$Port",
    "LOG_LEVEL=$(Get-EnvValue 'LOG_LEVEL' 'info')",
    "ROON_TOKEN_PATH=$(Get-EnvValue 'ROON_TOKEN_PATH' "$InstallDir\config\roon-token.json")",
    "IMAGE_CACHE_PATH=$(Get-EnvValue 'IMAGE_CACHE_PATH' "$InstallDir\data\image-cache")",
    "IMAGE_CACHE_MAX_BYTES=$(Get-EnvValue 'IMAGE_CACHE_MAX_BYTES' '10737418240')",
    "RECENTLY_PLAYED_PATH=$(Get-EnvValue 'RECENTLY_PLAYED_PATH' "$InstallDir\data\recently-played.json")"
)
foreach ($optionalKey in @('RECENTLY_PLAYED_CAP', 'CLIENT_ORIGIN', 'TRUST_PROXY')) {
    $v = Get-EnvValue $optionalKey ""
    if ($v) { $envParts += "$optionalKey=$v" }
}
$envString = $envParts -join ' '
& $NssmBin set $ServiceName AppEnvironmentExtra $envString

# ── Start ──────────────────────────────────────────────────────────────────────
if (-not $NoStart) {
    Info "Starting service..."
    & $NssmBin start $ServiceName
    Start-Sleep -Seconds 3
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq "Running") {
        Success "Service is running."
    } else {
        Warn "Service did not start cleanly. Check logs:"
        Warn "  Get-Content $InstallDir\logs\error.log -Tail 50"
        exit 1
    }
} else {
    Info "Skipping service start (-NoStart was set)."
    Info "Start manually with: nssm start $ServiceName"
}

# ── Done ───────────────────────────────────────────────────────────────────────
Write-Host ""
Success "Installation complete!"
Write-Host ""
$localIp = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch "Loopback" } | Select-Object -First 1).IPAddress
Write-Host "  URL        : http://${localIp}:$Port"
Write-Host "  Logs       : Get-Content $InstallDir\logs\out.log -Tail 50"
Write-Host "  Stop       : nssm stop $ServiceName"
Write-Host "  Uninstall  : nssm remove $ServiceName confirm; Remove-Item -Recurse $InstallDir"
Write-Host ""
Write-Host "  First run: open Roon > Settings > Extensions > enable 'Roon Web Controller'"
Write-Host ""
