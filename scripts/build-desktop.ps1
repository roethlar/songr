$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
Set-Location (Join-Path $PSScriptRoot '..')
Remove-Item 'desktop/release/artifacts' -Recurse -Force -ErrorAction SilentlyContinue
npm --prefix desktop run package
