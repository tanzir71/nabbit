param([string]$Exe = "src-tauri/target/release/nabbit.exe", [ValidateSet("webview", "native")][string]$Renderer = "webview")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$exePath = (Resolve-Path -LiteralPath (Join-Path $root $Exe)).Path
if (Get-Process -Name nabbit -ErrorAction SilentlyContinue) { throw "An existing Nabbit is running; leave it untouched." }
$trialRoot = Join-Path $root (".tools/island-performance-" + [guid]::NewGuid().ToString())
$outputName = if ($Renderer -eq "native") { "v04-native-performance.json" } else { "v03-performance.json" }
$outputPath = Join-Path $root ("progress/v2/M1/" + $outputName)
New-Item -ItemType Directory -Path $trialRoot -Force | Out-Null
$environmentNames = @("NABBIT_APP_DATA_DIR", "NABBIT_ISLAND_SPIKE", "NABBIT_ISLAND_RENDERER", "NABBIT_ACCEPTANCE_CURSOR", "NABBIT_ACCEPTANCE_NATIVE_CONTROL", "NABBIT_ACCEPTANCE_NATIVE_SCALE", "NABBIT_ACCEPTANCE_REDUCED_MOTION", "WEBVIEW2_USER_DATA_FOLDER", "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
$originalEnvironment = @{}
foreach ($name in $environmentNames) { $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process") }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class IslandPerformanceProbe {
  public delegate bool EnumCallback(IntPtr hwnd, IntPtr param);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr param);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int length);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("dwmapi.dll")] static extern int DwmGetCompositionTimingInfo(IntPtr hwnd, IntPtr info);
  public static IntPtr Find(int processId, string expectedTitle) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hwnd, param) => {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if (pid != processId) return true;
      var text = new StringBuilder(256); GetWindowText(hwnd, text, text.Capacity);
      if (text.ToString() != expectedTitle) return true;
      found = hwnd; return false;
    }, IntPtr.Zero);
    return found;
  }
  public static double[] Refresh() {
    // The Windows SDK's dwmapi.h uses pack(1); DWM_TIMING_INFO is 292 bytes.
    // Only the refresh numerator/denominator and QPC period are needed here.
    IntPtr info = Marshal.AllocHGlobal(292);
    try {
      for (int offset = 0; offset < 292; offset += 4) Marshal.WriteInt32(info, offset, 0);
      Marshal.WriteInt32(info, 292);
      int result = DwmGetCompositionTimingInfo(IntPtr.Zero, info);
      if (result != 0) Marshal.ThrowExceptionForHR(result);
      uint numerator = unchecked((uint)Marshal.ReadInt32(info, 4));
      uint denominator = unchecked((uint)Marshal.ReadInt32(info, 8));
      if (numerator == 0 || denominator == 0) throw new Exception("DWM refresh rate is unavailable");
      return new double[] { numerator, denominator, (double)numerator / denominator, Marshal.ReadInt64(info, 12) };
    } finally { Marshal.FreeHGlobal(info); }
  }
}
public sealed class IslandCpuHandle : IDisposable {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int id);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  readonly IntPtr handle;
  public IslandCpuHandle(int processId) {
    handle = OpenProcess(0x1000, false, processId); // query-limited only; no mutation rights
    if (handle == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  }
  public double CpuSeconds() {
    long created, exited, kernel, user;
    if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    return (kernel + user) / 10000000.0;
  }
  public void Dispose() { CloseHandle(handle); }
}
'@

