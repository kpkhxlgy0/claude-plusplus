param(
    [string]$Source = (Join-Path $PSScriptRoot '..\packages\runtime\test\fixtures\com.claudeplusplus.probe')
)

$ErrorActionPreference = 'Stop'
$resolvedSource = (Resolve-Path -LiteralPath $Source).Path
$tweaksRoot = [System.IO.Path]::GetFullPath((Join-Path $env:APPDATA 'claude-plusplus\tweaks'))
$target = [System.IO.Path]::GetFullPath((Join-Path $tweaksRoot 'com.claudeplusplus.probe'))
$prefix = $tweaksRoot.TrimEnd('\') + '\'
if (!$target.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Core Probe target is outside the Claude++ Tweaks directory: $target"
}
New-Item -ItemType Directory -Force -Path $tweaksRoot | Out-Null

if (Test-Path -LiteralPath $target) {
    $existing = Get-Item -Force -LiteralPath $target
    if ($existing.LinkType -eq 'Junction' -and $existing.Target -contains $resolvedSource) {
        Write-Output "Claude++ Core Probe Junction is already current: $target"
        exit 0
    }
    throw "Refusing to replace an existing non-matching path: $target"
}

New-Item -ItemType Junction -Path $target -Target $resolvedSource | Out-Null
Write-Output "Created Claude++ Core Probe Junction: $target"
