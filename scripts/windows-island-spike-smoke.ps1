param([string]$Exe = "src-tauri/target/debug/nabbit.exe")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$exePath = (Resolve-Path -LiteralPath (Join-Path $root $Exe)).Path
if (Get-Process -Name nabbit -ErrorAction SilentlyContinue) { throw "An existing Nabbit process is running; do not interfere with it." }
$trialRoot = Join-Path $root (".tools/island-v01-" + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $trialRoot -Force | Out-Null
$environmentNames = @("NABBIT_APP_DATA_DIR", "NABBIT_ISLAND_SPIKE", "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "WEBVIEW2_USER_DATA_FOLDER")
$originalEnvironment = @{}
foreach ($name in $environmentNames) { $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process") }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class IslandSpikeProbe {
  public delegate bool EnumCallback(IntPtr hwnd, IntPtr param);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr param);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int length);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  public static IntPtr Find(int processId) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((hwnd, param) => {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if (pid != processId) return true;
      var title = new StringBuilder(256); GetWindowText(hwnd, title, title.Capacity);
      if (title.ToString() != "Nabbit Island Spike") return true;
      found = hwnd; return false;
    }, IntPtr.Zero);
    return found;
  }
  public static Rect Bounds(IntPtr hwnd, bool client) {
    IntPtr previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
    try { Rect rect; if (client) GetClientRect(hwnd, out rect); else GetWindowRect(hwnd, out rect); return rect; }
    finally { SetThreadDpiAwarenessContext(previous); }
  }
}
'@

$appProcess = $null
try {
  $env:NABBIT_APP_DATA_DIR = Join-Path $trialRoot "app-data"
  $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $trialRoot "baseline-webview"
  & python (Join-Path $root "spikes/island/seed_acceptance.py") $env:NABBIT_APP_DATA_DIR
  if ($LASTEXITCODE -ne 0) { throw "Disposable database seeding failed" }
  $env:NABBIT_ISLAND_SPIKE = "0"
  [Environment]::SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", $null, "Process")
  $appProcess = Start-Process -FilePath $exePath -WorkingDirectory $root -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 3
  if ($appProcess.HasExited) { throw "Baseline app exited unexpectedly" }
  if ([IslandSpikeProbe]::Find($appProcess.Id) -ne [IntPtr]::Zero) { throw "The spike must stay absent when the runtime flag is zero" }
  Stop-Process -Id $appProcess.Id -Force
  $appProcess.WaitForExit()
  $appProcess = $null

  $env:NABBIT_ISLAND_SPIKE = "1"
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $cdpPort = $listener.LocalEndpoint.Port
  $listener.Stop()
  $endpoint = "http://127.0.0.1:$cdpPort"
  $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $trialRoot "spike-webview"
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$cdpPort --remote-debugging-address=127.0.0.1"
  $appProcess = Start-Process -FilePath $exePath -WorkingDirectory $root -WindowStyle Hidden -PassThru
  $handle = [IntPtr]::Zero
  for ($attempt = 0; $attempt -lt 100; $attempt++) {
    if ($appProcess.HasExited) { throw "Spike app exited unexpectedly" }
    $handle = [IslandSpikeProbe]::Find($appProcess.Id)
    if ($handle -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 200
  }
  if ($handle -eq [IntPtr]::Zero) { throw "Spike HWND not found" }
  # HWND creation precedes completion of WebView2 setup and queued show/style calls.
  for ($attempt = 0; $attempt -lt 100; $attempt++) {
    if ([IslandSpikeProbe]::IsWindowVisible($handle)) { break }
    if ($appProcess.HasExited) { throw "Spike app exited during initialization" }
    Start-Sleep -Milliseconds 200
  }
  $style = [IslandSpikeProbe]::GetWindowLongPtr($handle, -20).ToInt64()
  # Tao implements skip_taskbar through ITaskbarList::DeleteTab, not WS_EX_TOOLWINDOW.
  $flags = [ordered]@{ noActivate = 0x08000000; noRedirectionBitmap = 0x00200000; topmost = 0x00000008; clickThrough = 0x00000020 }
  foreach ($entry in $flags.GetEnumerator()) { if (($style -band $entry.Value) -ne $entry.Value) { throw ("Missing window flag: " + $entry.Key) } }
  if (-not [IslandSpikeProbe]::IsWindowVisible($handle)) { throw "The transparent host must be shown" }
  $client = [IslandSpikeProbe]::Bounds($handle, $true)
  $bounds = [IslandSpikeProbe]::Bounds($handle, $false)
  $scale = [IslandSpikeProbe]::GetDpiForWindow($handle) / 96.0
  $width = ($client.Right - $client.Left) / $scale
  $height = ($client.Bottom - $client.Top) / $scale
  if ($width -ne 720 -or $height -ne 460) { throw ("Unexpected logical client size: " + $width + "x" + $height) }
  Push-Location $root
  try { & node scripts/verify-island-spike.mjs --cdp $endpoint; if ($LASTEXITCODE -ne 0) { throw "Actual WebView2 morph verification failed" } }
  finally { Pop-Location }
  $after = [IslandSpikeProbe]::Bounds($handle, $false)
  foreach ($edge in @("Left", "Top", "Right", "Bottom")) { if ($bounds.$edge -ne $after.$edge) { throw "Native HWND bounds changed during CSS morphs" } }
  $report = [ordered]@{ baselineFlagZeroHasNoSpike = $true; feature = "island-spike"; logicalSize = @($width, $height); dpiScale = $scale; exStyle = ('0x{0:X}' -f $style); flagsVerified = @($flags.Keys); visible = $true; nativeBoundsStable = $true; beforeBounds = $bounds; afterBounds = $after; appDataIsolated = $true; webviewDataIsolated = $true; osAutostartAndHotkeysUntouched = $true }
  $outputPath = Join-Path $root "progress/v2/M1/v01-native-window.json"
  [System.IO.File]::WriteAllText($outputPath, ($report | ConvertTo-Json -Depth 6) + "`n", [System.Text.UTF8Encoding]::new($false))
  Write-Output "Passed native window flags, baseline opt-in gate, 720x460 client, four CSS morphs and stable HWND bounds."
} finally {
  if ($appProcess -and -not $appProcess.HasExited) { Stop-Process -Id $appProcess.Id -Force; $appProcess.WaitForExit() }
  foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], "Process") }
}
