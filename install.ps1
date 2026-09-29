$ErrorActionPreference = 'Stop'
$MinimumBunVersion = [version]'1.4.2'
$PackageName = 'local-agent-automation-mcp'
$CommandName = 'automation-mcp'

function Fail([string]$Message) {
    [Console]::Error.WriteLine("automation-mcp installer: $Message")
    exit 1
}

$Architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
if ($env:OS -ne 'Windows_NT') { Fail 'this installer supports Windows only.' }
if ($Architecture -notin @('X64', 'Arm64')) { Fail "unsupported CPU architecture: $Architecture." }

$BunCommand = Get-Command bun -ErrorAction SilentlyContinue
$BunHome = Join-Path $env:USERPROFILE '.bun\bin'
$BunBinary = Join-Path $BunHome 'bun.exe'
$NeedsBunInstall = $true
if ($null -ne $BunCommand) {
    $InstalledVersionText = (& bun --version 2>$null | Select-Object -First 1)
    try {
        $InstalledVersion = [version]($InstalledVersionText -replace '^bun-v', '')
        $NeedsBunInstall = $InstalledVersion -lt $MinimumBunVersion
    } catch {
        $NeedsBunInstall = $true
    }
}

if ($NeedsBunInstall) {
    $InstallScript = Join-Path $env:TEMP ("bun-install-{0}.ps1" -f [guid]::NewGuid())
    try {
        Invoke-WebRequest -Uri 'https://bun.sh/install.ps1' -OutFile $InstallScript
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $InstallScript -Version "$MinimumBunVersion" -NoCompletions
        if ($LASTEXITCODE -ne 0) { Fail 'official Bun installation failed.' }
    } finally {
        Remove-Item -LiteralPath $InstallScript -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path $BunHome) { $env:PATH = "$BunHome;$env:PATH" }
    $BunCommand = Get-Command bun -ErrorAction SilentlyContinue
}

if (Test-Path $BunBinary) {
    $BunExecutable = $BunBinary
} elseif ($null -ne $BunCommand) {
    $BunExecutable = $BunCommand.Source
} else {
    Fail 'Bun installed but is not on PATH. Add %USERPROFILE%\.bun\bin and rerun.'
}

$InstalledVersionText = (& $BunExecutable --version 2>$null | Select-Object -First 1)
try { $InstalledVersion = [version]($InstalledVersionText -replace '^bun-v', '') } catch { Fail "could not parse Bun version '$InstalledVersionText'." }
if ($InstalledVersion -lt $MinimumBunVersion) { Fail "Bun $MinimumBunVersion or newer is required; found $InstalledVersionText." }

& $BunExecutable add --global $PackageName
if ($LASTEXITCODE -ne 0) { Fail 'global package installation failed. Check your network and Bun global package configuration.' }
$InstalledCli = Get-Command $CommandName -ErrorAction SilentlyContinue
if ($null -eq $InstalledCli) { Fail "installed, but $CommandName is not on PATH. Add %USERPROFILE%\.bun\bin." }
& $CommandName --help *> $null
if ($LASTEXITCODE -ne 0) { Fail 'installed CLI verification failed.' }
[Console]::Out.WriteLine("Installed $CommandName.")