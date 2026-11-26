param([string]$Exe='src-tauri/target/release/nabbit.exe',[string]$Prefix='v25-native',[ValidateSet(1,1.5)][double]$Scale=1,[switch]$Keyboard,[switch]$Acceptance)
$ErrorActionPreference='Stop'
if($Keyboard -and $Acceptance){throw 'Select one native driver.'}
if($Prefix -notmatch '^[a-z0-9-]+$'){throw 'Invalid evidence prefix'}
$root=Split-Path -Parent $PSScriptRoot
$exePath=(Resolve-Path -LiteralPath (Join-Path $root $Exe)).Path
if(Get-Process -Name nabbit -ErrorAction SilentlyContinue){throw 'An existing Nabbit process is left untouched.'}
$folder=Join-Path $root 'progress/v2/M5';New-Item -ItemType Directory -Force -Path $folder|Out-Null
if(Test-Path -LiteralPath (Join-Path $folder "$Prefix-surfaces.json")){throw 'Evidence already exists; choose another prefix.'}
$trial=Join-Path $root ('.tools/island-surfaces-'+[guid]::NewGuid());New-Item -ItemType Directory -Path $trial|Out-Null
$names=@('NABBIT_APP_DATA_DIR','NABBIT_ISLAND_ACCEPTANCE','NABBIT_ISLAND_LAYOUT','NABBIT_ACCEPTANCE_COMMAND_DIR','NABBIT_ACCEPTANCE_CURSOR','NABBIT_ISLAND_SPIKE','WEBVIEW2_USER_DATA_FOLDER','WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS')
$original=@{};foreach($name in $names){$original[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SurfaceWindowProbe {
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] public static extern IntPtr Flags(IntPtr hwnd,int index);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd,uint message,IntPtr w,IntPtr l);
 [StructLayout(LayoutKind.Sequential)] public struct Rect {public int left,top,right,bottom;}
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
 public static int[] Bounds(IntPtr hwnd){Rect r;if(!GetWindowRect(hwnd,out r))throw new Exception("GetWindowRect failed");return new[]{r.left,r.top,r.right-r.left,r.bottom-r.top};}
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint process);
 public static uint Owner(IntPtr hwnd){uint process;GetWindowThreadProcessId(hwnd,out process);return process;}
 [DllImport("dwmapi.dll")] static extern int DwmGetCompositionTimingInfo(IntPtr hwnd,IntPtr info);
 public static double RefreshHz(){var info=Marshal.AllocHGlobal(292);try{for(int i=0;i<292;i+=4)Marshal.WriteInt32(info,i,0);Marshal.WriteInt32(info,292);int result=DwmGetCompositionTimingInfo(IntPtr.Zero,info);if(result!=0)Marshal.ThrowExceptionForHR(result);uint n=unchecked((uint)Marshal.ReadInt32(info,4)),d=unchecked((uint)Marshal.ReadInt32(info,8));if(n==0||d==0)throw new Exception("Refresh unavailable");return(double)n/d;}finally{Marshal.FreeHGlobal(info);}}
}
'@
function Assert($condition,$message){if(-not $condition){throw $message}}
function WriteJson($path,$value){[IO.File]::WriteAllText($path,($value|ConvertTo-Json -Depth 40),[Text.UTF8Encoding]::new($false))}
function Command($fields=@{}) {
 $id=[guid]::NewGuid().ToString();$request=@{id=$id};foreach($key in $fields.Keys){$request[$key]=$fields[$key]}
 $path=Join-Path $env:NABBIT_ACCEPTANCE_COMMAND_DIR 'island-request.json';WriteJson "$path.tmp" $request;Move-Item -LiteralPath "$path.tmp" -Destination $path -Force
 for($i=0;$i -lt 200;$i++){
  $response=$null;try{$response=Get-Content -LiteralPath (Join-Path $env:NABBIT_ACCEPTANCE_COMMAND_DIR 'island-response.json') -Raw -ErrorAction Stop|ConvertFrom-Json}catch{}
  if($response -and $response.id -eq $id){Assert (-not $response.error) "Native error: $($response.error)";Assert (-not $response.snapshot.lastError) "Native manager error: $($response.snapshot.lastError)";return $response}
  if($appProcess.HasExited){throw "App exited; logs: $trial"};Start-Sleep -Milliseconds 100
 };throw "Request timeout; logs: $trial"
}
function Mode($mode,$owner=$null){for($i=0;$i -lt 150;$i++){$s=(Command).snapshot;if($s.surfaces.island.state -eq $mode -and ($null -eq $owner -or $s.surfaces.island.webOwner -eq $owner) -and ($owner -ne $false -or $s.webviews -eq 0)){return $s};Start-Sleep -Milliseconds 50};throw "Surface timeout: $mode; logs: $trial"}
function Cursor($x,$y,$left=$false){$path=$env:NABBIT_ACCEPTANCE_CURSOR;WriteJson "$path.tmp" @{x=$x*$Scale;y=$y*$Scale;leftDown=$left};Move-Item -LiteralPath "$path.tmp" -Destination $path -Force}
function ClearActivity {
 $current=(Command).snapshot.activity;$ids=@($current.views|ForEach-Object {@($_.primary)+@($_.bubble)+@($_.queue)}|Where-Object {$_}|ForEach-Object {$_.id}|Select-Object -Unique)
 if($ids.Count){$null=Command @{activity=@($ids|ForEach-Object {@{kind='dismissed';id=$_}})}}
}
function Check($s){
 $actualForeground=[SurfaceWindowProbe]::GetForegroundWindow()
 if($actualForeground -ne $script:focusBaseline){
  $foregroundOwner=[SurfaceWindowProbe]::Owner($actualForeground);$ancestor=$foregroundOwner;$chain=@()
  for($depth=0;$depth -lt 12 -and $ancestor -gt 0;$depth++){
   Assert ($ancestor -ne $appProcess.Id) 'An app-owned window or descendant took foreground focus'
   if($chain -contains $ancestor){break};$chain+=@($ancestor)
   $processInfo=Get-CimInstance Win32_Process -Filter "ProcessId=$ancestor" | Select-Object Name,ProcessId,ParentProcessId
   if(-not $processInfo){break};$ancestor=$processInfo.ParentProcessId
  }
  $script:externalForegroundChanges+=@{before=$script:focusBaseline.ToInt64();after=$actualForeground.ToInt64();owner=$foregroundOwner;ancestorIds=$chain;ownedByApp=$false}
  $script:focusBaseline=$actualForeground
 }
 Assert ($s.inputWatcher.ownForegroundEvents -eq 0) 'Own window foreground event'
 foreach($hostInfo in $s.hosts){
  $handle=[IntPtr][long]$hostInfo.hwnd;Assert ([SurfaceWindowProbe]::Owner($handle) -eq $appProcess.Id) 'Capture HWND is not owned';Assert ([SurfaceWindowProbe]::IsWindowVisible($handle)) 'Native HWND must stay shown'
  $flags=[SurfaceWindowProbe]::Flags($handle,-20).ToInt64();foreach($bit in @(0x08000000,0x00200000,0x00080000,0x80,0x8)){Assert (($flags -band $bit) -eq $bit) "Native style missing: $bit"}
  $expected=$hostInfo.placement.bounds;$actual=[SurfaceWindowProbe]::Bounds($handle)
  Assert ($actual[0] -eq $expected.x -and $actual[1] -eq $expected.y -and $actual[2] -eq $expected.width -and $actual[3] -eq $expected.height) 'Actual native HWND bounds differ'
  Assert ($actual[2] -eq [math]::Round(720*$Scale) -and $actual[3] -eq [math]::Round(460*$Scale)) 'Activity resized native host'
  $web=$s.surfaces.($hostInfo.placement.label)
  if($web.webHwnd){
   $webHandle=[IntPtr][long]$web.webHwnd;Assert ([SurfaceWindowProbe]::Owner($webHandle) -eq $appProcess.Id) 'WebView HWND is not owned'
   # Tao implements skip_taskbar through ITaskbarList::DeleteTab for WebViews.
   $webFlags=[SurfaceWindowProbe]::Flags($webHandle,-20).ToInt64();foreach($bit in @(0x08000000,0x8)){Assert (($webFlags -band $bit) -eq $bit) "WebView style missing: $bit"}
   $webBounds=[SurfaceWindowProbe]::Bounds($webHandle);Assert (($webBounds -join ',') -eq ($actual -join ',')) 'WebView resized or moved away from native host'
  }
 }
}
function Capture($stem){
 $response=Command @{capture=@{label='island';stem=$stem}};$value=$response.result;Check $response.snapshot
 $destination=Join-Path $folder "$Prefix-$stem.png"
 $encoded=& python (Join-Path $root 'scripts/encode-island-surface.py') (Join-Path $env:NABBIT_ACCEPTANCE_COMMAND_DIR "$stem.bgra") $value.width $value.height $destination
 Assert ($LASTEXITCODE -eq 0) 'Owned HWND capture encoding failed'
 return @{file=[IO.Path]::GetFileName($destination);image=($encoded|ConvertFrom-Json);sha256=(Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant();snapshot=$response.snapshot}
}
$appProcess=$null;$records=@();$captures=@();$externalForegroundChanges=@()
try {
 $env:NABBIT_APP_DATA_DIR=Join-Path $trial 'app-data';$env:WEBVIEW2_USER_DATA_FOLDER=Join-Path $trial 'webview';$env:NABBIT_ACCEPTANCE_COMMAND_DIR=Join-Path $trial 'control';New-Item -ItemType Directory -Path $env:NABBIT_ACCEPTANCE_COMMAND_DIR|Out-Null
 $env:NABBIT_ISLAND_ACCEPTANCE='1';Remove-Item Env:NABBIT_ISLAND_SPIKE -ErrorAction SilentlyContinue
 $env:NABBIT_ISLAND_LAYOUT=Join-Path $trial 'layout.json';WriteJson $env:NABBIT_ISLAND_LAYOUT @{monitors=@(@{id='primary';name='Fixture primary';primary=$true;bounds=@{x=0;y=0;width=1920;height=1080};workArea=@{x=0;y=0;width=1920;height=1032};scaleFactor=$Scale});cursor=@{x=120;y=400}}
 $env:NABBIT_ACCEPTANCE_CURSOR=Join-Path $trial 'cursor.json';Cursor 1000 700
 & python (Join-Path $root 'spikes/island/seed_acceptance.py') $env:NABBIT_APP_DATA_DIR;Assert ($LASTEXITCODE -eq 0) 'Seeding failed'
 if($Keyboard){& python (Join-Path $root 'scripts/seed-island-keyboard.py') $env:NABBIT_APP_DATA_DIR;Assert ($LASTEXITCODE -eq 0) 'Keyboard seeding failed'}
 $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$listener.Start();$port=$listener.LocalEndpoint.Port;$listener.Stop();$endpoint="http://127.0.0.1:$port"
 $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$port --remote-debugging-address=127.0.0.1"
 $appProcess=Start-Process -FilePath $exePath -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardError (Join-Path $trial 'stderr.log') -PassThru
 $s=(Command @{gate='visible'}).snapshot
 $focusBaseline=[SurfaceWindowProbe]::GetForegroundWindow();for($i=0;$i -lt 20 -and $focusBaseline -eq [IntPtr]::Zero;$i++){Start-Sleep -Milliseconds 100;$focusBaseline=[SurfaceWindowProbe]::GetForegroundWindow()}
 Assert ($s.inputWatcher.ownForegroundEvents -eq 0) 'Startup activated an island window'
 Check $s;Assert ($s.webviews -eq 0) 'Idle allocated a webview';$records+=@{case='idle';snapshot=$s};$captures+=Capture 'idle'
 if($Acceptance){
  $null=Command @{prepareTray=$true}
  Push-Location $root
  try{& node scripts/verify-island-acceptance-native.mjs $endpoint $env:NABBIT_ACCEPTANCE_CURSOR $env:NABBIT_ACCEPTANCE_COMMAND_DIR $folder $Prefix $appProcess.Id ([SurfaceWindowProbe]::RefreshHz()) ((Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash.ToLowerInvariant());Assert ($LASTEXITCODE -eq 0) 'Native island acceptance failed'}finally{Pop-Location}
  $null=Command @{prepareTray=$false};Cursor 1000 700;$s=Mode 'idle' $false;Check $s;$records+=@{case='acceptance-closed';snapshot=$s}
 }elseif($Keyboard){
  Assert $s.keyboard.injectedFocus 'Focus seam must be injected for automated keyboard runs'
  $null=Command @{shortcut='Alt+Space'};$s=Mode 'expanded' $true;Check $s;$records+=@{case='keyboard-open';snapshot=$s}
  Push-Location $root
  try{& node scripts/verify-island-keyboard-native.mjs $endpoint $env:NABBIT_ACCEPTANCE_CURSOR $env:NABBIT_ACCEPTANCE_COMMAND_DIR $folder $Prefix $appProcess.Id;Assert ($LASTEXITCODE -eq 0) 'Native keyboard flow failed'}finally{Pop-Location}
  Cursor 1000 700;$s=Mode 'idle' $false;Check $s;$records+=@{case='keyboard-closed';snapshot=$s}
 }else{
 $null=Command @{activity=@(@{kind='downloadProgress';jobId='surface-job';title='Tiny tray app in Rust, full walkthrough';percent=38;speed='4.2 MB/s';eta='1:12'})}
 $s=Mode 'live' $false;Start-Sleep -Milliseconds 450;Check $s;Assert ($s.webviews -eq 0) 'Live allocated a webview';$captures+=Capture 'download';$records+=@{case='native-live';snapshot=$s}
 $variants=@(
  @{name='link';event=@{kind='linkDetected';url='https://example.invalid/video';title='Native link fixture';duration=768;site='Fixture'}},
  @{name='media';event=@{kind='mediaChanged';sessionId='fixture-media';title='Night Drive';artist='Kiln';playing=$true;timeline=@{positionS=84;durationS=201};art=$null}},
  @{name='timer';event=@{kind='timerTick';id='fixture-timer';label='Focus';remainingS=1453}},
  @{name='privacy';event=@{kind='privacyChanged';mic=@('Fixture call');camera=@()}},
  @{name='power';event=@{kind='powerChanged';percent=82;charging=$true}},
  @{name='done';event=@{kind='downloadDone';jobId='fixture-done';path='C:\Capture\saved-video.mp4'}},
  @{name='error';event=@{kind='downloadFailed';jobId='fixture-error';error='Unknown'}},
  @{name='note';event=@{kind='noteSaved';cardId='fixture-note';destination='Tack · Inbox'}},
  @{name='moved';event=@{kind='filesMoved';opId='fixture-move';count=3;destination='C:\Capture\Invoices';verb='moved';undoable=$true}},
  @{name='result';event=@{kind='toolResult';jobId='fixture-result';path='C:\Capture\clip.mp4';beforeBytes=42000000;afterBytes=19600000;note='Fits Discord'}},
  @{name='tool';event=@{kind='toolJob';jobId='fixture-tool';toolId='fit';label='Fit for Discord · try 1 of 3';percent=64;state='running'}},
  @{name='volume';event=@{kind='volumeChanged';percent=64;muted=$false}}
 )
 foreach($variant in $variants){ClearActivity;$null=Command @{activity=@($variant.event)};$s=Mode 'live' $false;Start-Sleep -Milliseconds 450;Check $s;Assert ($s.webviews -eq 0) 'A compact variant allocated a WebView';Assert ($s.activity.views[0].primary.event.kind -eq $variant.event.kind) 'Wrong native compact variant';$captures+=Capture $variant.name}
 $download=@{kind='downloadProgress';jobId='surface-job';title='Tiny tray app in Rust, full walkthrough';percent=38;speed='4.2 MB/s';eta='1:12'}
 ClearActivity;$null=Command @{activity=@($download,@{kind='timerTick';id='split-timer';label='Focus';remainingS=1453})};$s=Mode 'live' $false;Start-Sleep -Milliseconds 450;$captures+=Capture 'split'
 ClearActivity;$null=Command @{activity=@($download)};$s=Mode 'live' $false;Start-Sleep -Milliseconds 350
 $placement=$s.hosts[0].placement;$cursorX=($placement.bounds.x/$Scale)+360;$cursorY=($placement.bounds.y/$Scale)+22;Cursor $cursorX $cursorY
 $s=Mode 'peek' $true;Check $s;$records+=@{case='hover-peek';snapshot=$s}
 Push-Location $root
 try{& node scripts/verify-island-surfaces-native.mjs $endpoint $env:NABBIT_ACCEPTANCE_CURSOR $env:NABBIT_ACCEPTANCE_COMMAND_DIR $folder $Prefix $appProcess.Id;Assert ($LASTEXITCODE -eq 0) 'Native WebView surface flow failed'}finally{Pop-Location}
 Cursor 1000 700;$null=Command @{surface=@{label='island';state='live'}};$s=Mode 'live' $false;Check $s
 Assert ($s.webviews -eq 0) 'Closing larger view retained WebView2';$records+=@{case='closed-to-native';snapshot=$s}
 }
 Start-Sleep -Milliseconds 400;$quietBefore=(Command).snapshot;Start-Sleep -Milliseconds 750;$quietAfter=(Command).snapshot
 Assert ($quietBefore.hosts[0].commits -eq $quietAfter.hosts[0].commits) 'Unchanged compact scene kept committing';Assert ($quietAfter.webviews -eq 0) 'Quiet compact scene allocated a WebView'
 $records+=@{case='quiet-native';before=$quietBefore;after=$quietAfter}
 $null=Command @{quit=$true};Assert ($appProcess.WaitForExit(15000)) 'Graceful exit failed';$appProcess=$null
 & python -c 'import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);assert c.execute("SELECT COUNT(*) FROM downloads").fetchone()[0]==0' (Join-Path $env:NABBIT_APP_DATA_DIR 'nabbit.sqlite3');Assert ($LASTEXITCODE -eq 0) 'Smoke started a download'
 $report=@{records=$records;captures=$captures;scale=$Scale;keyboardMode=$Keyboard.IsPresent;acceptanceMode=$Acceptance.IsPresent;executableSha256=(Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash.ToLowerInvariant();isolatedProfile=$true;realCursorUntouched=$true;displaySettingsUntouched=$true;foregroundUnchanged=($externalForegroundChanges.Count -eq 0);externalForegroundChanges=$externalForegroundChanges;noAppOrDescendantActivation=$true;noDownloads=$true;gracefulExit=$true}
 $reportPath=Join-Path $folder "$Prefix-surfaces.json";if(Test-Path -LiteralPath $reportPath){throw 'Evidence already exists'};WriteJson $reportPath $report
 if($Acceptance){Write-Output "Passed native island acceptance flow at $Scale scale."}elseif($Keyboard){Write-Output "Passed native keyboard and focus flow at $Scale scale."}else{Write-Output "Passed native compact / Peek / Expanded / Drop ownership flow at $Scale scale."}
}finally{
 if($appProcess -and -not $appProcess.HasExited){Stop-Process -Id $appProcess.Id -Force;$appProcess.WaitForExit()}
 foreach($name in $names){if($null -eq $original[$name]){Remove-Item -LiteralPath ("Env:"+$name) -ErrorAction SilentlyContinue}else{[Environment]::SetEnvironmentVariable($name,$original[$name],'Process')}}
}
