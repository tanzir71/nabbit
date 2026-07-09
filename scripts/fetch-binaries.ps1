param(
  [string]$Target = "x86_64-pc-windows-msvc"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Bin = Join-Path $Root "src-tauri\binaries"
New-Item -ItemType Directory -Force -Path $Bin | Out-Null

function Fetch($Url, $Name) {
  $Path = Join-Path $Bin $Name
  Write-Host "Downloading $Name"
  Invoke-WebRequest -Uri $Url -OutFile $Path
}

if ($Target -like "*windows*") {
  Fetch "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" "yt-dlp-$Target.exe"
  $ffmpegTarget = Join-Path $Bin "ffmpeg-$Target.exe"
  $ffmpegOnPath = Get-Command ffmpeg -ErrorAction SilentlyContinue
  if ($ffmpegOnPath) {
    Copy-Item -LiteralPath $ffmpegOnPath.Source -Destination $ffmpegTarget -Force
    Write-Host "Copied ffmpeg from PATH to ffmpeg-$Target.exe"
  } else {
    $archive = Join-Path $Bin "ffmpeg-$Target.zip"
    Fetch "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" "ffmpeg-$Target.zip"
    $tmp = Join-Path $env:TEMP ("nabbit-ffmpeg-" + [guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    Expand-Archive -LiteralPath $archive -DestinationPath $tmp -Force
    $ffmpeg = Get-ChildItem -Path $tmp -Recurse -Filter ffmpeg.exe | Select-Object -First 1
    if (-not $ffmpeg) { throw "ffmpeg.exe not found in $archive" }
    Copy-Item -LiteralPath $ffmpeg.FullName -Destination $ffmpegTarget -Force
    Remove-Item -LiteralPath $tmp -Recurse -Force
  }
} elseif ($Target -like "*apple-darwin*") {
  Fetch "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos" "yt-dlp-$Target"
  Write-Host "Download a signed ffmpeg build and place it at src-tauri/binaries/ffmpeg-$Target."
} else {
  Fetch "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" "yt-dlp-$Target"
  Write-Host "Install/copy ffmpeg to src-tauri/binaries/ffmpeg-$Target or ensure ffmpeg is on PATH."
}

Write-Host "Done."
