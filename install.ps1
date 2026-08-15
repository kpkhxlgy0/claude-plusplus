$ErrorActionPreference = 'Stop'

function Invoke-Checked([string]$Command, [string[]]$Arguments, [string]$Label) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE"
    }
}

$source = [System.IO.Path]::GetFullPath($PSScriptRoot)
$destination = [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.claude-plusplus\source'))
$managedRoot = [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.claude-plusplus')).TrimEnd('\') + '\'
if (!$destination.StartsWith($managedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Claude++ source destination is outside its managed root: $destination"
}

$packagedLauncher = Join-Path $source 'bin\claudeplusplus.cmd'
$nodeLauncher = Join-Path $source 'bin\claudeplusplus.js'
$isPackaged = Test-Path -LiteralPath $packagedLauncher
if (!$isPackaged -and !(Test-Path -LiteralPath $nodeLauncher)) {
    throw "Claude++ CLI is missing. Expected either: $packagedLauncher or $nodeLauncher"
}

$nodePath = $null
if (!$isPackaged) {
    $nodeCommand = Get-Command 'node' -CommandType Application -ErrorAction SilentlyContinue
    if ($null -eq $nodeCommand) {
        throw 'Node.js 24 or newer is required to install Claude++ from source. Install Node.js and retry.'
    }
    $nodePath = $nodeCommand.Source
    $nodeVersion = (& $nodePath --version 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v(?<major>\d+)\.\d+\.\d+$') {
        throw "Could not determine the installed Node.js version: $nodeVersion"
    }
    if ([int]$Matches.major -lt 24) {
        throw "Node.js 24 or newer is required to install Claude++ from source; found $nodeVersion."
    }

    $npmCommand = Get-Command 'npm.cmd' -CommandType Application -ErrorAction SilentlyContinue
    if ($null -eq $npmCommand) {
        throw 'npm is required to install Claude++ from source. Install npm and retry.'
    }
    Push-Location $source
    try {
        Invoke-Checked $npmCommand.Source @('ci', '--workspaces', '--include-workspace-root', '--ignore-scripts') 'Claude++ dependency installation'
        Invoke-Checked $npmCommand.Source @('run', 'build') 'Claude++ source build'
    } finally {
        Pop-Location
    }
}

if ($source -ne $destination) {
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Get-ChildItem -Force -LiteralPath $source | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force
    }
}

if ($isPackaged) {
    Invoke-Checked (Join-Path $destination 'bin\claudeplusplus.cmd') @('install') 'Claude++ install command'
} else {
    Invoke-Checked $nodePath @((Join-Path $destination 'bin\claudeplusplus.js'), 'install') 'Claude++ install command'
}
