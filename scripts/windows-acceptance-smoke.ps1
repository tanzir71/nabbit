param(
  [string]$Exe = ".\src-tauri\target\release\nabbit.exe",
  [string]$TestUrl = "https://www.youtube.com/watch?v=e6rhUvwB5Y8"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$ExePath = Resolve-Path (Join-Path $Root $Exe)
$OriginalAppDataOverride = $env:NABBIT_APP_DATA_DIR
$OriginalAcceptanceCommandDir = $env:NABBIT_ACCEPTANCE_COMMAND_DIR
$OriginalFakeDownload = $env:NABBIT_ACCEPTANCE_FAKE_DOWNLOAD
$OriginalFakeDownloadDelay = $env:NABBIT_ACCEPTANCE_FAKE_DOWNLOAD_DELAY_MS
$SmokeAppDataRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("nabbit-smoke-" + [guid]::NewGuid().ToString())
$SmokeAppDataDir = Join-Path $SmokeAppDataRoot "app-data"
$CommandDir = Join-Path $SmokeAppDataRoot "commands"
$SmokeDownloadDir = Join-Path $SmokeAppDataRoot "downloads"
New-Item -ItemType Directory -Force -Path $SmokeAppDataDir | Out-Null
New-Item -ItemType Directory -Force -Path $CommandDir | Out-Null
New-Item -ItemType Directory -Force -Path $SmokeDownloadDir | Out-Null
$env:NABBIT_APP_DATA_DIR = $SmokeAppDataDir
$env:NABBIT_ACCEPTANCE_COMMAND_DIR = $CommandDir
$env:NABBIT_ACCEPTANCE_FAKE_DOWNLOAD = "1"
$env:NABBIT_ACCEPTANCE_FAKE_DOWNLOAD_DELAY_MS = "350"
$DbPath = Join-Path $SmokeAppDataDir "nabbit.sqlite3"
$Results = New-Object System.Collections.Generic.List[object]
$StartedProcess = $null
$OriginalSettings = $null
$Marker = "nabbit acceptance " + [guid]::NewGuid().ToString()
$SensitiveSample = "4242 4242 4242 4242"
$RetentionOld = "nabbit retention old " + [guid]::NewGuid().ToString()
$RetentionPinned = "nabbit retention pinned " + [guid]::NewGuid().ToString()
$RetentionFresh = "nabbit retention fresh " + [guid]::NewGuid().ToString()
$ClearMarker = "nabbit clear " + [guid]::NewGuid().ToString()
$ClearBlobPath = Join-Path $SmokeAppDataRoot "clear-blob.bin"

function Assert-Tool($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required for this smoke test."
  }
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

function Set-AppSetting([string]$Name, [string]$JsonValue) {
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
  "maxConcurrentDownloads": 2,
  "revealAfterDownload": False,
  "engineAutoUpdate": True,
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
  Invoke-Python $py @($DbPath, $Name, $JsonValue) | Out-Null
}

function Wait-For([string]$Name, [scriptblock]$Condition, [int]$TimeoutMs = 5000) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
    if (& $Condition) {
      $sw.Stop()
      return $sw.ElapsedMilliseconds
    }
    Start-Sleep -Milliseconds 100
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

function Start-FakeDownload([string]$Url, [string]$Quality, [string]$PlaylistMode = "video", [string]$PlaylistRange = $null) {
  $payload = @{
    url = $Url
    quality = $Quality
    playlistMode = $PlaylistMode
    playlistRange = $PlaylistRange
  } | ConvertTo-Json -Compress
  $raw = Invoke-AcceptanceCommand "download-start.json" "download-start.done" $payload 5000
  return $raw | ConvertFrom-Json
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

function Set-ClipboardText([string]$Value) {
  for ($attempt = 1; $attempt -le 10; $attempt++) {
    try {
      Set-Clipboard -Value $Value
      return
    } catch {
      if ($attempt -eq 10) {
        throw
      }
      Start-Sleep -Milliseconds 100
    }
  }
}

Assert-Tool python
if (Get-Process -Name nabbit -ErrorAction SilentlyContinue) {
  throw "Nabbit is already running. Quit it before running this smoke test."
}

try {
  Start-Nabbit
  Add-Result "release app launch" "process $($StartedProcess.Id) stayed alive and created $DbPath"

  $OriginalSettings = Invoke-SqliteScalar "SELECT value FROM settings WHERE key = 'app_settings'"
  $engineUpdateElapsed = Wait-For "engine update timestamp" {
    -not [string]::IsNullOrWhiteSpace((Invoke-SqliteScalar "SELECT value FROM settings WHERE key = 'engine_last_update_check'"))
  } 10000
  Add-Result "engine self-update background" "last update timestamp appeared in ${engineUpdateElapsed}ms while app remained responsive for smoke checks"
  Set-AppSetting "outputDir" $SmokeDownloadDir
  Set-AppSetting "maxConcurrentDownloads" "1"
  Invoke-SqliteExec "DELETE FROM clipboard_entries WHERE content IN (?1, ?2, ?3, ?4, ?5, ?6)" @($Marker, $SensitiveSample, $RetentionOld, $RetentionPinned, $RetentionFresh, $ClearMarker)
  Invoke-SqliteExec "DELETE FROM downloads WHERE url LIKE ?1" @("https://example.invalid/nabbit/%")

  Set-ClipboardText $Marker
  $elapsed = Wait-For "clipboard entry insert" {
    (Invoke-SqliteScalar "SELECT COUNT(*) FROM clipboard_entries WHERE content = ?1" @($Marker)) -eq "1"
  } 3000
  if ($elapsed -gt 2000) {
    throw "Clipboard entry appeared after ${elapsed}ms, slower than the ~1s acceptance target."
  }
  Add-Result "clipboard copy creates searchable entry" "stored unique marker in ${elapsed}ms; LIKE search count = $(Invoke-SqliteScalar "SELECT COUNT(*) FROM clipboard_entries WHERE content LIKE ?1" @("%$Marker%"))"

  Set-ClipboardText $Marker
  Start-Sleep -Milliseconds 500
  $duplicateCount = Invoke-SqliteScalar "SELECT COUNT(*) FROM clipboard_entries WHERE content = ?1" @($Marker)
  if ($duplicateCount -ne "1") {
    throw "Duplicate clipboard copy created $duplicateCount rows."
  }
  Add-Result "clipboard duplicates de-dupe" "same marker remained at one row"

  Set-AppSetting "sensitiveHeuristics" "true"
  $beforeSensitive = Invoke-SqliteScalar "SELECT COUNT(*) FROM clipboard_entries WHERE content = ?1" @($SensitiveSample)
  Set-ClipboardText $SensitiveSample
  Start-Sleep -Milliseconds 1000
  $afterSensitive = Invoke-SqliteScalar "SELECT COUNT(*) FROM clipboard_entries WHERE content = ?1" @($SensitiveSample)
  if ($afterSensitive -ne $beforeSensitive) {
    throw "Sensitive sample was stored despite sensitiveHeuristics=true."
  }
  Add-Result "sensitive clipboard skip" "credit-card-shaped sample did not create a row"

  Stop-Nabbit
  Set-AppSetting "retentionDays" "30"
  $oldDate = (Get-Date).AddDays(-100).ToUniversalTime().ToString("o")
  $freshDate = (Get-Date).ToUniversalTime().ToString("o")
  Invoke-SqliteExec "DELETE FROM clipboard_entries WHERE content IN (?1, ?2, ?3)" @($RetentionOld, $RetentionPinned, $RetentionFresh)
  Invoke-SqliteExec "INSERT INTO clipboard_entries(id, content_type, content, preview, hash, source_app, pinned, created_at, last_used_at, blob_path) VALUES (?1, 'text', ?2, ?2, ?3, 'Smoke', 0, ?4, ?4, NULL)" @([guid]::NewGuid().ToString(), $RetentionOld, ("hash-" + [guid]::NewGuid().ToString()), $oldDate)
  Invoke-SqliteExec "INSERT INTO clipboard_entries(id, content_type, content, preview, hash, source_app, pinned, created_at, last_used_at, blob_path) VALUES (?1, 'text', ?2, ?2, ?3, 'Smoke', 1, ?4, ?4, NULL)" @([guid]::NewGuid().ToString(), $RetentionPinned, ("hash-" + [guid]::NewGuid().ToString()), $oldDate)
  Invoke-SqliteExec "INSERT INTO clipboard_entries(id, content_type, content, preview, hash, source_app, pinned, created_at, last_used_at, blob_path) VALUES (?1, 'text', ?2, ?2, ?3, 'Smoke', 0, ?4, ?4, NULL)" @([guid]::NewGuid().ToString(), $RetentionFresh, ("hash-" + [guid]::NewGuid().ToString()), $freshDate)
  Start-Nabbit
  Wait-For "retention GC" {
    (Invoke-SqliteScalar "SELECT COUNT(*) FROM clipboard_entries WHERE content = ?1" @($RetentionOld)) -eq "0"
  } 5000 | Out-Null
  $pinnedCount = Invoke-SqliteScalar "SELECT COUNT(*) FROM clipboard_entries WHERE content = ?1" @($RetentionPinned)
  $freshCount = Invoke-SqliteScalar "SELECT COUNT(*) FROM clipboard_entries WHERE content = ?1" @($RetentionFresh)
  if ($pinnedCount -ne "1" -or $freshCount -ne "1") {
    throw "Retention GC removed the wrong entries: pinned=$pinnedCount fresh=$freshCount."
  }
  Add-Result "retention GC" "30-day launch GC deleted expired unpinned row and kept pinned/fresh rows"

  Set-Content -LiteralPath $ClearBlobPath -Value "blob" -Encoding UTF8
  Invoke-SqliteExec "INSERT INTO clipboard_entries(id, content_type, content, preview, hash, source_app, pinned, created_at, last_used_at, blob_path) VALUES (?1, 'text', ?2, ?2, ?3, 'Smoke', 0, ?4, ?4, ?5)" @([guid]::NewGuid().ToString(), $ClearMarker, ("hash-" + [guid]::NewGuid().ToString()), $freshDate, $ClearBlobPath)
  $clearStatus = Invoke-AcceptanceCommand "clear-history" "clear-history.done"
  if ($clearStatus -ne "ok") {
    throw "App clear-history command failed: $clearStatus"
  }
  $remainingClipboardRows = Invoke-SqliteScalar "SELECT COUNT(*) FROM clipboard_entries"
  if ($remainingClipboardRows -ne "0") {
    throw "Clear-all verification found $remainingClipboardRows remaining rows."
  }
  if (Test-Path -LiteralPath $ClearBlobPath) {
    throw "Clear-all verification left blob file at $ClearBlobPath."
  }
  Add-Result "clear all history" "app command returned ok; clipboard_entries emptied and blob file removed"

  $videoJob = Start-FakeDownload "https://example.invalid/nabbit/video" "1080p"
  $audioJob = Start-FakeDownload "https://example.invalid/nabbit/audio" "audio_mp3"
  $progressElapsed = Wait-For "download progress and concurrency limit" {
    $videoStatus = Invoke-SqliteScalar "SELECT status FROM downloads WHERE id = ?1" @($videoJob.id)
    $videoProgress = [double](Invoke-SqliteScalar "SELECT progress FROM downloads WHERE id = ?1" @($videoJob.id))
    $videoSpeed = Invoke-SqliteScalar "SELECT speed FROM downloads WHERE id = ?1" @($videoJob.id)
    $videoEta = Invoke-SqliteScalar "SELECT eta FROM downloads WHERE id = ?1" @($videoJob.id)
    $audioStatus = Invoke-SqliteScalar "SELECT status FROM downloads WHERE id = ?1" @($audioJob.id)
    $videoStatus -eq "running" -and $videoProgress -gt 0 -and -not [string]::IsNullOrWhiteSpace($videoSpeed) -and -not [string]::IsNullOrWhiteSpace($videoEta) -and $audioStatus -eq "queued"
  } 5000
  $cancelStatus = Invoke-AcceptanceCommand "download-cancel.txt" "download-cancel.done" $videoJob.id 5000
  if ($cancelStatus -ne "ok") {
    throw "Cancel command returned $cancelStatus."
  }
  Wait-For "cancelled download status" {
    (Invoke-SqliteScalar "SELECT status FROM downloads WHERE id = ?1" @($videoJob.id)) -eq "cancelled"
  } 5000 | Out-Null
  Invoke-AcceptanceCommand "download-retry.txt" "download-retry.done" $videoJob.id 5000 | Out-Null
  Wait-For "retried fake downloads complete" {
    $videoStatus = Invoke-SqliteScalar "SELECT status FROM downloads WHERE id = ?1" @($videoJob.id)
    $audioStatus = Invoke-SqliteScalar "SELECT status FROM downloads WHERE id = ?1" @($audioJob.id)
    $videoStatus -eq "completed" -and $audioStatus -eq "completed"
  } 20000 | Out-Null
  $videoOutput = Invoke-SqliteScalar "SELECT output_path FROM downloads WHERE id = ?1" @($videoJob.id)
  $audioOutput = Invoke-SqliteScalar "SELECT output_path FROM downloads WHERE id = ?1" @($audioJob.id)
  if (-not (Test-Path -LiteralPath $videoOutput) -or ([IO.Path]::GetExtension($videoOutput) -ne ".mp4")) {
    throw "Fake video output was not created as an MP4: $videoOutput"
  }
  if (-not (Test-Path -LiteralPath $audioOutput) -or ([IO.Path]::GetExtension($audioOutput) -ne ".mp3")) {
    throw "Fake audio output was not created as an MP3: $audioOutput"
  }
  Add-Result "download progress/cancel/retry/concurrency" "progress/speed/ETA appeared in ${progressElapsed}ms; second job stayed queued at concurrency=1; cancel and retry completed"

  Stop-Nabbit
  Start-Nabbit
  $downloadList = Invoke-AcceptanceCommand "download-list" "download-list.done" $null 5000 | ConvertFrom-Json
  $persistedVideo = $downloadList | Where-Object { $_.id -eq $videoJob.id -and $_.status -eq "completed" }
  $persistedAudio = $downloadList | Where-Object { $_.id -eq $audioJob.id -and $_.status -eq "completed" }
  if (-not $persistedVideo -or -not $persistedAudio) {
    throw "Download history did not persist across restart."
  }
  Add-Result "download history persists" "completed video/audio jobs were returned by app list_downloads after restart"

  $downloadsBefore = Invoke-SqliteScalar "SELECT COUNT(*) FROM downloads"
  Set-ClipboardText $TestUrl
  $stageElapsed = Wait-For "staged YouTube URL" {
    $staged = Invoke-SqliteScalar "SELECT value FROM settings WHERE key = 'staged_url'"
    $staged -like "*youtube.com/watch*"
  } 45000
  $downloadsAfter = Invoke-SqliteScalar "SELECT COUNT(*) FROM downloads"
  if ($downloadsAfter -ne $downloadsBefore) {
    throw "Copying URL created a download row ($downloadsBefore -> $downloadsAfter)."
  }
  Add-Result "YouTube URL stages without download" "staged in ${stageElapsed}ms; downloads stayed at $downloadsAfter"

  $proc = Get-Process -Id $StartedProcess.Id
  $beforeCpu = $proc.TotalProcessorTime.TotalSeconds
  Start-Sleep -Seconds 5
  $proc.Refresh()
  $cpuDelta = [math]::Round($proc.TotalProcessorTime.TotalSeconds - $beforeCpu, 4)
  if ($cpuDelta -gt 0.5) {
    throw "Idle CPU sample too high: $cpuDelta seconds over 5 seconds."
  }
  Add-Result "idle watcher CPU" "$cpuDelta CPU seconds over a 5-second idle sample"

  $Results | Format-Table -AutoSize
} finally {
  if ($OriginalSettings -ne $null -and (Test-Path -LiteralPath $DbPath)) {
    if ([string]::IsNullOrWhiteSpace($OriginalSettings)) {
      Invoke-SqliteExec "DELETE FROM settings WHERE key = 'app_settings'"
    } else {
      Invoke-SqliteExec "UPDATE settings SET value = ?1 WHERE key = 'app_settings'" @($OriginalSettings)
    }
  }
  if (Test-Path -LiteralPath $DbPath) {
    Invoke-SqliteExec "DELETE FROM clipboard_entries WHERE content IN (?1, ?2, ?3, ?4, ?5, ?6)" @($Marker, $SensitiveSample, $RetentionOld, $RetentionPinned, $RetentionFresh, $ClearMarker)
    Invoke-SqliteExec "DELETE FROM downloads WHERE url LIKE ?1" @("https://example.invalid/nabbit/%")
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
  if ($OriginalFakeDownload) {
    $env:NABBIT_ACCEPTANCE_FAKE_DOWNLOAD = $OriginalFakeDownload
  } else {
    Remove-Item Env:\NABBIT_ACCEPTANCE_FAKE_DOWNLOAD -ErrorAction SilentlyContinue
  }
  if ($OriginalFakeDownloadDelay) {
    $env:NABBIT_ACCEPTANCE_FAKE_DOWNLOAD_DELAY_MS = $OriginalFakeDownloadDelay
  } else {
    Remove-Item Env:\NABBIT_ACCEPTANCE_FAKE_DOWNLOAD_DELAY_MS -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $SmokeAppDataRoot -Recurse -Force -ErrorAction SilentlyContinue
}
