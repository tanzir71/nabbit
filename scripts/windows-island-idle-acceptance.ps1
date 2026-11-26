param([string]$Exe='src-tauri/target/release/nabbit.exe',[string]$Prefix='v27-idle')
$ErrorActionPreference='Stop'
if($Prefix -notmatch '^[a-z0-9-]+$'){throw 'Invalid evidence prefix'}
$root=Split-Path -Parent $PSScriptRoot
$exePath=(Resolve-Path -LiteralPath (Join-Path $root $Exe)).Path
if(Get-Process -Name nabbit -ErrorAction SilentlyContinue){throw 'An existing Nabbit process is left untouched.'}
$output=Join-Path $root "progress/v2/M5/$Prefix.json"
if(Test-Path -LiteralPath $output){throw 'Evidence exists; use another prefix.'}
$trial=Join-Path $root ('.tools/island-idle-'+[guid]::NewGuid())
New-Item -ItemType Directory -Path $trial|Out-Null
$names=@('NABBIT_APP_DATA_DIR','NABBIT_ISLAND_ACCEPTANCE','NABBIT_ISLAND_LAYOUT','NABBIT_ACCEPTANCE_COMMAND_DIR','NABBIT_ACCEPTANCE_CURSOR','NABBIT_ACCEPTANCE_CURSOR_STATIC','NABBIT_ISLAND_SPIKE','WEBVIEW2_USER_DATA_FOLDER','WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS')
$original=@{};foreach($name in $names){$original[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public sealed class IdleCpuHandle : IDisposable {
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int id);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle,out long created,out long exited,out long kernel,out long user);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 readonly IntPtr handle;
 public IdleCpuHandle(int id){handle=OpenProcess(0x1000,false,id);if(handle==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}
 public double CpuSeconds(){long c,e,k,u;if(!GetProcessTimes(handle,out c,out e,out k,out u))throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());return(k+u)/10000000.0;}
 public void Dispose(){CloseHandle(handle);}
}
public static class IdleWindowProbe {
 public delegate bool EnumCallback(IntPtr hwnd,IntPtr param);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback,IntPtr param);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int count);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
 [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] public static extern IntPtr Flags(IntPtr hwnd,int index);
 [DllImport("dwmapi.dll")] static extern int DwmGetCompositionTimingInfo(IntPtr hwnd,IntPtr info);
 [DllImport("kernel32.dll")] static extern IntPtr OpenThread(uint access,bool inherit,uint id);
 [DllImport("kernel32.dll")] static extern int GetThreadDescription(IntPtr thread,out IntPtr text);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 public static string ThreadName(uint id){var handle=OpenThread(0x800,false,id);if(handle==IntPtr.Zero)return "unavailable";try{IntPtr text;int result=GetThreadDescription(handle,out text);if(result<0)return "unavailable";try{return Marshal.PtrToStringUni(text);}finally{LocalFree(text);}}finally{CloseHandle(handle);}}
 public static IntPtr Find(int id){IntPtr found=IntPtr.Zero;EnumWindows((hwnd,p)=>{uint owner;GetWindowThreadProcessId(hwnd,out owner);if(owner!=id)return true;var text=new StringBuilder(256);GetWindowText(hwnd,text,256);if(text.ToString()!="Nabbit island · island")return true;found=hwnd;return false;},IntPtr.Zero);return found;}
 public static double[] Refresh(){var info=Marshal.AllocHGlobal(292);try{for(int i=0;i<292;i+=4)Marshal.WriteInt32(info,i,0);Marshal.WriteInt32(info,292);int result=DwmGetCompositionTimingInfo(IntPtr.Zero,info);if(result!=0)Marshal.ThrowExceptionForHR(result);uint n=unchecked((uint)Marshal.ReadInt32(info,4)),d=unchecked((uint)Marshal.ReadInt32(info,8));if(n==0||d==0)throw new Exception("No DWM refresh rate");return new[]{(double)n,d,(double)n/d};}finally{Marshal.FreeHGlobal(info);}}
}
'@
function Json($path,$value){[IO.File]::WriteAllText($path,($value|ConvertTo-Json -Depth 30)+"`n",[Text.UTF8Encoding]::new($false))}
$appProcess=$null;$handles=@{};$initial=@{};$entries=@{};$samples=[Collections.Generic.List[object]]::new()
try{
 $env:NABBIT_APP_DATA_DIR=Join-Path $trial 'app-data';$env:NABBIT_ISLAND_ACCEPTANCE='1';$env:WEBVIEW2_USER_DATA_FOLDER=Join-Path $trial 'webview'
 foreach($name in @('NABBIT_ISLAND_SPIKE','NABBIT_ACCEPTANCE_COMMAND_DIR','WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS')){Remove-Item -LiteralPath ("Env:"+$name) -ErrorAction SilentlyContinue}
 $env:NABBIT_ISLAND_LAYOUT=Join-Path $trial 'layout.json';Json $env:NABBIT_ISLAND_LAYOUT @{monitors=@(@{id='primary';name='Idle fixture';primary=$true;bounds=@{x=0;y=0;width=1920;height=1080};workArea=@{x=0;y=0;width=1920;height=1032};scaleFactor=1});cursor=@{x=1000;y=700}}
 $env:NABBIT_ACCEPTANCE_CURSOR=Join-Path $trial 'cursor.json';Json $env:NABBIT_ACCEPTANCE_CURSOR @{x=1000;y=700;leftDown=$false};$env:NABBIT_ACCEPTANCE_CURSOR_STATIC='1'
 & python (Join-Path $root 'spikes/island/seed_acceptance.py') $env:NABBIT_APP_DATA_DIR
 if($LASTEXITCODE -ne 0){throw 'Fixture seeding failed'}
 $appProcess=Start-Process -FilePath $exePath -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardError (Join-Path $trial 'stderr.log') -PassThru
 $hwnd=[IntPtr]::Zero
 for($i=0;$i -lt 150;$i++){$hwnd=[IdleWindowProbe]::Find($appProcess.Id);if($hwnd -ne [IntPtr]::Zero -and [IdleWindowProbe]::IsWindowVisible($hwnd)){break};if($appProcess.HasExited){throw 'App exited during startup'};Start-Sleep -Milliseconds 100}
 if($hwnd -eq [IntPtr]::Zero){throw 'Production island HWND missing'}
 $flags=[IdleWindowProbe]::Flags($hwnd,-20).ToInt64();if(($flags -band 0x08000000) -eq 0){throw 'WS_EX_NOACTIVATE missing'}
 $refresh=[IdleWindowProbe]::Refresh();$dpi=[IdleWindowProbe]::GetDpiForWindow($hwnd)
 Write-Output 'Production idle: settling 20 seconds, CDP/tracing/command polling disabled.'
 Start-Sleep -Seconds 20
 $clock=[Diagnostics.Stopwatch]::StartNew();$foregroundChanges=@();$previousForeground=[IdleWindowProbe]::GetForegroundWindow();$threadStart=@{}
 $appProcess.Refresh();foreach($thread in $appProcess.Threads){$threadStart[$thread.Id]=$thread.TotalProcessorTime.TotalSeconds}
 do{
  if($appProcess.HasExited){throw 'App exited during sampling'}
  $all=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate,WorkingSetSize)
  $members=@{};$members[$appProcess.Id]=$true
  do{$added=$false;foreach($entry in $all){if(-not $members.ContainsKey([int]$entry.ProcessId) -and $members.ContainsKey([int]$entry.ParentProcessId)){$members[[int]$entry.ProcessId]=$true;$added=$true}}}while($added)
  $family=@($all|Where-Object {$members.ContainsKey([int]$_.ProcessId)})
  if(-not @($family|Where-Object {$_.ProcessId -eq $appProcess.Id}).Count){throw 'App missing from process snapshot'}
  $live=@{}
  foreach($entry in $family){$key="$($entry.ProcessId)/$($entry.CreationDate.ToUniversalTime().ToString('o'))";if(-not $handles.ContainsKey($key)){$handles[$key]=[IdleCpuHandle]::new($entry.ProcessId);$initial[$key]=0.0;if($samples.Count -eq 0){$initial[$key]=$handles[$key].CpuSeconds()}};$entries[$key]=$entry;$live[$key]=$true}
  $cpu=0.0;$processes=@()
  foreach($key in $handles.Keys){$entry=$entries[$key];$time=$handles[$key].CpuSeconds();$cpu+=$time-$initial[$key];$processes+=@{id=$entry.ProcessId;parent=$entry.ParentProcessId;name=$entry.Name;cpuSeconds=$time;present=$live.ContainsKey($key);workingSetBytes=$(if($live.ContainsKey($key)){[long]$entry.WorkingSetSize}else{0})}}
  $foreground=[IdleWindowProbe]::GetForegroundWindow()
  if($foreground -ne $previousForeground){[uint32]$ownerId=0;$null=[IdleWindowProbe]::GetWindowThreadProcessId($foreground,[ref]$ownerId);$foregroundChanges+=@{before=$previousForeground.ToInt64();after=$foreground.ToInt64();owner=$ownerId;ownedByApp=$members.ContainsKey([int]$ownerId)};$previousForeground=$foreground}
  $samples.Add(@{elapsedMs=$clock.Elapsed.TotalMilliseconds;totalCpuSeconds=$cpu;workingSetBytes=[long](($family|Measure-Object WorkingSetSize -Sum).Sum);processes=$processes})
  if($samples.Count -eq 1){Write-Output 'Production idle: sampling app and descendants for 60 seconds.'}
  $remaining=60000-($clock.Elapsed.TotalMilliseconds-$samples[0].elapsedMs)
  if($remaining -gt 0){Start-Sleep -Milliseconds ([int][math]::Min(1000,[math]::Ceiling($remaining)))}
 }while($remaining -gt 0)
 $elapsed=($samples[$samples.Count-1].elapsedMs-$samples[0].elapsedMs)/1000.0
 if($elapsed -lt 60){throw 'Incomplete 60-second sample'}
 $cpu=$samples[$samples.Count-1].totalCpuSeconds-$samples[0].totalCpuSeconds;$percent=100*$cpu/$elapsed;$rounded=[math]::Round($percent,1)
 $ws=$samples|Measure-Object workingSetBytes -Average -Maximum -Minimum
 $threadCpu=@();$appProcess.Refresh();foreach($thread in $appProcess.Threads){$threadCpu+=@{id=$thread.Id;name=[IdleWindowProbe]::ThreadName($thread.Id);cpuSeconds=$thread.TotalProcessorTime.TotalSeconds-$(if($threadStart.ContainsKey($thread.Id)){$threadStart[$thread.Id]}else{0})}}
 $webviews=@($entries.Values|Where-Object {$_.Name -eq 'msedgewebview2.exe'}).Count
 $appFocus=@($foregroundChanges|Where-Object {$_.ownedByApp}).Count
 $report=@{measuredAtUtc=[DateTime]::UtcNow.ToString('o');sourceCommit=(& git -C $root rev-parse HEAD);executableSha256=(Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash.ToLowerInvariant();renderer='production hybrid native idle';warmupSeconds=20;elapsedSeconds=$elapsed;cpuSeconds=$cpu;oneCoreCpuPercent=$percent;oneCoreCpuPercentOneDecimal=$rounded;machineCpuPercent=$percent/[Environment]::ProcessorCount;workingSetBytes=@{mean=$ws.Average;peak=$ws.Maximum;minimum=$ws.Minimum};observedProcessCount=$entries.Count;observedWebviewCount=$webviews;observedChildrenFinalCpuIncludedAfterExit=$true;meanSnapshotIntervalMs=1000*$elapsed/($samples.Count-1);samples=$samples.ToArray();foregroundChanges=$foregroundChanges;noAppOrDescendantActivation=($appFocus -eq 0);actualHwnd=$hwnd.ToInt64();extendedStyles=$flags;dpi=$dpi;scalingPercent=100*$dpi/96;refresh=@{numerator=$refresh[0];denominator=$refresh[1];hz=$refresh[2];source='DwmGetCompositionTimingInfo'};isolation=@{disposableProfile=$true;realCursorUntouched=$true;displaySettingsUntouched=$true;osIntegrationsUntouched=$true;cdpAndTracingDisabled=$true;commandPollingDisabled=$true;clipboardWatcherDisabled=$true};cpuMethod='100 * sum(app and descendant CPU seconds) / elapsed wall seconds; nearest one decimal for 0.0% gate; raw and machine-normalized values retained.';idleBudgetPass=($rounded -eq 0.0 -and $webviews -eq 0 -and $appFocus -eq 0);historicalV0LimitationRetained=$true}
 $report.threadCpu=$threadCpu;$report.isolation.fixedCursorFixture=$true;$report.sourceWorkingTreeDirty=[bool](& git -C $root status --porcelain);Json $output $report
 Write-Output ("Production idle: {0:N6}% of one core ({1:N1}% rounded); mean working set {2:N3} MB; {3} WebView2 processes." -f $percent,$rounded,($ws.Average/1000000),$webviews)
 if(-not $report.idleBudgetPass){throw "Idle budget failed; evidence retained at $output"}
}finally{
 foreach($handle in $handles.Values){$handle.Dispose()}
 if($appProcess -and -not $appProcess.HasExited){Stop-Process -Id $appProcess.Id -Force;$appProcess.WaitForExit()}
 foreach($name in $names){if($null -eq $original[$name]){Remove-Item -LiteralPath ("Env:"+$name) -ErrorAction SilentlyContinue}else{[Environment]::SetEnvironmentVariable($name,$original[$name],'Process')}}
}
