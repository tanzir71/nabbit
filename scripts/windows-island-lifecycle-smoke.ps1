param([string]$Exe="src-tauri/target/release/nabbit.exe",[string]$Prefix="v21")
$ErrorActionPreference="Stop"
if($Prefix -notmatch '^[a-z0-9-]+$'){throw "Invalid evidence prefix"}
$root=Split-Path -Parent $PSScriptRoot
$exePath=(Resolve-Path -LiteralPath (Join-Path $root $Exe)).Path
if(Get-Process -Name nabbit -ErrorAction SilentlyContinue){throw "Leave the existing Nabbit process untouched."}
$folder=Join-Path $root 'progress/v2/M4';New-Item -ItemType Directory -Path $folder -Force|Out-Null
$trial=Join-Path $root ('.tools/island-lifecycle-'+[guid]::NewGuid());New-Item -ItemType Directory -Path $trial|Out-Null
$names=@('NABBIT_APP_DATA_DIR','NABBIT_ISLAND_ACCEPTANCE','NABBIT_ISLAND_LAYOUT','NABBIT_ACCEPTANCE_COMMAND_DIR','NABBIT_ISLAND_SPIKE','WEBVIEW2_USER_DATA_FOLDER','WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS')
$original=@{};foreach($name in $names){$original[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class IslandLifecycleProbe {
  [StructLayout(LayoutKind.Sequential)] public struct Rect {public int Left,Top,Right,Bottom;}
  [StructLayout(LayoutKind.Sequential)] struct Message {public IntPtr Hwnd;public uint Id;public UIntPtr W;public IntPtr L;public uint Time;public int X,Y;public uint Private;}
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] public static extern IntPtr Flags(IntPtr hwnd,int index);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd,uint message,IntPtr w,IntPtr l);
  [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW")] static extern IntPtr SendRect(IntPtr hwnd,uint message,UIntPtr w,ref Rect rect,uint flags,uint timeout,out UIntPtr result);
  [DllImport("user32.dll",EntryPoint="SendMessageTimeoutW")] static extern IntPtr SendValue(IntPtr hwnd,uint message,UIntPtr w,IntPtr l,uint flags,uint timeout,out UIntPtr result);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateWindowEx(uint ex,string cls,string title,uint style,int x,int y,int width,int height,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr param);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd,int show);
  [DllImport("user32.dll")] static extern int GetMessage(out Message message,IntPtr hwnd,uint min,uint max);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref Message message);
  [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr hwnd);
  public static IntPtr Helper;
  public static void StartHelper(){
    var ready=new ManualResetEvent(false);
    var thread=new Thread(()=>{Helper=CreateWindowEx(0,"STATIC","Nabbit isolated focus fixture",0x10CF0000,20,160,300,180,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);ShowWindow(Helper,5);SetForegroundWindow(Helper);ready.Set();Message m;while(GetMessage(out m,IntPtr.Zero,0,0)>0){if(m.Id==0x10){DestroyWindow(Helper);break;}DispatchMessage(ref m);}});
    thread.IsBackground=true;thread.Start();ready.WaitOne();
  }
  public static Rect Bounds(IntPtr hwnd){var old=SetThreadDpiAwarenessContext(new IntPtr(-4));try{Rect value;GetWindowRect(hwnd,out value);return value;}finally{SetThreadDpiAwarenessContext(old);}}
  public static bool SystemEvent(IntPtr hwnd,uint message){UIntPtr result;if(message==0x2E0){var rect=Bounds(hwnd);return SendRect(hwnd,message,new UIntPtr((144u<<16)|144u),ref rect,2,3000,out result)!=IntPtr.Zero;}return SendValue(hwnd,message,UIntPtr.Zero,IntPtr.Zero,2,3000,out result)!=IntPtr.Zero;}
}
'@
function Assert($condition,[string]$message){if(-not $condition){throw $message}}
function WriteJson($path,$value){[IO.File]::WriteAllText($path,($value|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))}
function Command($fields=@{}){
  $id=[guid]::NewGuid().ToString();$request=@{id=$id};foreach($key in $fields.Keys){$request[$key]=$fields[$key]}
  $path=Join-Path $env:NABBIT_ACCEPTANCE_COMMAND_DIR 'island-request.json'
  # Atomic rename keeps the acceptance reader from observing partial JSON.
  WriteJson "$path.tmp" $request;Move-Item -LiteralPath "$path.tmp" -Destination $path -Force
  for($i=0;$i -lt 200;$i++){
    $response=$null;try{$response=Get-Content -LiteralPath (Join-Path $env:NABBIT_ACCEPTANCE_COMMAND_DIR 'island-response.json') -Raw -ErrorAction Stop|ConvertFrom-Json}catch{}
    if($response -and $response.id -eq $id){Assert (-not $response.error) "Native error: $($response.error)";Assert (-not $response.snapshot.lastError) "Reconcile error: $($response.snapshot.lastError)";return $response}
    if($appProcess.HasExited){throw "App exited unexpectedly. Logs: $trial"};Start-Sleep -Milliseconds 100
  };throw "Island request timeout. Logs: $trial"
}
function Preferences($shape='island',$size='standard',$mode='followMouse',$monitor=$null,$enabled=$true){return @{shape=$shape;size=$size;monitorMode=$mode;monitorId=$monitor;enabled=$enabled}}
function Monitor([string]$id,[int]$x,[int]$y,[int]$width,[int]$height,[double]$scale,[bool]$primary=$false){return @{id=$id;name="Fixture $id";primary=$primary;bounds=@{x=$x;y=$y;width=$width;height=$height};workArea=@{x=$x;y=$y;width=$width;height=($height-48)};scaleFactor=$scale}}
function CheckHosts($snapshot){
  foreach($hostInfo in $snapshot.hosts){
    $handle=[IntPtr][long]$hostInfo.hwnd;Assert ([IslandLifecycleProbe]::IsWindow($handle)) "Host HWND missing";Assert ([IslandLifecycleProbe]::IsWindowVisible($handle)) "Host must stay shown"
    $flags=[IslandLifecycleProbe]::Flags($handle,-20).ToInt64();foreach($flag in @(0x08000000,0x00200000,0x00080000,0x80,0x8,0x20)){Assert (($flags -band $flag) -eq $flag) "Missing host style $flag"};Assert (($flags -band 0x40000) -eq 0) "Island has taskbar app style"
    $actual=[IslandLifecycleProbe]::Bounds($handle);$expected=$hostInfo.placement.bounds
    Assert ($actual.Left -eq $expected.x -and $actual.Top -eq $expected.y -and ($actual.Right-$actual.Left) -eq $expected.width -and ($actual.Bottom-$actual.Top) -eq $expected.height) "Actual HWND bounds disagree with placement"
    Assert ([IslandLifecycleProbe]::GetForegroundWindow() -eq $focusBaseline) "Island changed foreground focus"
  }
}
$appProcess=$null;$reports=@();$captures=@()
try{
  $env:NABBIT_APP_DATA_DIR=Join-Path $trial 'app-data';$env:WEBVIEW2_USER_DATA_FOLDER=Join-Path $trial 'webview'
  $env:NABBIT_ACCEPTANCE_COMMAND_DIR=Join-Path $trial 'control';New-Item -ItemType Directory -Path $env:NABBIT_ACCEPTANCE_COMMAND_DIR|Out-Null
  $env:NABBIT_ISLAND_ACCEPTANCE='1';Remove-Item Env:NABBIT_ISLAND_SPIKE -ErrorAction SilentlyContinue
  $env:NABBIT_ISLAND_LAYOUT=Join-Path $trial 'layout.json'
  $left=Monitor 'left' -1920 -200 1920 1080 1;$primary=Monitor 'primary' 0 0 1920 1080 1.5 $true
  $layout=@{monitors=@($left,$primary);cursor=@{x=120;y=400}};WriteJson $env:NABBIT_ISLAND_LAYOUT $layout
  & python (Join-Path $root 'spikes/island/seed_acceptance.py') $env:NABBIT_APP_DATA_DIR;Assert ($LASTEXITCODE -eq 0) 'Seeding failed'
  $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$listener.Start();$port=$listener.LocalEndpoint.Port;$listener.Stop();$endpoint="http://127.0.0.1:$port"
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$port --remote-debugging-address=127.0.0.1"
  $appProcess=Start-Process -FilePath $exePath -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardError (Join-Path $trial 'stderr.log') -PassThru
  $initial=(Command).snapshot
  Assert ($initial.hosts.Count -eq 1 -and $initial.hosts[0].placement.monitorId -eq 'primary') 'Default follow mouse placement failed'
  Assert ($initial.webviews -eq 0) 'Collapsed startup created a WebView2'
  $children=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($appProcess.Id)" | Select-Object Name,ProcessId)
  Assert (@($children|Where-Object Name -eq 'msedgewebview2.exe').Count -eq 0) 'Collapsed startup spawned a WebView2 child'
  $startup=@{workingSetBytes=$appProcess.WorkingSet64;children=$children;webviews=0}
  [IslandLifecycleProbe]::StartHelper()
  Start-Sleep -Milliseconds 200
  Assert ([IslandLifecycleProbe]::IsWindow([IslandLifecycleProbe]::Helper)) 'Owned helper window missing'
  $focusBaseline=[IslandLifecycleProbe]::GetForegroundWindow();$helperFocused=$focusBaseline -eq [IslandLifecycleProbe]::Helper
  if(-not $helperFocused){Write-Output 'Windows foreground lock denied helper activation; checking the actual foreground HWND stays unchanged, plus WS_EX_NOACTIVATE on every host.'}
  CheckHosts $initial;$firstHandle=$initial.hosts[0].hwnd
  $systemEvents=@()
  foreach($message in @(0x7E,0x2E0,0x1A)){
    $before=(Command).snapshot
    Assert ([IslandLifecycleProbe]::SystemEvent([IntPtr][long]$firstHandle,$message)) "Could not deliver owned-window system event $message"
    Start-Sleep -Milliseconds 200;$after=(Command).snapshot;CheckHosts $after
    Assert ($after.reconciliations -ge $before.reconciliations+2 -and $after.hosts[0].commits -eq $before.hosts[0].commits) "System event $message did not reconcile without repainting unchanged geometry: before=$($before.reconciliations)/$($before.hosts[0].commits), after=$($after.reconciliations)/$($after.hosts[0].commits)"
    $systemEvents+=@{message=$message;reconciled=$true;commitsUnchanged=$true}
  }
  foreach($scale in @(1,1.5)){
    $primary.scaleFactor=$scale
    foreach($shape in @('island','notch')){foreach($size in @('small','standard','large')){
      $prefs=Preferences $shape $size 'primary';$snapshot=(Command @{desktop=$layout;preferences=$prefs}).snapshot;CheckHosts $snapshot
      Assert ($snapshot.hosts[0].hwnd -eq $firstHandle) 'Shape/size/DPI change recreated the singleton HWND'
      $factor=@{small=.9;standard=1;large=1.15}[$size]*$scale
      Assert ($snapshot.hosts[0].placement.bounds.width -eq [Math]::Round(720*$factor)) 'Size and DPI did not compose'
      foreach($theme in @('light','dark')){
        $stem="$Prefix-native-$shape-$size-$theme-$($scale.ToString().Replace('.','-'))x"
        Start-Sleep -Milliseconds 180
        $capture=Command @{capture=@{label='island';stem=$stem}}
        & python (Join-Path $root 'scripts/encode-island-lifecycle-capture.py') (Join-Path $env:NABBIT_ACCEPTANCE_COMMAND_DIR "$stem.bgra") $capture.result.width $capture.result.height $shape $factor (Join-Path $folder "$stem.png")
        Assert ($LASTEXITCODE -eq 0) 'Native screenshot geometry verification failed';$captures+=@{file="$stem.png";shape=$shape;size=$size;dpi=$scale;theme=$theme}
      }
      $reports+=@{case='shape-size-dpi';snapshot=$snapshot}
    }}
  }
  $follow=Preferences
  $layout.cursor=@{x=-100;y=0};$snapshot=(Command @{desktop=$layout;preferences=$follow}).snapshot;CheckHosts $snapshot
  Assert ($snapshot.hosts[0].hwnd -eq $firstHandle -and $snapshot.hosts[0].placement.monitorId -eq 'left' -and $snapshot.hosts[0].placement.bounds.x -eq -1320) 'Follow mouse did not move singleton across negative-origin mixed DPI layout'
  $reports+=@{case='follow-mouse';snapshot=$snapshot}
  $layout.topTaskbar=@{x=-1920;y=-200;width=1920;height=40};$snapshot=(Command @{desktop=$layout}).snapshot;CheckHosts $snapshot;Assert ($snapshot.hosts[0].placement.bounds.y -eq -160) 'Top taskbar was ignored'
  $reports+=@{case='top-taskbar';snapshot=$snapshot};$layout.Remove('topTaskbar')
  $all=Preferences 'notch' 'standard' 'all';$snapshot=(Command @{desktop=$layout;preferences=$all}).snapshot;CheckHosts $snapshot
  Assert (($snapshot.hosts.placement.label -join ',') -eq 'island-left,island-primary') 'All mode labels failed';$allHandles=@($snapshot.hosts.hwnd)
  $reports+=@{case='all';snapshot=$snapshot}
  $layout.monitors=@($primary);$snapshot=(Command @{desktop=$layout}).snapshot;CheckHosts $snapshot;Assert ($snapshot.hosts.Count -eq 1 -and $snapshot.hosts[0].placement.label -eq 'island-primary') 'Removed monitor retained host'
  Assert (-not [IslandLifecycleProbe]::IsWindow([IntPtr][long]$allHandles[0])) 'Removed monitor HWND leaked'
  $specific=Preferences 'notch' 'large' 'specific' 'left';$snapshot=(Command @{preferences=$specific}).snapshot;CheckHosts $snapshot
  Assert ($snapshot.hosts[0].placement.monitorId -eq 'primary' -and $snapshot.preferences.monitorId -eq 'left') 'Specific monitor fallback lost preference'
  $reports+=@{case='specific-fallback';snapshot=$snapshot}
  $layout.monitors=@($left,$primary);$snapshot=(Command @{desktop=$layout}).snapshot;CheckHosts $snapshot;Assert ($snapshot.hosts[0].placement.monitorId -eq 'left') 'Reattached specific monitor not restored'
  $reports+=@{case='reattach';snapshot=$snapshot}
  $before=$snapshot.hosts[0];Start-Sleep -Milliseconds 1200;$snapshot=(Command).snapshot
  Assert ($snapshot.hosts[0].commits -eq $before.commits) 'Unchanged layout rendered idle frames'
  $off=Preferences 'notch' 'large' 'specific' 'left' $false;$snapshot=(Command @{preferences=$off}).snapshot
  Assert ($snapshot.hosts.Count -eq 0 -and -not [IslandLifecycleProbe]::IsWindow([IntPtr][long]$before.hwnd)) 'Disable retained island window'
  $snapshot=(Command @{preferences=$specific}).snapshot;CheckHosts $snapshot
  # Real WebView2 IPC → SQLite → native hosts, using only the isolated profile.
  $null=Command @{prepareTray=$true};Push-Location $root
  try{& node scripts/verify-island-settings-native.mjs $endpoint $folder $Prefix;Assert ($LASTEXITCODE -eq 0) 'Actual settings IPC flow failed'}finally{Pop-Location}
  $snapshot=(Command).snapshot;CheckHosts $snapshot
  Assert ($snapshot.preferences.shape -eq 'notch' -and $snapshot.preferences.size -eq 'small' -and $snapshot.preferences.monitorMode -eq 'all' -and $snapshot.hosts.Count -eq 2) 'UI preferences did not reach native manager'
  $reports+=@{case='actual-ui-ipc';snapshot=$snapshot}
  $null=Command @{prepareTray=$false};$null=Command @{quit=$true};Assert ($appProcess.WaitForExit(15000)) 'Graceful exit failed';$appProcess=$null
  $appProcess=Start-Process -FilePath $exePath -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardError (Join-Path $trial 'restart-stderr.log') -PassThru
  $snapshot=(Command).snapshot;CheckHosts $snapshot;Assert ($snapshot.preferences.shape -eq 'notch' -and $snapshot.preferences.size -eq 'small' -and $snapshot.hosts.Count -eq 2 -and $snapshot.webviews -eq 0) 'Restart did not restore preferences'
  $handles=@($snapshot.hosts.hwnd);$reports+=@{case='restart';snapshot=$snapshot};$null=Command @{quit=$true};Assert ($appProcess.WaitForExit(15000)) 'Restart graceful exit failed';$appProcess=$null
  foreach($handle in $handles){Assert (-not [IslandLifecycleProbe]::IsWindow([IntPtr][long]$handle)) 'Exit retained HWND'}
  # Exercise the real Win32 monitor provider on this machine as a read-only
  # enumeration, in addition to the multi-monitor/DPI fixture matrix.
  Remove-Item Env:NABBIT_ISLAND_LAYOUT
  $appProcess=Start-Process -FilePath $exePath -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardError (Join-Path $trial 'real-provider-stderr.log') -PassThru
  $snapshot=(Command).snapshot;CheckHosts $snapshot
  Assert ($snapshot.desktop.monitors.Count -gt 0 -and $snapshot.hosts.Count -eq $snapshot.desktop.monitors.Count) 'Real monitor provider did not create all hosts'
  foreach($monitor in $snapshot.desktop.monitors){Assert ($monitor.id -match '^[a-f0-9]{16}$' -and $monitor.scaleFactor -gt 0) 'Real display identity or DPI invalid'}
  $reports+=@{case='real-monitor-provider';snapshot=$snapshot};$null=Command @{quit=$true};Assert ($appProcess.WaitForExit(15000)) 'Real provider graceful exit failed';$appProcess=$null
  & python -c 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); assert c.execute("SELECT COUNT(*) FROM downloads").fetchone()[0]==0' (Join-Path $env:NABBIT_APP_DATA_DIR 'nabbit.sqlite3');Assert ($LASTEXITCODE -eq 0) 'Smoke started a download'
  WriteJson (Join-Path $folder "$Prefix-lifecycle-checks.json") @{reports=$reports;startup=$startup;systemEvents=$systemEvents;captures=$captures;executableSha256=(Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash.ToLowerInvariant();foregroundUnchanged=$true;helperFocused=$helperFocused;focusLimitation= $(if($helperFocused){$null}else{'Windows denied SetForegroundWindow for the owned helper; actual foreground HWND and nonactivation styles checked throughout.'});noDownloads=$true;realCursorUntouched=$true;displaySettingsUntouched=$true;capture='Windows.Graphics.Capture exact owned HWND; premultiplied BGRA to transparent PNG; theme names are comparison metadata, native surface always dark';isolatedProfile=$true;gracefulExit=$true}
  Write-Output "Passed native island lifecycle, monitor fixtures, real settings IPC, persistence and 24 HWND screenshots."
}finally{
  if($appProcess -and -not $appProcess.HasExited){Stop-Process -Id $appProcess.Id -Force;$appProcess.WaitForExit()}
  if([IslandLifecycleProbe]::Helper -ne [IntPtr]::Zero){[IslandLifecycleProbe]::PostMessage([IslandLifecycleProbe]::Helper,0x10,[IntPtr]::Zero,[IntPtr]::Zero)|Out-Null}
  foreach($name in $names){if($null -eq $original[$name]){Remove-Item -LiteralPath ("Env:"+$name) -ErrorAction SilentlyContinue}else{[Environment]::SetEnvironmentVariable($name,$original[$name],'Process')}}
}
