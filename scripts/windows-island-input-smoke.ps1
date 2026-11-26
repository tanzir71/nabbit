param([string]$Exe='src-tauri/target/release/nabbit.exe',[string]$Prefix='v22')
$ErrorActionPreference='Stop'
if($Prefix -notmatch '^[a-z0-9-]+$'){throw 'Invalid evidence prefix'}
$root=Split-Path -Parent $PSScriptRoot;$exePath=(Resolve-Path -LiteralPath (Join-Path $root $Exe)).Path
if(Get-Process -Name nabbit -ErrorAction SilentlyContinue){throw 'Leave the existing Nabbit process untouched.'}
$trial=Join-Path $root ('.tools/island-input-'+[guid]::NewGuid());New-Item -ItemType Directory -Path $trial|Out-Null
$folder=Join-Path $root 'progress/v2/M4';New-Item -ItemType Directory -Path $folder -Force|Out-Null
$names=@('NABBIT_APP_DATA_DIR','NABBIT_ISLAND_ACCEPTANCE','NABBIT_ISLAND_LAYOUT','NABBIT_ACCEPTANCE_CURSOR','NABBIT_ACCEPTANCE_COMMAND_DIR','NABBIT_ISLAND_SPIKE','WEBVIEW2_USER_DATA_FOLDER','WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS')
$original=@{};foreach($name in $names){$original[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class IslandInputProbe {
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
function WriteJson($path,$value){$temporary="$path.tmp";[IO.File]::WriteAllText($temporary,($value|ConvertTo-Json -Depth 25),[Text.UTF8Encoding]::new($false));Move-Item -LiteralPath $temporary -Destination $path -Force}
function Command($fields=@{}){
  $id=[guid]::NewGuid().ToString();$request=@{id=$id};foreach($key in $fields.Keys){$request[$key]=$fields[$key]};WriteJson (Join-Path $env:NABBIT_ACCEPTANCE_COMMAND_DIR 'island-request.json') $request
  for($i=0;$i -lt 200;$i++){$response=$null;try{$response=Get-Content -LiteralPath (Join-Path $env:NABBIT_ACCEPTANCE_COMMAND_DIR 'island-response.json') -Raw -ErrorAction Stop|ConvertFrom-Json}catch{}
    if($response -and $response.id -eq $id){Assert (-not $response.error -and -not $response.snapshot.lastError) "Native error: $($response.error) $($response.snapshot.lastError)";return $response.snapshot}
    if($appProcess.HasExited){throw "App exited. Logs: $trial"};Start-Sleep -Milliseconds 100
  };throw "Native request timed out. Logs: $trial"
}
function WaitInput([scriptblock]$condition){for($i=0;$i -lt 70;$i++){$snapshot=Command;if(& $condition $snapshot){return $snapshot};Start-Sleep -Milliseconds 50};throw ('Input timeout: '+($snapshot.input|ConvertTo-Json -Depth 8))}
function Cursor($placement,[double]$x,[double]$y,[bool]$down=$false){WriteJson $env:NABBIT_ACCEPTANCE_CURSOR @{x=($placement.bounds.x+$x*$placement.renderScale);y=($placement.bounds.y+$y*$placement.renderScale);leftDown=$down}}
function Check($snapshot){foreach($hostInfo in $snapshot.hosts){$handle=[IntPtr][long]$hostInfo.hwnd;$inputInfo=$snapshot.input|Where-Object label -eq $hostInfo.placement.label
  Assert ([IslandInputProbe]::IsWindowVisible($handle)) 'Host must stay shown/composited';$flags=[IslandInputProbe]::Flags($handle,-20).ToInt64()
  Assert ((($flags -band 0x20) -eq 0) -eq [bool]$inputInfo.interactive) 'Actual click-through style disagrees with input decision'
  foreach($flag in @(0x08000000,0x00200000,0x80,0x8)){Assert (($flags -band $flag) -eq $flag) 'Input update lost required host style'}
  $b=[IslandInputProbe]::Bounds($handle);$p=$hostInfo.placement.bounds;Assert ($b.Left -eq $p.x -and $b.Top -eq $p.y -and ($b.Right-$b.Left) -eq $p.width -and ($b.Bottom-$b.Top) -eq $p.height) 'Input changed HWND bounds'
};$actual=[IslandInputProbe]::GetForegroundWindow();Assert ([IslandInputProbe]::Owner($actual) -ne $appProcess.Id) "Nabbit became foreground: actual=$actual native=$($snapshot.hosts.hwnd -join ',') web=$([IslandInputProbe]::Find($appProcess.Id,'Nabbit island input probe')) main=$([IslandInputProbe]::Find($appProcess.Id,'Nabbit'))";Assert ($snapshot.inputWatcher.ownForegroundEvents -eq 0) 'Foreground hook observed Nabbit activation'
  if($actual -ne $foreground){$foregroundChanges.Add(@{before=$foreground.ToInt64();after=$actual.ToInt64();ownerIsNabbit=$false});$script:foreground=$actual}
}
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
  $snapshot=Command;$foreground=[IslandInputProbe]::GetForegroundWindow();Assert ($snapshot.webviews -eq 0 -and $snapshot.inputWatcher.hookInstalled) 'Native startup or foreground hook failed'
  foreach($dpi in @(1,1.5)){foreach($shape in @('island','notch')){foreach($size in @('small','standard','large')){
    $primary.scaleFactor=$dpi;$prefs=@{enabled=$true;shape=$shape;size=$size;monitorMode='primary';monitorId=$null};$snapshot=Command @{desktop=$layout;preferences=$prefs};$p=$snapshot.hosts[0].placement
    Cursor $p 360 12;$inside=WaitInput {param($s)$s.input[0].interactive};Check $inside
    $r=$inside.input[0].hitrect;Cursor $p ($r.x-1) 12;$outside=WaitInput {param($s)-not $s.input[0].interactive};Check $outside
    $samples=$outside.inputWatcher.cursorSamples;Cursor $p 80 300 $true
    $null=WaitInput {param($s)$s.inputWatcher.cursorSamples -ge $samples+2}
    Cursor $p 80 10 $true;$drag=WaitInput {param($s)$s.input[0].decision.dragging -and $s.input[0].interactive};Check $drag
    Cursor $p 80 120 $true;$held=WaitInput {param($s)$s.input[0].decision.dragging -and $s.input[0].interactive};Check $held
    Cursor $p 80 300;$cancel=WaitInput {param($s)-not $s.input[0].decision.dragging -and -not $s.input[0].interactive};Check $cancel
    $reports+=@{case='native-input';dpi=$dpi;shape=$shape;size=$size;inside=$inside.input;outside=$outside.input;drag=$drag.input;cancel=$cancel.input}
    if($size -eq 'standard'){$stem="$Prefix-native-$shape-$($dpi.ToString().Replace('.','-'))x";$capturePath=Join-Path $env:NABBIT_ACCEPTANCE_COMMAND_DIR "$stem.bgra"
      $captureId=[guid]::NewGuid().ToString();WriteJson (Join-Path $env:NABBIT_ACCEPTANCE_COMMAND_DIR 'island-request.json') @{id=$captureId;capture=@{label='island';stem=$stem}}
      for($j=0;$j -lt 100;$j++){$result=$null;try{$result=Get-Content (Join-Path $env:NABBIT_ACCEPTANCE_COMMAND_DIR 'island-response.json') -Raw|ConvertFrom-Json}catch{};if($result.id -eq $captureId){break};Start-Sleep -Milliseconds 100}
      Assert ($result.id -eq $captureId -and -not $result.error) 'Capture failed'
      & python (Join-Path $root 'scripts/encode-island-lifecycle-capture.py') $capturePath $result.result.width $result.result.height $shape $dpi (Join-Path $folder "$stem.png");Assert ($LASTEXITCODE -eq 0) 'Native geometry changed'
    }
  }}}
  $primary.scaleFactor=1;$prefs=@{enabled=$true;shape='island';size='standard';monitorMode='all';monitorId=$null};$snapshot=Command @{desktop=$layout;preferences=$prefs}
  $p=($snapshot.hosts|Where-Object {$_.placement.monitorId -eq 'left'}).placement;Cursor $p 360 12
  $all=WaitInput {param($s)($s.input|Where-Object interactive).Count -eq 1 -and ($s.input|Where-Object label -eq 'island-left').interactive};Check $all;$reports+=@{case='all-mixed-dpi-negative-origin';snapshot=$all}
  $prefs.monitorMode='primary';$snapshot=Command @{preferences=$prefs};$p=$snapshot.hosts[0].placement;Cursor $p 360 12
  $null=WaitInput {param($s)$s.input[0].interactive};$snapshot=Command @{gate='faded'};$snapshot=WaitInput {param($s)-not $s.input[0].interactive};Check $snapshot;$reports+=@{case='faded-input-gate';snapshot=$snapshot}
  $snapshot=Command @{gate='hidden'};$snapshot=WaitInput {param($s)$s.input[0].decision.hidden -and -not $s.input[0].interactive};Check $snapshot;$reports+=@{case='hidden-input-gate';snapshot=$snapshot}
  $null=Command @{gate='visible'};$null=WaitInput {param($s)$s.input[0].interactive}
  [IO.File]::WriteAllText($env:NABBIT_ACCEPTANCE_CURSOR,'invalid fixture');$snapshot=WaitInput {param($s)-not $s.input[0].interactive};Check $snapshot;$reports+=@{case='invalid-provider-fails-closed';snapshot=$snapshot}
  Cursor $p 80 300;$null=Command @{prepareInput=$true;prepareTray=$true}
  Push-Location $root;try{& node scripts/verify-island-input-native.mjs $endpoint $env:NABBIT_ACCEPTANCE_CURSOR $folder $Prefix;Assert ($LASTEXITCODE -eq 0) 'Actual WebView2 input bridge failed'}finally{Pop-Location}
  $snapshot=WaitInput {param($s)$s.input[0].interactive};Check $snapshot
  $webHandle=[IslandInputProbe]::Find($appProcess.Id,'Nabbit island input probe');Assert ($webHandle -ne [IntPtr]::Zero -and ([IslandInputProbe]::Flags($webHandle,-20).ToInt64() -band 0x20) -eq 0) 'WebView2 surface did not become interactive'
  Assert ([IslandInputProbe]::IsWindowVisible($webHandle) -and ([IslandInputProbe]::Flags($webHandle,-20).ToInt64() -band 0x08000000) -ne 0) 'WebView2 must stay shown and nonactivating'
  Cursor $p 80 400;$snapshot=WaitInput {param($s)-not $s.input[0].interactive};Check $snapshot
  Assert (([IslandInputProbe]::Flags($webHandle,-20).ToInt64() -band 0x20) -ne 0) 'WebView2 margins did not pass clicks through'
  $snapshot=Command @{prepareInput=$false;prepareTray=$false};$snapshot=WaitInput {param($s)$s.input[0].source -eq 'native'};Check $snapshot
  $reports+=@{case='webview-style-and-teardown';snapshot=$snapshot}
  $handles=@($snapshot.hosts.hwnd);$null=Command @{quit=$true};Assert ($appProcess.WaitForExit(15000)) 'Graceful exit failed';$appProcess=$null
  foreach($handle in $handles){Assert (-not [IslandInputProbe]::IsWindow([IntPtr][long]$handle)) 'Exit retained native HWND'}
  & python -c 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); assert c.execute("SELECT COUNT(*) FROM downloads").fetchone()[0]==0' (Join-Path $env:NABBIT_APP_DATA_DIR 'nabbit.sqlite3');Assert ($LASTEXITCODE -eq 0) 'Input started a download'
  WriteJson (Join-Path $folder "$Prefix-input-checks.json") @{reports=$reports;foregroundUnchanged=($foregroundChanges.Count -eq 0);externalForegroundChanges=@($foregroundChanges.ToArray());nabbitForegroundEvents=0;realCursorUntouched=$true;displaySettingsUntouched=$true;noDownloads=$true;gracefulExit=$true;executableSha256=(Get-FileHash $exePath -Algorithm SHA256).Hash.ToLowerInvariant()}
  Write-Output "Passed production hit rectangles, adaptive cursor input, drag band, gates, multi-monitor styles and actual WebView2 IPC."
}finally{if($appProcess -and -not $appProcess.HasExited){Stop-Process -Id $appProcess.Id -Force;$appProcess.WaitForExit()};foreach($name in $names){if($null -eq $original[$name]){Remove-Item -LiteralPath ("Env:"+$name) -ErrorAction SilentlyContinue}else{[Environment]::SetEnvironmentVariable($name,$original[$name],'Process')}}}
