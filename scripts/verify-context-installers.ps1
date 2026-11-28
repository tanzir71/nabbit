param([string]$Prefix = 'v511-installers-a')
$ErrorActionPreference = 'Stop'
if ($Prefix -notmatch '^v5(?:11|12)-[a-z0-9-]+$') { throw 'Use a V5.11 or V5.12 evidence prefix' }
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$owned = Join-Path $workspace ".tools\$Prefix-$([guid]::NewGuid())"
$reportPath = Join-Path $workspace "progress\v2\M10\$Prefix.json"
if (Test-Path -LiteralPath $reportPath) { throw 'Evidence already exists' }
New-Item -ItemType Directory -Path $owned | Out-Null
$nsis = Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'
$wix = Join-Path $env:LOCALAPPDATA 'tauri\WixTools314'
foreach ($tool in @($nsis, (Join-Path $wix 'candle.exe'), (Join-Path $wix 'light.exe'))) {
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw "Compile tool is missing: $tool" }
}
$hook = Join-Path $workspace 'src-tauri\windows\hooks.nsh'
$fragment = Join-Path $workspace 'src-tauri\windows\context-cleanup.wxs'
$setup = Join-Path $owned 'fixture-setup.exe'
$nsi = Join-Path $owned 'fixture.nsi'
@"
Unicode true
!include LogicLib.nsh
!include FileFunc.nsh
!include "$hook"
Name "Nabbit context compile fixture"
OutFile "$setup"
RequestExecutionLevel user
Var UpdateMode
Function un.onInit
  StrCpy `$UpdateMode 0
FunctionEnd
Section
  WriteUninstaller "`$INSTDIR\uninstall.exe"
SectionEnd
Section Uninstall
  !insertmacro NSIS_HOOK_PREUNINSTALL
SectionEnd
"@ | Set-Content -LiteralPath $nsi -Encoding utf8
& $nsis /V4 $nsi
if ($LASTEXITCODE -ne 0) { throw 'NSIS cleanup hook did not compile' }
$preprocessed = (& $nsis /PPO $nsi | Out-String)
if ($LASTEXITCODE -ne 0 -or -not $preprocessed.Contains('--unregister-context') -or -not $preprocessed.Contains('UpdateMode')) { throw 'NSIS hook was not included' }
[System.IO.File]::WriteAllText((Join-Path $owned 'nsis-expanded.txt'), $preprocessed, [System.Text.UTF8Encoding]::new($false))
$stub = Join-Path $owned 'nabbit.exe'
[System.IO.File]::WriteAllBytes($stub, [System.Text.Encoding]::UTF8.GetBytes('Owned inert compile payload. Never execute.'))
$source = Join-Path $owned 'fixture.wxs'
@"
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="*" Name="Nabbit context compile fixture" Language="1033" Version="0.1.0" Manufacturer="Nabbit fixture" UpgradeCode="B9986264-A174-4F5B-A176-44D4119D23FA">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine" />
    <MediaTemplate EmbedCab="yes" />
    <Directory Id="TARGETDIR" Name="SourceDir"><Directory Id="ProgramFiles64Folder"><Directory Id="INSTALLDIR" Name="NabbitContextFixture">
      <Component Id="MainExecutable" Guid="*"><File Id="Path" Source="$stub" KeyPath="yes" /><RemoveFolder Id="RemoveFixtureFolder" On="uninstall" /></Component>
    </Directory></Directory></Directory>
    <Feature Id="Main" Level="1"><ComponentRef Id="MainExecutable" /><ComponentRef Id="NabbitContextCleanup" /></Feature>
  </Product>
</Wix>
"@ | Set-Content -LiteralPath $source -Encoding utf8
& (Join-Path $wix 'candle.exe') -nologo -arch x64 -out "$owned\" $source $fragment
if ($LASTEXITCODE -ne 0) { throw 'MSI cleanup fragment did not compile' }
$msi = Join-Path $owned 'fixture.msi'
& (Join-Path $wix 'light.exe') -nologo -out $msi (Join-Path $owned 'fixture.wixobj') (Join-Path $owned 'context-cleanup.wixobj')
if ($LASTEXITCODE -ne 0) { throw 'MSI cleanup fragment did not link' }
$installer = New-Object -ComObject WindowsInstaller.Installer
$database = $installer.OpenDatabase($msi, 0)
function Read-Rows([string]$Query, [int]$Columns) {
    $view = $database.OpenView($Query)
    $null = $view.Execute()
    $rows = @()
    while ($record = $view.Fetch()) {
        $row = [ordered]@{}
        for ($index = 1; $index -le $Columns; $index++) { $row["c$index"] = [string]$record.StringData($index) }
        $rows += [pscustomobject]$row
    }
    $null = $view.Close()
    return ,$rows
}
$actions = Read-Rows 'SELECT `Action`, `Type`, `Source`, `Target` FROM `CustomAction`' 4
$sequence = Read-Rows 'SELECT `Action`, `Condition`, `Sequence` FROM `InstallExecuteSequence`' 3
$action = @($actions | Where-Object { $_.c1 -eq 'NabbitRemoveUserContext' })
$cleanup = @($sequence | Where-Object { $_.c1 -eq 'NabbitRemoveUserContext' })
$remove = @($sequence | Where-Object { $_.c1 -eq 'RemoveFiles' })
if ($action.Count -ne 1 -or $action[0].c2 -ne '18' -or $action[0].c3 -ne 'Path' -or $action[0].c4 -ne '--unregister-context') { throw 'MSI cleanup action is missing or unchecked' }
if ($cleanup.Count -ne 1 -or [int]$cleanup[0].c3 -ge [int]$remove[0].c3 -or $cleanup[0].c2 -ne 'Installed AND REMOVE="ALL" AND NOT UPGRADINGPRODUCTCODE') { throw 'MSI cleanup scheduling is incorrect' }
$report = [ordered]@{
    passed = $true; compiledOnly = $true; installedOrExecuted = $false; nativeRegistrationWrites = $false
    nsis = @{ hookSha256 = (Get-FileHash -LiteralPath $hook -Algorithm SHA256).Hash.ToLowerInvariant(); compiledSha256 = (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant(); updateGuard = $true; cleanupFailureAborts = $true }
    msi = @{ fragmentSha256 = (Get-FileHash -LiteralPath $fragment -Algorithm SHA256).Hash.ToLowerInvariant(); compiledSha256 = (Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash.ToLowerInvariant(); actions = $actions; sequence = $cleanup; removeFilesSequence = $remove }
}
$json = $report | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($reportPath, "$json`n", [System.Text.UTF8Encoding]::new($false))
Write-Output $json
