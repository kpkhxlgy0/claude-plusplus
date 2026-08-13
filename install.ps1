$ErrorActionPreference = 'Stop'
$source = [System.IO.Path]::GetFullPath($PSScriptRoot)
$destination = [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.claude-plusplus\source'))
$managedRoot = [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.claude-plusplus')).TrimEnd('\') + '\'
if (!$destination.StartsWith($managedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Claude++ source destination is outside its managed root: $destination"
}

if ($source -ne $destination) {
    New-Item -ItemType Directory -Force -Path $destination | Out-Null
    Get-ChildItem -Force -LiteralPath $source | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force
    }
}

$command = Join-Path $destination 'bin\claudeplusplus.cmd'
if (!(Test-Path -LiteralPath $command)) {
    throw "Bundled Claude++ CLI is missing: $command"
}
& $command install
if ($LASTEXITCODE -ne 0) {
    throw "Claude++ install command failed with exit code $LASTEXITCODE"
}
