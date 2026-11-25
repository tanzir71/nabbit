param([string]$Exe = "src-tauri/target/debug/nabbit.exe",[switch]$ReducedMotion,[string]$OutputPrefix="v04",[string]$OutputDir="progress/v2/M1")
$ErrorActionPreference = "Stop"
if($OutputPrefix -notmatch "^[a-z0-9-]+$"){throw "Invalid output prefix"}
$root = Split-Path -Parent $PSScriptRoot
$exePath = (Resolve-Path -LiteralPath (Join-Path $root $Exe)).Path
if (Get-Process -Name nabbit -ErrorAction SilentlyContinue) { throw "Leave the existing Nabbit process untouched." }
New-Item -ItemType Directory -Path (Join-Path $root $OutputDir) -Force | Out-Null
$trialRoot = Join-Path $root (".tools/native-island-" + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $trialRoot -Force | Out-Null
$names = @("NABBIT_APP_DATA_DIR", "NABBIT_ISLAND_SPIKE", "NABBIT_ISLAND_RENDERER", "NABBIT_ACCEPTANCE_CURSOR", "NABBIT_ACCEPTANCE_NATIVE_CONTROL", "NABBIT_ACCEPTANCE_NATIVE_SCALE", "NABBIT_ACCEPTANCE_REDUCED_MOTION", "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "WEBVIEW2_USER_DATA_FOLDER")
$original = @{}; foreach ($name in $names) { $original[$name] = [Environment]::GetEnvironmentVariable($name, "Process") }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class NativeIslandProbe {
  public delegate bool EnumCallback(IntPtr hwnd,IntPtr param);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback,IntPtr param);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int size);
  [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hwnd,int index);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  public static IntPtr Find(int processId,string title) {
    IntPtr found=IntPtr.Zero; EnumWindows((hwnd,param)=>{uint pid;GetWindowThreadProcessId(hwnd,out pid);if(pid!=processId)return true;var text=new StringBuilder(256);GetWindowText(hwnd,text,256);if(text.ToString()!=title)return true;found=hwnd;return false;},IntPtr.Zero);return found;
  }
  public static Rect Bounds(IntPtr hwnd) {IntPtr previous=SetThreadDpiAwarenessContext(new IntPtr(-4));try{Rect rect;GetWindowRect(hwnd,out rect);return rect;}finally{SetThreadDpiAwarenessContext(previous);}}
}
'@

