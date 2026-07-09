param(
  [string]$Exe = ".\src-tauri\target\release\nabbit.exe",
  [string]$TestUrl = "https://www.youtube.com/watch?v=e6rhUvwB5Y8",
  [string]$Section = "*00:00:00-00:00:03"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$ExePath = Resolve-Path (Join-Path $Root $Exe)
$OriginalAppDataOverride = $env:NABBIT_APP_DATA_DIR
$OriginalAcceptanceCommandDir = $env:NABBIT_ACCEPTANCE_COMMAND_DIR
$OriginalDownloadSection = $env:NABBIT_ACCEPTANCE_DOWNLOAD_SECTION
$OriginalFakeDownload = $env:NABBIT_ACCEPTANCE_FAKE_DOWNLOAD
$SmokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("nabbit-real-download-" + [guid]::NewGuid().ToString())
$SmokeAppDataDir = Join-Path $SmokeRoot "app-data"
$CommandDir = Join-Path $SmokeRoot "commands"
$OutputDir = Join-Path $SmokeRoot "downloads"
New-Item -ItemType Directory -Force -Path $SmokeAppDataDir, $CommandDir, $OutputDir | Out-Null
$env:NABBIT_APP_DATA_DIR = $SmokeAppDataDir
$env:NABBIT_ACCEPTANCE_COMMAND_DIR = $CommandDir
$env:NABBIT_ACCEPTANCE_DOWNLOAD_SECTION = $Section
Remove-Item Env:\NABBIT_ACCEPTANCE_FAKE_DOWNLOAD -ErrorAction SilentlyContinue
$DbPath = Join-Path $SmokeAppDataDir "nabbit.sqlite3"
$StartedProcess = $null
$OriginalSettings = $null
$Results = New-Object System.Collections.Generic.List[object]

function Assert-Tool($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required for this smoke test."
  }
}

function Resolve-Engine($Name) {
  $target = "x86_64-pc-windows-msvc"
  $candidates = @(
    (Join-Path $Root "src-tauri\binaries\$Name-$target.exe"),
    (Join-Path $Root "src-tauri\binaries\$Name.exe")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      return (Resolve-Path $candidate).Path
    }
  }
  $command = Get-Command "$Name.exe" -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }
  throw "$Name is required as a sidecar or on PATH."
}

function Invoke-Python([string]$Code, [string[]]$ArgList = @()) {
  $tmp = New-TemporaryFile
  try {
    Set-Content -LiteralPath $tmp -Value $Code -Encoding UTF8
    $output = & python $tmp @ArgList
    if ($LASTEXITCODE -ne 0) {
      throw "Python helper failed with exit code $LASTEXITCODE."
    }
    $output
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-SqliteScalar([string]$Sql, [string[]]$SqlArgs = @()) {
  $py = @'
import sqlite3, sys
db = sys.argv[1]
sql = sys.argv[2]
args = sys.argv[3:]
conn = sqlite3.connect(db, timeout=5)
conn.execute("PRAGMA busy_timeout = 5000")
row = conn.execute(sql, args).fetchone()
conn.close()
print("" if row is None or row[0] is None else row[0])
'@
  $argList = @($DbPath, $Sql) + $SqlArgs
  (Invoke-Python $py $argList).Trim()
}

function Invoke-SqliteExec([string]$Sql, [string[]]$SqlArgs = @()) {
  $py = @'
import sqlite3, sys
db = sys.argv[1]
sql = sys.argv[2]
args = sys.argv[3:]
conn = sqlite3.connect(db, timeout=5)
conn.execute("PRAGMA busy_timeout = 5000")
conn.execute(sql, args)
conn.commit()
conn.close()
'@
  $argList = @($DbPath, $Sql) + $SqlArgs
  Invoke-Python $py $argList | Out-Null
}

function Set-AppSetting([string]$Name, [string]$Value) {
  $py = @'
import datetime, json, sqlite3, sys
db, name, raw_value = sys.argv[1:4]
default = {
  "retentionDays": 30,
  "captureImages": True,
  "imageSizeCapMb": 10,
  "pasteOnSelect": False,
  "sensitiveHeuristics": False,
  "autoDetectLinks": True,
  "showDetectNotification": True,
  "pauseAutoDetect": False,
  "launchAtLogin": False,
  "startHidden": True,
  "showDockIcon": False,
  "togglePopoverShortcut": "CmdOrCtrl+Shift+V",
  "quickDownloadShortcut": "CmdOrCtrl+Shift+D",
  "clipboardSearchShortcut": "CmdOrCtrl+Shift+C",
  "defaultQuality": "1080p",
  "outputDir": "",
  "filenameTemplate": "%(title)s [%(id)s].%(ext)s",
  "maxConcurrentDownloads": 1,
  "revealAfterDownload": False,
  "engineAutoUpdate": False,
  "firstRunAcknowledged": True,
  "lastTab": "download"
}
conn = sqlite3.connect(db, timeout=5)
conn.execute("PRAGMA busy_timeout = 5000")
row = conn.execute("SELECT value FROM settings WHERE key = 'app_settings'").fetchone()
settings = default
if row and row[0]:
  try:
    settings.update(json.loads(row[0]))
  except Exception:
    pass
try:
  settings[name] = json.loads(raw_value)
except Exception:
  settings[name] = raw_value
now = datetime.datetime.now(datetime.UTC).isoformat().replace("+00:00", "Z")
conn.execute(
  "INSERT INTO settings(key, value, updated_at) VALUES ('app_settings', ?, ?) "
  "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  (json.dumps(settings, separators=(",", ":")), now)
)
conn.commit()
conn.close()
'@
  Invoke-Python $py @($DbPath, $Name, $Value) | Out-Null
}

function Wait-For([string]$Name, [scriptblock]$Condition, [int]$TimeoutMs = 5000) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
    if (& $Condition) {
      $sw.Stop()
      return $sw.ElapsedMilliseconds
    }
    Start-Sleep -Milliseconds 250
  }
  throw "Timed out waiting for $Name after ${TimeoutMs}ms."
}

