param([string]$Exe='src-tauri/target/release/nabbit.exe',[string]$Prefix='v23',[switch]$Activity)
$ErrorActionPreference='Stop'
if($Prefix -notmatch '^[a-z0-9-]+$'){throw 'Invalid evidence prefix'}
$root=Split-Path -Parent $PSScriptRoot;$exePath=(Resolve-Path -LiteralPath (Join-Path $root $Exe)).Path
if(Get-Process -Name nabbit -ErrorAction SilentlyContinue){throw 'Leave the existing Nabbit process untouched.'}
$trial=Join-Path $root ('.tools/island-visibility-'+[guid]::NewGuid());New-Item -ItemType Directory -Path $trial|Out-Null
$folder=Join-Path $root 'progress/v2/M4';New-Item -ItemType Directory -Path $folder -Force|Out-Null
$names=@('NABBIT_APP_DATA_DIR','NABBIT_ISLAND_ACCEPTANCE','NABBIT_ISLAND_LAYOUT','NABBIT_ACCEPTANCE_CURSOR','NABBIT_ACCEPTANCE_COMMAND_DIR','NABBIT_ISLAND_SPIKE','WEBVIEW2_USER_DATA_FOLDER','WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS')
$original=@{};foreach($name in $names){$original[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class IslandVisibilityProbe {
  public delegate bool Callback(IntPtr hwnd,IntPtr param);
  [StructLayout(LayoutKind.Sequential)] public struct Rect {public int Left,Top,Right,Bottom;}
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] public static extern IntPtr Flags(IntPtr hwnd,int index);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback,IntPtr param);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int size);
  public static IntPtr Find(int processId,string title){IntPtr found=IntPtr.Zero;EnumWindows((h,p)=>{uint id;GetWindowThreadProcessId(h,out id);var text=new StringBuilder(256);GetWindowText(h,text,256);if(id==processId&&text.ToString()==title){found=h;return false;}return true;},IntPtr.Zero);return found;}
  public static Rect Bounds(IntPtr hwnd){var old=SetThreadDpiAwarenessContext(new IntPtr(-4));try{Rect value;GetWindowRect(hwnd,out value);return value;}finally{SetThreadDpiAwarenessContext(old);}}
  public static uint Owner(IntPtr hwnd){uint process;GetWindowThreadProcessId(hwnd,out process);return process;}
}
'@
function Assert($value,[string]$message){if(-not $value){throw $message}}
function WriteJson($path,$value){$temporary="$path.tmp";[IO.File]::WriteAllText($temporary,($value|ConvertTo-Json -Depth 30),[Text.UTF8Encoding]::new($false));Move-Item -LiteralPath $temporary -Destination $path -Force}
function Request($fields=@{}){
  $id=[guid]::NewGuid().ToString();$request=@{id=$id};foreach($key in $fields.Keys){$request[$key]=$fields[$key]};WriteJson (Join-Path $env:NABBIT_ACCEPTANCE_COMMAND_DIR 'island-request.json') $request
  for($i=0;$i -lt 200;$i++){$response=$null;try{$response=Get-Content -LiteralPath (Join-Path $env:NABBIT_ACCEPTANCE_COMMAND_DIR 'island-response.json') -Raw -ErrorAction Stop|ConvertFrom-Json}catch{}
    if($response -and $response.id -eq $id){Assert (-not $response.error -and -not $response.snapshot.lastError) "Native error: $($response.error) $($response.snapshot.lastError)";return $response}
    if($appProcess.HasExited){throw "App exited. Logs: $trial"};Start-Sleep -Milliseconds 50
  };throw "Native request timed out. Logs: $trial"
}
function Command($fields=@{}){(Request $fields).snapshot}
function WaitMode($mode,$label='island'){for($i=0;$i -lt 60;$i++){$snapshot=Command;if(($snapshot.visibility|Where-Object label -eq $label).mode -eq $mode){return $snapshot};Start-Sleep -Milliseconds 50};throw ('Visibility timeout: '+($snapshot.visibility|ConvertTo-Json -Depth 5))}
function Cursor($placement,[double]$x,[double]$y){WriteJson $env:NABBIT_ACCEPTANCE_CURSOR @{x=($placement.bounds.x+$x*$placement.renderScale);y=($placement.bounds.y+$y*$placement.renderScale);leftDown=$false}}
function Check($snapshot){foreach($hostInfo in $snapshot.hosts){$handle=[IntPtr][long]$hostInfo.hwnd;$inputInfo=$snapshot.input|Where-Object label -eq $hostInfo.placement.label;$visibility=$snapshot.visibility|Where-Object label -eq $hostInfo.placement.label
  Assert ([IslandVisibilityProbe]::IsWindowVisible($handle)) 'Opacity must never hide the HWND';$flags=[IslandVisibilityProbe]::Flags($handle,-20).ToInt64()
  Assert ((($flags -band 0x20) -eq 0) -eq [bool]$inputInfo.interactive) 'Actual click-through disagrees with applied input'
  if($visibility.mode -ne 'visible'){Assert (($flags -band 0x20) -ne 0 -and -not $inputInfo.interactive) 'Suppressed island must pass clicks through'}
  foreach($flag in @(0x08000000,0x00200000,0x80,0x8)){Assert (($flags -band $flag) -eq $flag) 'Opacity update lost required native style'}
  $b=[IslandVisibilityProbe]::Bounds($handle);$p=$hostInfo.placement.bounds;Assert ($b.Left -eq $p.x -and $b.Top -eq $p.y -and ($b.Right-$b.Left) -eq $p.width -and ($b.Bottom-$b.Top) -eq $p.height) 'Visibility resized or moved the HWND'
};$actual=[IslandVisibilityProbe]::GetForegroundWindow();Assert ([IslandVisibilityProbe]::Owner($actual) -ne $appProcess.Id) 'Visibility activated Nabbit';Assert ($snapshot.inputWatcher.ownForegroundEvents -eq 0) 'Hook observed transient Nabbit activation'
  if($actual -ne $foreground){$foregroundChanges.Add(@{before=$foreground.ToInt64();after=$actual.ToInt64();ownerIsNabbit=$false});$script:foreground=$actual}
}
function ForegroundFixture($monitor,$maximised=$false,$notification=5,$full=$false){@{windowId=42;visible=$true;monitor=$monitor;rect=$(if($full){$monitor}else{@{x=($monitor.x+20);y=($monitor.y+20);width=900;height=700}});maximised=$maximised;notificationState=$notification}}
$appProcess=$null;$reports=@();$foregroundChanges=[Collections.Generic.List[object]]::new()
try{
  $env:NABBIT_APP_DATA_DIR=Join-Path $trial 'app-data';$env:WEBVIEW2_USER_DATA_FOLDER=Join-Path $trial 'webview';$env:NABBIT_ISLAND_ACCEPTANCE='1';Remove-Item Env:NABBIT_ISLAND_SPIKE -ErrorAction SilentlyContinue
  $env:NABBIT_ACCEPTANCE_COMMAND_DIR=Join-Path $trial 'control';New-Item -ItemType Directory -Path $env:NABBIT_ACCEPTANCE_COMMAND_DIR|Out-Null
  $env:NABBIT_ACCEPTANCE_CURSOR=Join-Path $trial 'cursor.json';WriteJson $env:NABBIT_ACCEPTANCE_CURSOR @{x=9000;y=9000;leftDown=$false}
  $env:NABBIT_ISLAND_LAYOUT=Join-Path $trial 'layout.json'
  $primary=@{id='primary';name='Fixture primary';primary=$true;bounds=@{x=0;y=0;width=1920;height=1080};workArea=@{x=0;y=48;width=1920;height=1032};scaleFactor=1}
  $left=@{id='left';name='Fixture left';primary=$false;bounds=@{x=-1920;y=-200;width=1920;height=1080};workArea=@{x=-1920;y=-200;width=1920;height=1032};scaleFactor=1.5}
  $layout=@{monitors=@($primary,$left);cursor=@{x=100;y=200}};WriteJson $env:NABBIT_ISLAND_LAYOUT $layout
  & python (Join-Path $root 'spikes/island/seed_acceptance.py') $env:NABBIT_APP_DATA_DIR;Assert ($LASTEXITCODE -eq 0) 'Seeding failed'
  $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$listener.Start();$port=$listener.LocalEndpoint.Port;$listener.Stop();$endpoint="http://127.0.0.1:$port"
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$port --remote-debugging-address=127.0.0.1"
  $appProcess=Start-Process -FilePath $exePath -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardError (Join-Path $trial 'stderr.log') -PassThru
  $snapshot=Command;$foreground=[IslandVisibilityProbe]::GetForegroundWindow();Assert ($snapshot.webviews -eq 0 -and $snapshot.inputWatcher.hookInstalled) 'Native startup or hook failed'
  foreach($dpi in @(1,1.5)){foreach($shape in @('island','notch')){
    $primary.scaleFactor=$dpi;$prefs=@{enabled=$true;shape=$shape;size='standard';monitorMode='primary';monitorId=$null};$null=Command @{desktop=$layout;preferences=$prefs}
    foreach($mode in @('visible','faded','hidden')){
      $fg=ForegroundFixture $primary.bounds ($mode -eq 'faded') 5 ($mode -eq 'hidden');$null=Command @{foreground=$fg};$snapshot=WaitMode $mode;Check $snapshot
      $stem="$Prefix-native-$shape-$mode-$($dpi.ToString().Replace('.','-'))x";$result=Request @{capture=@{label='island';stem=$stem}}
      & python (Join-Path $root 'scripts/encode-island-visibility-capture.py') (Join-Path $env:NABBIT_ACCEPTANCE_COMMAND_DIR "$stem.bgra") $result.result.width $result.result.height $shape $dpi $mode (Join-Path $folder "$stem.png");Assert ($LASTEXITCODE -eq 0) 'Native opacity capture failed'
      $reports+=@{case='native-opacity';dpi=$dpi;shape=$shape;mode=$mode;snapshot=$snapshot}
    }
  }}
  $primary.scaleFactor=1;$prefs.shape='island';$null=Command @{desktop=$layout;preferences=$prefs};$p=(Command).hosts[0].placement
  foreach($state in @(2,3,4)){$null=Command @{foreground=(ForegroundFixture $primary.bounds $true $state)};$snapshot=WaitMode 'hidden';Check $snapshot;$reports+=@{case='notification';state=$state;snapshot=$snapshot}}
  foreach($property in @('ownProcess','desktop','cloaked','minimised','invisible')){$fg=ForegroundFixture $primary.bounds $true 3;$fg[$property]=$true;if($property -eq 'invisible'){$fg.visible=$false;$fg.Remove('invisible')};$null=Command @{foreground=$fg};$snapshot=WaitMode 'visible';Check $snapshot;$reports+=@{case='ignored-foreground';property=$property;snapshot=$snapshot}}
  $fg=ForegroundFixture $primary.bounds $true 5 $true;$null=Command @{foreground=$fg};$snapshot=WaitMode 'faded';Check $snapshot;$reports+=@{case='maximised-auto-hide-taskbar';snapshot=$snapshot}
  $prefs.monitorMode='all';$null=Command @{preferences=$prefs;foreground=(ForegroundFixture $left.bounds $true)};$snapshot=WaitMode 'faded' 'island-left'
  Assert (($snapshot.visibility|Where-Object label -ne 'island-left').mode -eq 'visible') 'Foreground on another monitor suppressed the primary';Check $snapshot;$reports+=@{case='mixed-dpi-negative-origin-monitor-scope';snapshot=$snapshot}
  $prefs.monitorMode='primary';$null=Command @{preferences=$prefs;foreground=(ForegroundFixture $primary.bounds $true)};$snapshot=WaitMode 'faded';$p=$snapshot.hosts[0].placement
  Cursor $p 360 12;Start-Sleep -Milliseconds 150;$before=Command;Assert ($before.visibility[0].mode -eq 'faded') 'Hover woke before 400ms';Check $before
  $snapshot=WaitMode 'visible';Assert ($snapshot.visibility[0].base -eq 'faded' -and $snapshot.input[0].interactive) 'Hover did not restore input';Check $snapshot
  Cursor $p 80 300;$snapshot=WaitMode 'faded';Check $snapshot;$reports+=@{case='hover-wake-and-leave';before=$before;after=$snapshot}
  $null=Command @{wake='island'};$snapshot=WaitMode 'visible';Check $snapshot;$reports+=@{case='explicit-wake';snapshot=$snapshot}
  $null=Command @{foreground=(ForegroundFixture $primary.bounds $false 3);wake='island'};$snapshot=WaitMode 'hidden';Cursor $p 360 12;Start-Sleep -Milliseconds 650;$snapshot=Command
  Assert ($snapshot.visibility[0].mode -eq 'hidden') 'Fullscreen was overridden by hover or explicit wake';Check $snapshot;$reports+=@{case='fullscreen-forbids-wake';snapshot=$snapshot}
  Cursor $p 80 300;$null=Command @{foreground=(ForegroundFixture $primary.bounds)};$snapshot=WaitMode 'visible';Check $snapshot;$reports+=@{case='fullscreen-exit-restoration';snapshot=$snapshot}
  $prefs.enabled=$false;$null=Command @{preferences=$prefs;foreground=(ForegroundFixture $primary.bounds $false 3)}
  $prefs.enabled=$true;$snapshot=Command @{preferences=$prefs};Assert ($snapshot.visibility[0].mode -eq 'hidden' -and $snapshot.hosts[0].commits -ge 2) 'New hosts must classify and apply opacity before first show';Check $snapshot;$reports+=@{case='new-host-in-fullscreen';snapshot=$snapshot}
  $null=Command @{foreground=(ForegroundFixture $primary.bounds)};$snapshot=WaitMode 'visible'
  $before=$snapshot.inputWatcher.systemSamples;$null=Command @{liveForeground=$true};$snapshot=Command;Assert ($snapshot.inputWatcher.systemSamples -gt $before -and $snapshot.foreground.windowId -ne 42) 'Live Win32 foreground provider did not run';Check $snapshot;$reports+=@{case='read-only-live-provider';snapshot=$snapshot}
  $null=Command @{foreground=(ForegroundFixture $primary.bounds);prepareInput=$true;prepareTray=$true}
  Push-Location $root;try{& node scripts/verify-island-visibility-native.mjs $endpoint $env:NABBIT_ACCEPTANCE_CURSOR $env:NABBIT_ACCEPTANCE_COMMAND_DIR $folder $Prefix;Assert ($LASTEXITCODE -eq 0) 'Actual WebView2 visibility bridge failed'}finally{Pop-Location}
  if($Activity){Push-Location $root;try{& node scripts/verify-island-activity-native.mjs $endpoint $env:NABBIT_ACCEPTANCE_CURSOR $env:NABBIT_ACCEPTANCE_COMMAND_DIR $folder $Prefix $appProcess.Id;Assert ($LASTEXITCODE -eq 0) 'Actual activity bus and reducer failed'}finally{Pop-Location}}
  $snapshot=Command;Check $snapshot;$webHandle=[IslandVisibilityProbe]::Find($appProcess.Id,'Nabbit island input probe')
  Assert ($webHandle -ne [IntPtr]::Zero -and [IslandVisibilityProbe]::IsWindowVisible($webHandle)) 'WebView2 was hidden or destroyed'
  Assert (([IslandVisibilityProbe]::Flags($webHandle,-20).ToInt64() -band 0x08000020) -eq 0x08000020) 'Hidden WebView2 must be nonactivating and click-through'
  $snapshot=Command @{prepareInput=$false;prepareTray=$false};$handles=@($snapshot.hosts.hwnd);$null=Command @{quit=$true};Assert ($appProcess.WaitForExit(15000)) 'Graceful exit failed';$appProcess=$null
  foreach($handle in $handles){Assert (-not [IslandVisibilityProbe]::IsWindow([IntPtr][long]$handle)) 'Exit retained native HWND'}
  & python -c 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); assert c.execute("SELECT COUNT(*) FROM downloads").fetchone()[0]==0' (Join-Path $env:NABBIT_APP_DATA_DIR 'nabbit.sqlite3');Assert ($LASTEXITCODE -eq 0) 'Visibility started a download'
  WriteJson (Join-Path $folder "$Prefix-visibility-checks.json") @{reports=$reports;externalForegroundChanges=@($foregroundChanges.ToArray());nabbitForegroundEvents=0;realCursorUntouched=$true;displaySettingsUntouched=$true;noDownloads=$true;gracefulExit=$true;executableSha256=(Get-FileHash $exePath -Algorithm SHA256).Hash.ToLowerInvariant()}
  Write-Output "Passed $($reports.Count) native visibility scenarios and actual WebView2 opacity/events."
}finally{if($appProcess -and -not $appProcess.HasExited){Stop-Process -Id $appProcess.Id -Force;$appProcess.WaitForExit()};foreach($name in $names){if($null -eq $original[$name]){Remove-Item -LiteralPath ("Env:"+$name) -ErrorAction SilentlyContinue}else{[Environment]::SetEnvironmentVariable($name,$original[$name],'Process')}}}
