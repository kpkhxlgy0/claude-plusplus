$ErrorActionPreference = 'Stop'
$tweaksRoot = [System.IO.Path]::GetFullPath((Join-Path $env:APPDATA 'claude-plusplus\tweaks'))
$target = [System.IO.Path]::GetFullPath((Join-Path $tweaksRoot 'com.claudeplusplus.probe'))
$prefix = $tweaksRoot.TrimEnd('\') + '\'
if (!$target.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Core Probe target is outside the Claude++ Tweaks directory: $target"
}
if (!(Test-Path -LiteralPath $target)) {
    Write-Output "Claude++ Core Probe Junction is already absent: $target"
    exit 0
}

$item = Get-Item -Force -LiteralPath $target
if ($item.LinkType -ne 'Junction') {
    throw "Refusing to remove a path that is not a Junction: $target"
}

Remove-Item -LiteralPath $target -Force
Write-Output "Removed Claude++ Core Probe Junction: $target"