function Invoke-AcceptanceCommand([string]$RequestName, [string]$DoneName, [string]$Payload = $null, [int]$TimeoutMs = 5000) {
  $request = Join-Path $CommandDir $RequestName
  $done = Join-Path $CommandDir $DoneName
  $requestTemp = "$request.tmp"
  Remove-Item -LiteralPath $request -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $requestTemp -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $done -Force -ErrorAction SilentlyContinue
  if ($null -eq $Payload) {
    New-Item -ItemType File -Force -Path $requestTemp | Out-Null
  } else {
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($requestTemp, $Payload, $utf8NoBom)
  }
  Move-Item -LiteralPath $requestTemp -Destination $request -Force
  Wait-For "acceptance command $RequestName" { Test-Path -LiteralPath $done } $TimeoutMs | Out-Null
  $raw = (Get-Content -LiteralPath $done -Raw).Trim()
  if ($raw.StartsWith("error:")) {
    throw "Acceptance command $RequestName failed: $raw"
  }
  return $raw
}

function Start-Download([string]$Quality) {
  $payload = @{
    url = $TestUrl
    quality = $Quality
    playlistMode = "video"
    playlistRange = $null
  } | ConvertTo-Json -Compress
  Invoke-AcceptanceCommand "download-start.json" "download-start.done" $payload 45000 | ConvertFrom-Json
}

function Wait-DownloadCompleted([string]$Id, [int]$TimeoutMs = 180000) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
    $status = Invoke-SqliteScalar "SELECT status FROM downloads WHERE id = ?1" @($Id)
    if ($status -eq "completed") {
      $sw.Stop()
      return $sw.ElapsedMilliseconds
    }
    if ($status -eq "failed") {
      $errorText = Invoke-SqliteScalar "SELECT error FROM downloads WHERE id = ?1" @($Id)
      throw "Download $Id failed: $errorText"
    }
    Start-Sleep -Seconds 1
  }
  throw "Timed out waiting for download $Id after ${TimeoutMs}ms."
}

