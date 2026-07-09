param(
  [string]$Target = "x86_64-pc-windows-msvc",
  [string]$Bundles = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$DefaultKey = Join-Path $env:USERPROFILE ".tauri\nabbit-updater.key"

if (-not $env:TAURI_SIGNING_PRIVATE_KEY -and -not $env:TAURI_SIGNING_PRIVATE_KEY_PATH) {
  if (Test-Path -LiteralPath $DefaultKey) {
    $env:TAURI_SIGNING_PRIVATE_KEY_PATH = $DefaultKey
    $env:TAURI_SIGNING_PRIVATE_KEY = $DefaultKey
  } else {
    throw "Set TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH before building updater artifacts."
  }
}

& (Join-Path $PSScriptRoot "fetch-binaries.ps1") -Target $Target
Push-Location $Root
try {
  $npmArgs = @("run", "tauri", "--", "build", "--config", "src-tauri/tauri.release.conf.json", "--target", $Target, "--ci")
  if (-not [string]::IsNullOrWhiteSpace($Bundles)) {
    $npmArgs += @("--bundles", $Bundles)
  }
  & npm @npmArgs
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
} finally {
  Pop-Location
}
