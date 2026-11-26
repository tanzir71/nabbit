param(
  [string]$Target = "x86_64-pc-windows-msvc",
  [switch]$Force
)
$ErrorActionPreference = "Stop"
$setupArgs = @((Join-Path $PSScriptRoot 'fetch-engines.mjs'), $Target)
if ($Force) { $setupArgs += '--force' }
& node @setupArgs
if ($LASTEXITCODE -ne 0) { throw 'Pinned sidecar setup failed' }