function Write-JsonFile($path, $value) {
  [IO.File]::WriteAllText($path, ($value | ConvertTo-Json -Depth 12) + "`n", [Text.UTF8Encoding]::new($false))
}
function Start-Trial([string]$name, [string]$flag, [string]$browserArguments = "") {
  $env:NABBIT_APP_DATA_DIR = Join-Path $trialRoot ($name + "-app-data")
  $env:NABBIT_ISLAND_SPIKE = $flag
  $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $trialRoot ($name + "-webview")
  [Environment]::SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", $browserArguments, "Process")
  & python (Join-Path $root "spikes/island/seed_acceptance.py") $env:NABBIT_APP_DATA_DIR
  if ($LASTEXITCODE -ne 0) { throw "Disposable fixture seeding failed" }
  return Start-Process -FilePath $exePath -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardError (Join-Path $trialRoot ($name + "-stderr.log")) -PassThru
}
function Stop-Trial($appProcess) {
  if ($appProcess -and -not $appProcess.HasExited) { Stop-Process -Id $appProcess.Id -Force; $appProcess.WaitForExit() }
}
function Get-Family([int]$appProcessId, $known) {
  $all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate,KernelModeTime,UserModeTime,WorkingSetSize,CommandLine)
  if (@($all | Where-Object { $_.ProcessId -eq $appProcessId }).Count -ne 1) { throw "The measured app exited" }
  $family = @($all | Where-Object { $_.ProcessId -eq $appProcessId -or $known.ContainsKey("$($_.ProcessId)/$($_.CreationDate.ToUniversalTime().ToString('o'))") })
  $members = @{}
  $members[$appProcessId] = $true
  foreach ($entry in $family) { $members[[int]$entry.ProcessId] = $true }
  do {
    $added = $false
    foreach ($entry in $all) {
      if (-not $members.ContainsKey([int]$entry.ProcessId) -and $members.ContainsKey([int]$entry.ParentProcessId)) {
        $members[[int]$entry.ProcessId] = $true
        $family += $entry
        $added = $true
      }
    }
  } while ($added)
  return @($family | ForEach-Object {
    $role = "app"
    if ($_.Name -eq "msedgewebview2.exe") {
      $role = "browser"
      if ($_.CommandLine -match '--type=([^\s]+)') { $role = $Matches[1] }
    }
    [pscustomobject]@{
      id = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; name = $_.Name; role = $role
      created = $_.CreationDate.ToUniversalTime().ToString("o")
      cpuSeconds = ([double]$_.KernelModeTime + [double]$_.UserModeTime) / 10000000.0
      workingSetBytes = [long]$_.WorkingSetSize
    }
  })
}
function Measure-Idle([string]$name, $appProcess) {
  Write-Host "$name`: settling for 20 seconds with CDP and tracing disabled."
  Start-Sleep -Seconds 20
  if ($appProcess.HasExited) { throw "The app exited during warm-up" }
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $samples = [Collections.Generic.List[object]]::new()
  $handles = @{}
  $initialCpu = @{}
  $lastEntries = @{}
  try { do {
    $family = @(Get-Family $appProcess.Id $handles)
    $webviewCount=@($family | Where-Object { $_.name -eq "msedgewebview2.exe" }).Count
    if ($Renderer -eq "webview" -and $webviewCount -eq 0) { throw "The WebView2 process family is missing" }
    if ($Renderer -eq "native" -and $webviewCount -ne 0) { throw "Native idle unexpectedly allocated a WebView2 process" }
    $totalWorkingSet = [long](($family | Measure-Object workingSetBytes -Sum).Sum)
    $live = @{}
    foreach ($entry in $family) {
      $key = "$($entry.id)/$($entry.created)"
      if (-not $handles.ContainsKey($key)) {
        $handles[$key] = [IslandCpuHandle]::new($entry.id)
        $initialCpu[$key] = 0.0
        if ($samples.Count -eq 0) { $initialCpu[$key] = $handles[$key].CpuSeconds() }
      }
      $lastEntries[$key] = $entry
      $live[$key] = $true
    }
    $processes = @()
    $totalCpu = 0.0
    foreach ($key in $handles.Keys) {
      $entry = $lastEntries[$key]
      $cpuTime = $handles[$key].CpuSeconds()
      $totalCpu += $cpuTime - $initialCpu[$key]
      $processes += [ordered]@{ id = $entry.id; parent = $entry.parent; name = $entry.name; role = $entry.role; created = $entry.created; cpuSeconds = $cpuTime; presentInSnapshot = $live.ContainsKey($key); workingSetBytes = $(if ($live.ContainsKey($key)) { $entry.workingSetBytes } else { 0 }) }
    }
    $samples.Add([ordered]@{ elapsedMs = $clock.Elapsed.TotalMilliseconds; totalWorkingSetBytes = $totalWorkingSet; totalCpuSecondsSinceStart = $totalCpu; processes = $processes })
    if ($samples.Count -eq 1) { Write-Host "$name`: sampling 60 seconds of the app and its WebView2 children." }
    $remaining = 60000 - ($clock.Elapsed.TotalMilliseconds - $samples[0].elapsedMs)
    if ($remaining -gt 0) { Start-Sleep -Milliseconds ([int][math]::Min(1000, [math]::Ceiling($remaining))) }
  } while ($remaining -gt 0)
  } finally { foreach ($handle in $handles.Values) { $handle.Dispose() } }
  Write-JsonFile (Join-Path $trialRoot ($name + "-samples.json")) @{ samples = $samples.ToArray() }
  $elapsed = ($samples[$samples.Count - 1].elapsedMs - $samples[0].elapsedMs) / 1000.0
  $first = @{}
  foreach ($entry in $samples[0].processes) { $first["$($entry.id)/$($entry.created)"] = $entry }
  $last = @{}
  foreach ($sample in $samples) { foreach ($entry in $sample.processes) { $last["$($entry.id)/$($entry.created)"] = $entry } }
  $endKeys = @{}
  foreach ($entry in $samples[$samples.Count - 1].processes) { if ($entry.presentInSnapshot) { $endKeys["$($entry.id)/$($entry.created)"] = $true } }
  $cpu = $samples[$samples.Count - 1].totalCpuSecondsSinceStart - $samples[0].totalCpuSecondsSinceStart
  $stable = $first.Count -eq $last.Count -and $last.Count -eq $endKeys.Count
  if ($elapsed -lt 60) { throw "The complete 60-second sample was not collected" }
  $workingSets = $samples | ForEach-Object { $_.totalWorkingSetBytes } | Measure-Object -Average -Maximum -Minimum
  $percent = 100.0 * $cpu / $elapsed
  $result = [ordered]@{
    name = $name; warmupSeconds = 20; elapsedSeconds = $elapsed; cpuSeconds = $cpu
    oneCoreCpuPercent = $percent; oneCoreCpuPercentOneDecimal = [math]::Round($percent, 1)
    machineCpuPercent = $percent / [Environment]::ProcessorCount
    processTreeStable = $stable; observedProcessCount = $last.Count
    observedChildrenFinalCpuIncludedAfterExit = $true
    processDiscoveryWaitMs = 1000
    observedMeanSnapshotIntervalMs = 1000.0 * $elapsed / ($samples.Count - 1)
    workingSetBytes = [ordered]@{ mean = $workingSets.Average; peak = $workingSets.Maximum; minimum = $workingSets.Minimum }
    samples = $samples.ToArray()
  }
  Write-JsonFile (Join-Path $trialRoot ($name + "-idle.json")) $result
  Write-Host ("$name`: {0:N6}% of one CPU core; mean total working set {1:N2} MB." -f $percent, ($workingSets.Average / 1000000.0))
  return $result
}

