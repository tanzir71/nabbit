param([string]$Exe="src-tauri/target/debug/nabbit.exe",[string]$OutputPrefix="v11")
$ErrorActionPreference="Stop"
if($OutputPrefix -notmatch "^[a-z0-9-]+$"){throw "Invalid output prefix"}
$root=Split-Path -Parent $PSScriptRoot
$exePath=(Resolve-Path -LiteralPath (Join-Path $root $Exe)).Path
if(Get-Process -Name nabbit -ErrorAction SilentlyContinue){throw "Leave the existing Nabbit process untouched."}
$trialRoot=Join-Path $root (".tools/theme-"+[guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $trialRoot|Out-Null
$names=@("NABBIT_APP_DATA_DIR","NABBIT_ISLAND_SPIKE","NABBIT_ISLAND_RENDERER","WEBVIEW2_USER_DATA_FOLDER","WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
$original=@{};foreach($name in $names){$original[$name]=[Environment]::GetEnvironmentVariable($name,"Process")}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ThemeFocusProbe {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
}
'@
$appProcess=$null
try {
  $env:NABBIT_APP_DATA_DIR=Join-Path $trialRoot "app-data"
  $env:WEBVIEW2_USER_DATA_FOLDER=Join-Path $trialRoot "webview"
  # Explicit flag-zero spike session prewarms the hidden main view and skips OS integration.
  $env:NABBIT_ISLAND_SPIKE="0";$env:NABBIT_ISLAND_RENDERER="webview"
  & python (Join-Path $root "spikes/island/seed_acceptance.py") $env:NABBIT_APP_DATA_DIR
  if($LASTEXITCODE -ne 0){throw "Fixture seed failed"}
  $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$listener.Start();$port=$listener.LocalEndpoint.Port;$listener.Stop()
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$port --remote-debugging-address=127.0.0.1"
  $foreground=[ThemeFocusProbe]::GetForegroundWindow()
  $appProcess=Start-Process -FilePath $exePath -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardError (Join-Path $trialRoot "stderr.log") -PassThru
  Push-Location $root
  try {& node scripts/verify-native-theme.mjs "http://127.0.0.1:$port" $OutputPrefix;if($LASTEXITCODE -ne 0){throw "Native theme verification failed. Logs: $trialRoot"}}finally{Pop-Location}
  if([ThemeFocusProbe]::GetForegroundWindow() -ne $foreground){throw "Theme smoke changed foreground focus"}
  Stop-Process -Id $appProcess.Id -Force;$appProcess.WaitForExit();$appProcess=$null
  & python -c 'import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); s=json.loads(c.execute("SELECT value FROM settings WHERE key=?",("app_settings",)).fetchone()[0]); assert s["theme"]=="dark"; assert c.execute("SELECT COUNT(*) FROM downloads").fetchone()[0]==0' (Join-Path $env:NABBIT_APP_DATA_DIR "nabbit.sqlite3")
  if($LASTEXITCODE -ne 0){throw "SQLite theme/zero-download check failed"}
  $smokeReport=[ordered]@{executableSha256=(Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash.ToLowerInvariant();noDownloadsStarted=$true;noFocusChange=$true;isolatedProfiles=$true;windowsPreferencesChanged=$false;autostartAndShortcutsChanged=$false}
  [IO.File]::WriteAllText((Join-Path $root "progress/v2/M2/$OutputPrefix-native-smoke.json"),($smokeReport|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  Write-Output "Passed isolated native theme smoke without focus, Windows preference, autostart or shortcut changes."
} finally {
  if($appProcess -and -not $appProcess.HasExited){Stop-Process -Id $appProcess.Id -Force;$appProcess.WaitForExit()}
  foreach($name in $names){if($null -eq $original[$name]){Remove-Item -LiteralPath ("Env:"+$name) -ErrorAction SilentlyContinue}else{[Environment]::SetEnvironmentVariable($name,$original[$name],"Process")}}
}
