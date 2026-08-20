$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$metadata = Get-Content -LiteralPath (Join-Path $repoRoot 'toolchain\windows-node.json') -Raw | ConvertFrom-Json
$buildRoot = Join-Path $repoRoot 'build'
$cacheRoot = Join-Path $buildRoot 'cache'
$stagingRoot = Join-Path $buildRoot 'staging'
$payload = Join-Path $stagingRoot 'claude-plusplus-0.2.9-win-x64'
$distRoot = Join-Path $repoRoot 'dist'
$archive = Join-Path $distRoot 'claude-plusplus-0.2.9-win-x64.zip'
$archiveHash = "$archive.sha256"
$nodeArchive = Join-Path $cacheRoot $metadata.archive
$nodeExtract = Join-Path $stagingRoot 'node-extract'

function Assert-ChildPath([string]$Root, [string]$Candidate, [string]$Label) {
    $resolvedRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    $resolvedCandidate = [System.IO.Path]::GetFullPath($Candidate)
    if (!$resolvedCandidate.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label is outside its managed root: $resolvedCandidate"
    }
}

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE"
    }
}

New-Item -ItemType Directory -Force -Path $cacheRoot, $distRoot | Out-Null
Invoke-Checked 'npm.cmd' @('ci', '--workspaces', '--include-workspace-root', '--ignore-scripts')
Invoke-Checked 'npm.cmd' @('run', 'build')

if (Test-Path -LiteralPath $nodeArchive) {
    $cachedHash = (Get-FileHash -LiteralPath $nodeArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($cachedHash -ne $metadata.sha256) {
        Assert-ChildPath $cacheRoot $nodeArchive 'Node archive cache entry'
        Remove-Item -LiteralPath $nodeArchive -Force
    }
}
if (!(Test-Path -LiteralPath $nodeArchive)) {
    Invoke-WebRequest -Uri $metadata.url -OutFile $nodeArchive
}
$actualNodeHash = (Get-FileHash -LiteralPath $nodeArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualNodeHash -ne $metadata.sha256) {
    throw "Portable Node archive hash mismatch. Expected $($metadata.sha256), received $actualNodeHash"
}

if (Test-Path -LiteralPath $stagingRoot) {
    Assert-ChildPath $buildRoot $stagingRoot 'Packaging staging directory'
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $payload, $nodeExtract | Out-Null

try {
    Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtract
    $nodeRoot = Get-ChildItem -LiteralPath $nodeExtract -Directory | Select-Object -First 1
    if ($null -eq $nodeRoot -or !(Test-Path -LiteralPath (Join-Path $nodeRoot.FullName 'node.exe'))) {
        throw 'Portable Node archive does not contain node.exe'
    }

    foreach ($directory in @('bin', 'toolchain', 'packages', 'store')) {
        New-Item -ItemType Directory -Force -Path (Join-Path $payload $directory) | Out-Null
    }
    Copy-Item -LiteralPath (Join-Path $nodeRoot.FullName 'node.exe') -Destination (Join-Path $payload 'toolchain\node.exe')
    Copy-Item -LiteralPath (Join-Path $nodeRoot.FullName 'LICENSE') -Destination (Join-Path $payload 'toolchain\NODE_LICENSE')
    Copy-Item -LiteralPath (Join-Path $repoRoot 'LICENSE') -Destination $payload
    Copy-Item -LiteralPath (Join-Path $repoRoot 'THIRD_PARTY_NOTICES.md') -Destination $payload
    Copy-Item -LiteralPath (Join-Path $repoRoot 'README.md') -Destination $payload
    Copy-Item -LiteralPath (Join-Path $repoRoot 'install.ps1') -Destination $payload
    Copy-Item -LiteralPath (Join-Path $repoRoot 'package.json') -Destination $payload
    Copy-Item -LiteralPath (Join-Path $repoRoot 'package-lock.json') -Destination $payload
    Copy-Item -LiteralPath (Join-Path $repoRoot 'bin\claudeplusplus.js') -Destination (Join-Path $payload 'bin\claudeplusplus.js')
    Copy-Item -LiteralPath (Join-Path $repoRoot 'store\index.json') -Destination (Join-Path $payload 'store\index.json')

    foreach ($name in @('sdk', 'runtime', 'loader', 'installer')) {
        $sourcePackage = Join-Path $repoRoot "packages\$name"
        $targetPackage = Join-Path $payload "packages\$name"
        New-Item -ItemType Directory -Force -Path $targetPackage | Out-Null
        Copy-Item -LiteralPath (Join-Path $sourcePackage 'package.json') -Destination $targetPackage
        if (Test-Path -LiteralPath (Join-Path $sourcePackage 'dist')) {
            Copy-Item -LiteralPath (Join-Path $sourcePackage 'dist') -Destination $targetPackage -Recurse
        }
        if ($name -eq 'loader') {
            Copy-Item -LiteralPath (Join-Path $sourcePackage 'loader.cjs') -Destination $targetPackage
        }
    }

    Push-Location $payload
    try {
        Invoke-Checked 'npm.cmd' @('ci', '--omit=dev', '--workspaces', '--include-workspace-root', '--ignore-scripts')
    } finally {
        Pop-Location
    }
    $workspaceLinks = Join-Path $payload 'node_modules\@claude-plusplus'
    if (Test-Path -LiteralPath $workspaceLinks) {
        Assert-ChildPath $payload $workspaceLinks 'Packaged workspace links'
        foreach ($link in Get-ChildItem -LiteralPath $workspaceLinks -Force) {
            Assert-ChildPath $workspaceLinks $link.FullName 'Packaged workspace link'
            if (($link.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
                throw "Expected a packaged workspace link, found a real directory: $($link.FullName)"
            }
            Remove-Item -LiteralPath $link.FullName -Force
        }
        Remove-Item -LiteralPath $workspaceLinks -Force
    }
    $packageBins = Join-Path $payload 'node_modules\.bin'
    Get-ChildItem -LiteralPath $packageBins -Force |
        Where-Object { $_.Name -like 'claude-plusplus*' -or $_.Name -like 'claudeplusplus*' } |
        ForEach-Object {
            Assert-ChildPath $packageBins $_.FullName 'Packaged workspace launcher'
            Remove-Item -LiteralPath $_.FullName -Force
        }

    $launcher = @'
@echo off
setlocal
set "CLAUDE_PLUSPLUS_ROOT=%~dp0.."
"%CLAUDE_PLUSPLUS_ROOT%\toolchain\node.exe" "%CLAUDE_PLUSPLUS_ROOT%\packages\installer\dist\cli.js" %*
exit /b %ERRORLEVEL%
'@
    Set-Content -LiteralPath (Join-Path $payload 'bin\claudeplusplus.cmd') -Value $launcher -Encoding ascii -NoNewline

    Compress-Archive -Path (Join-Path $payload '*') -DestinationPath $archive -Force
    $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -LiteralPath $archiveHash -Value "$hash  $(Split-Path -Leaf $archive)" -Encoding ascii
    Write-Output "Windows release: $archive"
    Write-Output "SHA-256: $hash"
} finally {
    if (Test-Path -LiteralPath $stagingRoot) {
        Assert-ChildPath $buildRoot $stagingRoot 'Packaging staging directory'
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force
    }
}