$appProcess = $null
try {
  $env:NABBIT_ISLAND_RENDERER = $Renderer
  foreach ($name in @("NABBIT_ACCEPTANCE_NATIVE_CONTROL", "NABBIT_ACCEPTANCE_NATIVE_SCALE", "NABBIT_ACCEPTANCE_REDUCED_MOTION")) { Remove-Item -LiteralPath ("Env:"+$name) -ErrorAction SilentlyContinue }
  $env:NABBIT_ACCEPTANCE_CURSOR = Join-Path $trialRoot "cursor.json"
  Write-JsonFile $env:NABBIT_ACCEPTANCE_CURSOR @{ x = -1000; y = 1000; leftDown = $false; foreground = @{ notificationState = 5; onMonitor = $true } }
  $os = Get-CimInstance Win32_OperatingSystem
  $refresh = [IslandPerformanceProbe]::Refresh()
  $machine = [ordered]@{
    windows = $os.Caption; version = $os.Version; build = $os.BuildNumber
    logicalProcessors = [Environment]::ProcessorCount
    refresh = @{ numerator = $refresh[0]; denominator = $refresh[1]; hz = $refresh[2]; qpcPeriod = $refresh[3]; source = "DwmGetCompositionTimingInfo (current desktop)" }
    displaySettingsChanged = $false; backgroundApplicationsControlled = $false
  }
  $appProcess = Start-Trial "baseline" "0"
  $baseline = Measure-Idle "baseline" $appProcess
  if ([IslandPerformanceProbe]::Find($appProcess.Id, "Nabbit Island Spike") -ne [IntPtr]::Zero) { throw "The flag-zero baseline created an island" }
  Stop-Trial $appProcess
  $appProcess = Start-Trial "island" "1"
  $handle = [IntPtr]::Zero
  for ($attempt = 0; $attempt -lt 150; $attempt++) {
    if ($appProcess.HasExited) { throw "The island app exited during startup" }
    $hostTitle = if ($Renderer -eq "native") { "Nabbit Native Island Spike" } else { "Nabbit Island Spike" }
    $handle = [IslandPerformanceProbe]::Find($appProcess.Id, $hostTitle)
    if ($handle -ne [IntPtr]::Zero -and [IslandPerformanceProbe]::IsWindowVisible($handle)) { break }
    Start-Sleep -Milliseconds 200
  }
  if ($handle -eq [IntPtr]::Zero -or -not [IslandPerformanceProbe]::IsWindowVisible($handle)) { throw "The island host did not become visible" }
  $machine.dpi = [IslandPerformanceProbe]::GetDpiForWindow($handle)
  $machine.scalingPercent = 100.0 * $machine.dpi / 96.0
  $island = Measure-Idle "island" $appProcess
  Stop-Trial $appProcess

  if ($Renderer -eq "webview") {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $listener.Start(); $cdpPort = $listener.LocalEndpoint.Port; $listener.Stop()
  $endpoint = "http://127.0.0.1:$cdpPort"
  $appProcess = Start-Trial "motion" "1" "--remote-debugging-port=$cdpPort --remote-debugging-address=127.0.0.1"
  Push-Location $root
  try {
    & node scripts/measure-island-frames.mjs --cdp $endpoint --refresh-hz $machine.refresh.hz --raw-output (Join-Path $trialRoot "motion-full-trace.json")
    if ($LASTEXITCODE -ne 0) { throw "Native compositor frame measurement failed" }
  } finally { Pop-Location }
  }
  $report = [ordered]@{
    measuredAtUtc = [DateTime]::UtcNow.ToString("o"); sourceCommit = (& git -C $root rev-parse HEAD)
    sourceWorkingTreeDirty = [bool](& git -C $root status --porcelain)
    executableSha256 = (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash.ToLowerInvariant()
    build = "cargo build --release --features island-spike,custom-protocol (unsigned executable, no bundling)"
    machine = $machine; isolation = @{ disposableAppData = $true; disposableWebviewProfiles = $true; realCursorUntouched = $true; osAutostartAndHotkeysUntouched = $true; idleCdpAndTracingDisabled = $true }
    cpuMethod = "100 * sum(app and descendant CPU seconds) / elapsed wall seconds; one decimal for the 0.0% gate. Machine-normalized value also retained."
    workingSetMethod = "Sum of resident working sets across app and every descendant; shared pages may be counted in multiple processes. Same-binary flag 0 vs flag 1, fresh isolated profiles, equal warmup/sample durations."
    baseline = $baseline; island = $island
    addedWorkingSetBytes = @{ meanDifference = $island.workingSetBytes.mean - $baseline.workingSetBytes.mean; peakDifference = $island.workingSetBytes.peak - $baseline.workingSetBytes.peak; islandPeakMinusBaselineMean = $island.workingSetBytes.peak - $baseline.workingSetBytes.mean }
    renderer = $Renderer
    frameReport = $(if ($Renderer -eq "native") { "v04-native-checks.json (native compositor animation, not CDP frames)" } else { "v03-frame-timings.json" })
    gateDecision = $(if ($Renderer -eq "native") { "Native compact fallback selected after the WebView2 spike failed; retain the original V0.3 no-go measurements." } else { "V0.3 WebView2 spike measurements; the V0.4 fallback decision is recorded separately." })
  }
  Write-JsonFile $outputPath $report
  Write-Output "Saved release CPU/memory/display measurements to progress/v2/M1/$outputName."
} finally {
  Stop-Trial $appProcess
  foreach ($name in $environmentNames) {
    if($null -eq $originalEnvironment[$name]) {Remove-Item -LiteralPath ("Env:"+$name) -ErrorAction SilentlyContinue}
    else {[Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], "Process")}
  }
}