function Write-JsonFile($path,$value) { [IO.File]::WriteAllText($path,($value|ConvertTo-Json -Depth 10),[Text.UTF8Encoding]::new($false)) }
function Cursor([double]$x,[double]$y,[bool]$down=$false,[int]$notification=5) { Write-JsonFile $env:NABBIT_ACCEPTANCE_CURSOR @{x=$x;y=$y;leftDown=$down;foreground=@{notificationState=$notification;onMonitor=$true}} }
function Command([string]$state="",[string]$capture="",[Nullable[bool]]$prepareTray=$null) {
  $id=[guid]::NewGuid().ToString();$request=@{id=$id};if($state){$request.state=$state};if($capture){$request.capture=$capture};if($null -ne $prepareTray){$request.prepareTray=[bool]$prepareTray}
  Write-JsonFile (Join-Path $env:NABBIT_ACCEPTANCE_NATIVE_CONTROL "request.json") $request
  for($attempt=0;$attempt -lt 150;$attempt++) {
    if($appProcess.HasExited){throw "Native app exited. See $trialRoot"}
    $response=$null
    try{$response=Get-Content (Join-Path $env:NABBIT_ACCEPTANCE_NATIVE_CONTROL "response.json") -Raw -ErrorAction Stop|ConvertFrom-Json}catch{}
    if($response -and $response.id -eq $id){if($response.hybrid.lastError){throw $response.hybrid.lastError};return $response}
    Start-Sleep -Milliseconds 100
  }
  throw "Native command did not finish. See $trialRoot"
}
function Capture-Native([string]$state,[string]$theme,[string]$scale) {
  $stem="$OutputPrefix-native-$theme@$($scale)x-$state"
  if($ReducedMotion){$stem="$OutputPrefix-native-reduced-$theme@$($scale)x-$state"}
  $result=Command -capture $stem
  & python (Join-Path $root "scripts/encode-native-capture.py") (Join-Path $env:NABBIT_ACCEPTANCE_NATIVE_CONTROL "$stem.bgra") $result.capture.width $result.capture.height $state $theme $scale (Join-Path $root "$OutputDir/$stem.png")
  if($LASTEXITCODE -ne 0){throw "Own-window screenshot verification failed"}
}
function Wait-State([scriptblock]$condition) {for($attempt=0;$attempt -lt 80;$attempt++){$value=Command;if(& $condition $value){return $value};Start-Sleep -Milliseconds 100};throw ("Native state timeout: "+($value|ConvertTo-Json -Depth 6))}
function Assert-True([bool]$value,[string]$message){if(-not $value){throw $message}}
function Process-Family([int]$appId) {
  $all=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,WorkingSetSize)
  $members=@{};$members[$appId]=$true
  do{$added=$false;foreach($entry in $all){if($members.ContainsKey([int]$entry.ParentProcessId) -and -not $members.ContainsKey([int]$entry.ProcessId)){$members[[int]$entry.ProcessId]=$true;$added=$true}}}while($added)
  return @($all|Where-Object {$members.ContainsKey([int]$_.ProcessId)}|ForEach-Object {@{id=[int]$_.ProcessId;name=$_.Name;workingSetBytes=[long]$_.WorkingSetSize}})
}
$appProcess=$null;$reports=@()
$teardown=@()
try {
  $scales=if($ReducedMotion){@("1")}else{@("1","1.5")}
  foreach($scale in $scales) {
    $profile=Join-Path $trialRoot ("scale-"+$scale);New-Item -ItemType Directory -Path $profile|Out-Null
    $env:NABBIT_APP_DATA_DIR=Join-Path $profile "app-data";$env:WEBVIEW2_USER_DATA_FOLDER=Join-Path $profile "webview"
    $env:NABBIT_ACCEPTANCE_NATIVE_CONTROL=Join-Path $profile "control";New-Item -ItemType Directory -Path $env:NABBIT_ACCEPTANCE_NATIVE_CONTROL|Out-Null
    $env:NABBIT_ACCEPTANCE_CURSOR=Join-Path $profile "cursor.json";$env:NABBIT_ACCEPTANCE_NATIVE_SCALE=$scale
    $env:NABBIT_ISLAND_SPIKE="1";$env:NABBIT_ISLAND_RENDERER="native";$env:NABBIT_ACCEPTANCE_REDUCED_MOTION=if($ReducedMotion){"1"}else{"0"};Cursor -1000 1000
    & python (Join-Path $root "spikes/island/seed_acceptance.py") $env:NABBIT_APP_DATA_DIR;if($LASTEXITCODE -ne 0){throw "Seeding failed"}
    $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$listener.Start();$port=$listener.LocalEndpoint.Port;$listener.Stop();$endpoint="http://127.0.0.1:$port"
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$port --remote-debugging-address=127.0.0.1"
    $appProcess=Start-Process -FilePath $exePath -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardError (Join-Path $profile "stderr.log") -PassThru
    $initial=Wait-State {param($r)$r.hybrid.owner -eq "native" -and $r.hybrid.desired -eq "idle"}
    $foreground=[NativeIslandProbe]::GetForegroundWindow()
    $handle=[NativeIslandProbe]::Find($appProcess.Id,"Nabbit Native Island Spike");Assert-True ($handle -ne [IntPtr]::Zero) "Native HWND missing"
    $bounds=[NativeIslandProbe]::Bounds($handle);Assert-True (($bounds.Right-$bounds.Left) -eq 720*[double]$scale -and ($bounds.Bottom-$bounds.Top) -eq 460*[double]$scale) "Unexpected host bounds"
    $flags=[NativeIslandProbe]::GetWindowLongPtr($handle,-20).ToInt64()
    foreach($flag in @(0x08000000,0x00200000,0x00080000,0x80,0x8)){Assert-True (($flags -band $flag) -eq $flag) "Missing native window flag"}
    Assert-True (-not $initial.hybrid.webAllocated) "Idle allocated an island WebView2"
    Assert-True (-not $initial.hybrid.trayAllocated) "Native spike prewarmed the unused tray WebView2"
    Assert-True (-not $initial.hybrid.graphics.bundledFontsLoaded) "Idle eagerly allocated fonts"
    foreach($theme in @("light","dark")) {
      $null=Command "idle";Start-Sleep -Milliseconds 400
      Capture-Native "idle" $theme $scale
      $live=Command "live"
      if($ReducedMotion){Assert-True ($live.hybrid.reducedMotion -and $live.hybrid.geometry.width -eq 320) "Reduced motion must change geometry immediately"}
      Start-Sleep -Milliseconds 450;$live=Command
      Assert-True ($live.hybrid.geometry.width -eq 320 -and -not $live.hybrid.webAllocated) "Compact state must remain native"
      Assert-True $live.hybrid.graphics.bundledFontsLoaded "Native compact did not load bundled Geist faces"
      Capture-Native "live" $theme $scale
      Cursor 360 15;$inside=Wait-State {param($r)$r.interaction.decision.interactive};Assert-True (([NativeIslandProbe]::GetWindowLongPtr($handle,-20).ToInt64() -band 0x20) -eq 0) "Native pill did not accept input"
      Cursor 100 250;$outside=Wait-State {param($r)-not $r.interaction.decision.interactive};Assert-True (([NativeIslandProbe]::GetWindowLongPtr($handle,-20).ToInt64() -band 0x20) -ne 0) "Native margins did not pass clicks through"
      Cursor 360 15 $false 3;$hidden=Wait-State {param($r)$r.interaction.presentation.hidden -and -not $r.hybrid.nativeVisible}
      Assert-True ([NativeIslandProbe]::IsWindowVisible($handle)) "Fullscreen hid the native HWND"
      Capture-Native "fullscreen" $theme $scale
      Cursor -1000 1000;$null=Wait-State {param($r)-not $r.interaction.presentation.hidden}
      $null=Command "idle";Start-Sleep -Milliseconds 400;$before=Command;Start-Sleep -Milliseconds 1100;$after=Command
      Assert-True ($before.hybrid.graphics.commits -eq $after.hybrid.graphics.commits -and $before.hybrid.graphics.surfaceDraws -eq $after.hybrid.graphics.surfaceDraws) "Idle scheduled renderer updates"
      $null=Command "peek";$null=Wait-State {param($r)$r.hybrid.owner -eq "webview" -and $r.hybrid.webAllocated}
      Push-Location $root;try{& node scripts/verify-native-handoff.mjs $endpoint $theme $scale $OutputPrefix $OutputDir;if($LASTEXITCODE -ne 0){throw "Web handoff verification failed"}}finally{Pop-Location}
      $closed=Wait-State {param($r)$r.hybrid.owner -eq "native" -and -not $r.hybrid.webAllocated}
      for($attempt=0;$attempt -lt 50;$attempt++) {if([NativeIslandProbe]::Find($appProcess.Id,"Nabbit Island Spike") -eq [IntPtr]::Zero){break};Start-Sleep -Milliseconds 100}
      Assert-True ([NativeIslandProbe]::Find($appProcess.Id,"Nabbit Island Spike") -eq [IntPtr]::Zero) "Collapsed state retained the island webview"
      Assert-True ([NativeIslandProbe]::GetForegroundWindow() -eq $foreground) "Island handoff changed foreground focus"
      # A held-button fixture enters from below the top band; no real cursor moves.
      Cursor 80 300 $true;Start-Sleep -Milliseconds 650;Cursor 80 10 $true
      $drop=Wait-State {param($r)$r.hybrid.desired -eq "drop" -and $r.hybrid.owner -eq "webview"}
      if($scale -eq "1.5" -and $theme -eq "dark") {
        $fixture=Join-Path $profile "drop-fixture.png"
        Copy-Item -LiteralPath (Join-Path $root "$OutputDir/$OutputPrefix-native-dark@1.5x-idle.png") -Destination $fixture
        Push-Location $root;try{& node scripts/verify-native-hybrid-drop.mjs $endpoint $fixture $OutputPrefix $OutputDir;if($LASTEXITCODE -ne 0){throw "Hybrid native file drop failed"}}finally{Pop-Location}
      }
      Cursor 80 300 $false
      $cancelled=Wait-State {param($r)$r.hybrid.desired -eq "idle" -and -not $r.hybrid.webAllocated}
      $reports+=@{scale=[double]$scale;theme=$theme;initial=$initial.hybrid;live=$live.hybrid;hidden=$hidden.hybrid;restored=$closed.hybrid;drop=$drop.hybrid;cancelled=$cancelled.hybrid;idleCountersStable=$true;noFocusChange=$true;nativeBounds=$bounds;exStyle=('0x{0:X}' -f $flags)}
    }
    $tray=Command -prepareTray $true
    Assert-True $tray.hybrid.trayAllocated "Existing tray factory did not create its window"
    $trayHandle=[NativeIslandProbe]::Find($appProcess.Id,"Nabbit")
    Assert-True ($trayHandle -ne [IntPtr]::Zero -and -not [NativeIslandProbe]::IsWindowVisible($trayHandle)) "Tray factory must preserve its start-hidden policy"
    $tray=Command -prepareTray $false
    $tray=Wait-State {param($r)-not $r.hybrid.trayAllocated}
    Assert-True (-not $tray.hybrid.trayAllocated) "Acceptance tray did not close"
    for($attempt=0;$attempt -lt 20;$attempt++) {
      $family=@(Process-Family $appProcess.Id)
      if(@($family|Where-Object {$_.name -eq 'msedgewebview2.exe'}).Count -eq 0){break}
      Start-Sleep -Milliseconds 500
    }
    Assert-True (@($family|Where-Object {$_.name -eq 'msedgewebview2.exe'}).Count -eq 0) "Collapsed state retained WebView2 child processes after teardown"
    $teardown+=@{scale=[double]$scale;processes=$family;workingSetBytes=[long](($family|Measure-Object workingSetBytes -Sum).Sum);webviewChildren=0}
    Stop-Process -Id $appProcess.Id -Force;$appProcess.WaitForExit();$appProcess=$null
    & python -c 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); assert c.execute("SELECT COUNT(*) FROM downloads").fetchone()[0]==0' (Join-Path $env:NABBIT_APP_DATA_DIR "nabbit.sqlite3")
    if($LASTEXITCODE -ne 0){throw "Island interaction started a download"}
  }
  $reportName=if($ReducedMotion){"$OutputPrefix-native-reduced-checks.json"}else{"$OutputPrefix-native-checks.json"}
  Write-JsonFile (Join-Path $root "$OutputDir/$reportName") @{reports=$reports;postWebviewTeardown=$teardown;executableSha256=(Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash.ToLowerInvariant();capture="Windows.Graphics.Capture CreateForWindow; own HWND only; premultiplied BGRA encoded as transparent PNG";lazyTrayFactory=$true;noDownloadsStarted=$true;realCursorUntouched=$true;displaySettingsUntouched=$true}
  Write-Output "Passed native compact rendering, input/fullscreen policy, idle counters, and lazy WebView2 handoffs in $($reports.Count) contexts."
} finally {
  if($appProcess -and -not $appProcess.HasExited){Stop-Process -Id $appProcess.Id -Force;$appProcess.WaitForExit()}
  foreach($name in $names){
    if($null -eq $original[$name]){Remove-Item -LiteralPath ("Env:"+$name) -ErrorAction SilentlyContinue}
    else{[Environment]::SetEnvironmentVariable($name,$original[$name],"Process")}
  }
}
