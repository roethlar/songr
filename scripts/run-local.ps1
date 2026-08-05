Param(
    [switch]$InstallOnly
)

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo = Join-Path $Root ".."
Set-Location $Repo

Write-Host "[roon-controller] Ensuring backend dependencies..."
if (-not (Test-Path "node_modules")) {
    npm install
}

Write-Host "[roon-controller] Ensuring frontend dependencies..."
if (-not (Test-Path "ui\node_modules")) {
    npm --prefix ui install
}

if ($InstallOnly) {
    Write-Host "Dependencies installed. Re-run without -InstallOnly to start the app." -ForegroundColor Cyan
    exit 0
}

Write-Host "[roon-controller] Launching backend and frontend (Ctrl+C to stop)..."
npx --yes concurrently "npm run dev" "npm --prefix ui run dev -- --host"