function Assert-Media([string]$Path, [string]$Kind, [string]$FfmpegPath) {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "Expected media output missing: $Path"
  }
  $size = (Get-Item -LiteralPath $Path).Length
  if ($size -le 10000) {
    throw "Media output too small ($size bytes): $Path"
  }
  $processInfo = New-Object System.Diagnostics.ProcessStartInfo
  $processInfo.FileName = $FfmpegPath
  $processInfo.Arguments = "-hide_banner -i `"$Path`""
  $processInfo.UseShellExecute = $false
  $processInfo.RedirectStandardOutput = $true
  $processInfo.RedirectStandardError = $true
  $process = [System.Diagnostics.Process]::Start($processInfo)
  $info = $process.StandardOutput.ReadToEnd() + $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  if ($Kind -eq "video") {
    if ($info -notmatch "Video:" -or $info -notmatch "Audio:" -or $info -notmatch "1920x1080") {
      throw "MP4 output did not include expected 1080p video and audio streams."
    }
  } else {
    if ($info -notmatch "Audio:" -or [IO.Path]::GetExtension($Path) -ne ".mp3") {
      throw "MP3 output did not include an audio stream."
    }
  }
  return $size
}

function Add-Result([string]$Name, [string]$Evidence) {
  $Results.Add([pscustomobject]@{ Check = $Name; Evidence = $Evidence }) | Out-Null
}

function Start-Nabbit() {
  $script:StartedProcess = Start-Process -FilePath $ExePath -WindowStyle Hidden -PassThru
  Wait-For "app database" { Test-Path -LiteralPath $DbPath } 10000 | Out-Null
  Start-Sleep -Seconds 2
  if (-not (Get-Process -Id $script:StartedProcess.Id -ErrorAction SilentlyContinue)) {
    throw "Nabbit exited during startup."
  }
}

function Stop-Nabbit() {
  if ($script:StartedProcess -and (Get-Process -Id $script:StartedProcess.Id -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $script:StartedProcess.Id -Force
    Wait-For "app process exit" {
      -not (Get-Process -Id $script:StartedProcess.Id -ErrorAction SilentlyContinue)
    } 5000 | Out-Null
  }
  $script:StartedProcess = $null
}

Assert-Tool python
$FfmpegPath = Resolve-Engine "ffmpeg"
if (Get-Process -Name nabbit -ErrorAction SilentlyContinue) {
  throw "Nabbit is already running. Quit it before running this smoke test."
}

try {
  Start-Nabbit
  $OriginalSettings = Invoke-SqliteScalar "SELECT value FROM settings WHERE key = 'app_settings'"
  Set-AppSetting "outputDir" $OutputDir
  Set-AppSetting "filenameTemplate" "nabbit-real-%(id)s.%(ext)s"
  Set-AppSetting "maxConcurrentDownloads" "1"
  Set-AppSetting "engineAutoUpdate" "false"

  $videoJob = Start-Download "1080p"
  $videoElapsed = Wait-DownloadCompleted $videoJob.id 180000
  $videoOutput = Invoke-SqliteScalar "SELECT output_path FROM downloads WHERE id = ?1" @($videoJob.id)
  $videoSize = Assert-Media $videoOutput "video" $FfmpegPath
  Add-Result "real 1080p mp4 app download" "completed in ${videoElapsed}ms; ffmpeg saw 1080p video+audio; $videoSize bytes at $videoOutput"

  $audioJob = Start-Download "audio_mp3"
  $audioElapsed = Wait-DownloadCompleted $audioJob.id 180000
  $audioOutput = Invoke-SqliteScalar "SELECT output_path FROM downloads WHERE id = ?1" @($audioJob.id)
  $audioSize = Assert-Media $audioOutput "audio" $FfmpegPath
  Add-Result "real mp3 app download" "completed in ${audioElapsed}ms; ffmpeg saw MP3 audio; $audioSize bytes at $audioOutput"

  $Results | Format-Table -AutoSize
} finally {
  if ($OriginalSettings -ne $null -and (Test-Path -LiteralPath $DbPath)) {
    if ([string]::IsNullOrWhiteSpace($OriginalSettings)) {
      Invoke-SqliteExec "DELETE FROM settings WHERE key = 'app_settings'"
    } else {
      Invoke-SqliteExec "UPDATE settings SET value = ?1 WHERE key = 'app_settings'" @($OriginalSettings)
    }
  }
  Stop-Nabbit
  if ($OriginalAppDataOverride) {
    $env:NABBIT_APP_DATA_DIR = $OriginalAppDataOverride
  } else {
    Remove-Item Env:\NABBIT_APP_DATA_DIR -ErrorAction SilentlyContinue
  }
  if ($OriginalAcceptanceCommandDir) {
    $env:NABBIT_ACCEPTANCE_COMMAND_DIR = $OriginalAcceptanceCommandDir
  } else {
    Remove-Item Env:\NABBIT_ACCEPTANCE_COMMAND_DIR -ErrorAction SilentlyContinue
  }
  if ($OriginalDownloadSection) {
    $env:NABBIT_ACCEPTANCE_DOWNLOAD_SECTION = $OriginalDownloadSection
  } else {
    Remove-Item Env:\NABBIT_ACCEPTANCE_DOWNLOAD_SECTION -ErrorAction SilentlyContinue
  }
  if ($OriginalFakeDownload) {
    $env:NABBIT_ACCEPTANCE_FAKE_DOWNLOAD = $OriginalFakeDownload
  } else {
    Remove-Item Env:\NABBIT_ACCEPTANCE_FAKE_DOWNLOAD -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $SmokeRoot -Recurse -Force -ErrorAction SilentlyContinue
}
