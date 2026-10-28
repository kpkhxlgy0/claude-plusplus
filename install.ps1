$ErrorActionPreference = 'Stop'
$installArguments = @($args)
# An evaluated script has no PSCommandPath, even when its caller is a script in a clone.
$savedScriptPath = $PSCommandPath

function Invoke-Checked([string]$Command, [string[]]$Arguments, [string]$Label) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE"
    }
}

function Get-PackageMetadata([string]$Root) {
    $metadataPath = Join-Path $Root 'package.json'
    if (!(Test-Path -LiteralPath $metadataPath -PathType Leaf)) { return $null }
    try { return (Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json) }
    catch { return $null }
}

function Test-SourceTree([string]$Root) {
    $metadata = Get-PackageMetadata $Root
    if ($null -eq $metadata -or $metadata.name -cne 'claude-plusplus') { return $false }
    foreach ($relative in @('install.ps1', 'bin\claudeplusplus.js', 'packages\installer\src\cli.ts', 'packages\runtime\src\main.ts', 'packages\loader\loader.cjs')) {
        if (!(Test-Path -LiteralPath (Join-Path $Root $relative) -PathType Leaf)) { return $false }
    }
    return $true
}

function Test-ManagedPackage([string]$Root) {
    $metadata = Get-PackageMetadata $Root
    if ($null -eq $metadata -or $metadata.name -cne 'claude-plusplus' -or
        $metadata.version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$' -or (Test-SourceTree $Root)) { return $false }
    foreach ($relative in @('bin\claudeplusplus.cmd', 'toolchain\node.exe', 'packages\installer\dist\cli.js', 'packages\runtime\dist\main.js', 'packages\runtime\dist\preload\index.js', 'packages\loader\loader.cjs', 'store\index.json')) {
        if (!(Test-Path -LiteralPath (Join-Path $Root $relative) -PathType Leaf)) { return $false }
    }
    return $true
}

function Assert-UnlinkedPath([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        if ($null -ne $item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Refusing a linked source path: $cursor"
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Assert-PlainPackageTree([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return }
    if ($item.Name -ieq '.git') { throw "Refusing to replace a Git repository: $Path. Use Git and the local install.ps1 instead." }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing a linked source path: $Path" }
    if ($item.PSIsContainer) {
        foreach ($child in Get-ChildItem -LiteralPath $Path -Force) {
            Assert-PlainPackageTree $child.FullName
        }
    }
}

function Assert-SafeReplacement([string]$Path) {
    $fullPath = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    $homePath = [IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\', '/')
    $rootPath = [IO.Path]::GetPathRoot($fullPath).TrimEnd('\', '/')
    if ($fullPath -ieq $rootPath -or $fullPath -ieq $homePath) {
        throw "Refusing to replace a filesystem or home root: $Path"
    }
    Assert-UnlinkedPath $Path
    $cursor = $fullPath
    while ($cursor) {
        if (Test-Path -LiteralPath (Join-Path $cursor '.git')) {
            throw "Refusing to replace a Git repository or its contents: $Path. Use Git and the local install.ps1 instead."
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
    Assert-PlainPackageTree $Path
    if (Test-Path -LiteralPath $Path) {
        if (!(Test-Path -LiteralPath $Path -PathType Container)) { throw "Refusing to replace a nonempty, unrecognized source: $Path" }
        if (@(Get-ChildItem -LiteralPath $Path -Force).Count -gt 0 -and !(Test-ManagedPackage $Path) -and !(Test-SourceTree $Path)) {
            throw "Refusing to replace a nonempty, unrecognized source: $Path"
        }
    }
}

function Assert-Package([string]$Root, [string]$Version) {
    Assert-UnlinkedPath $Root
    Assert-PlainPackageTree $Root
    if (!(Test-ManagedPackage $Root) -or ($Version -and (Get-PackageMetadata $Root).version -cne $Version)) {
        throw "Claude++ package identity or bundled CLI is invalid: $Root"
    }
}

function Assert-SafeTargets([string]$Destination, [string]$Previous) {
    Assert-SafeReplacement $Destination
    Assert-SafeReplacement $Previous
}

function Invoke-PackageCli([string]$Root, [string[]]$Arguments) {
    Invoke-Checked (Join-Path $Root 'toolchain\node.exe') (@((Join-Path $Root 'packages\installer\dist\cli.js'), 'install') + $Arguments) 'Claude++ install command'
}

function Install-ManagedPackage([string]$Source, [string]$Destination, [string[]]$Arguments) {
    $previous = "$Destination.previous"
    Assert-Package $Source
    Assert-SafeTargets $Destination $previous
    if ([IO.Path]::GetFullPath($Source).TrimEnd('\') -ieq [IO.Path]::GetFullPath($Destination).TrimEnd('\')) {
        Invoke-PackageCli $Destination $Arguments
        return
    }
    $work = "$Destination.install-$([guid]::NewGuid().ToString('N'))"
    $staging = Join-Path $work 'package'
    $savedPrevious = Join-Path $work 'previous'
    Assert-SafeReplacement $work
    New-Item -ItemType Directory -Path $staging | Out-Null
    $backedUp = $false
    $installed = $false
    $previousStashed = $false
    try {
        foreach ($item in Get-ChildItem -LiteralPath $Source -Force) {
            Copy-Item -LiteralPath $item.FullName -Destination $staging -Recurse -Force
        }
        Assert-Package $staging
        try {
            Assert-SafeTargets $Destination $previous
            Assert-SafeReplacement $savedPrevious
            if (Test-Path -LiteralPath $previous) {
                Move-Item -LiteralPath $previous -Destination $savedPrevious
                $previousStashed = $true
            }
            Assert-SafeTargets $Destination $previous
            Assert-SafeReplacement $savedPrevious
            if (Test-Path -LiteralPath $Destination) {
                Move-Item -LiteralPath $Destination -Destination $previous
                $backedUp = $true
            }
            Assert-SafeTargets $Destination $previous
            Assert-SafeReplacement $staging
            Move-Item -LiteralPath $staging -Destination $Destination
            $installed = $true
            Invoke-PackageCli $Destination $Arguments
        } catch {
            # Recheck all trees before rollback; newly protected trees must survive.
            Assert-SafeTargets $Destination $previous
            Assert-SafeReplacement $savedPrevious
            if ($installed) {
                Remove-Item -LiteralPath $Destination -Recurse -Force
                $installed = $false
            }
            if ($backedUp) {
                if (Test-Path -LiteralPath $Destination) { throw "Rollback destination is occupied; backups are preserved in $work" }
                Move-Item -LiteralPath $previous -Destination $Destination
                $backedUp = $false
            }
            if ($previousStashed) {
                if (Test-Path -LiteralPath $previous) { throw "Rollback backup is occupied; the older backup is preserved in $work" }
                Move-Item -LiteralPath $savedPrevious -Destination $previous
                $previousStashed = $false
            }
            throw
        }
        if ($previousStashed) {
            Assert-SafeReplacement $savedPrevious
            if ($backedUp) {
                # Discard an older recognized backup only after maintenance succeeds.
                Remove-Item -LiteralPath $savedPrevious -Recurse -Force
            } else {
                Assert-SafeReplacement $previous
                Move-Item -LiteralPath $savedPrevious -Destination $previous
            }
            $previousStashed = $false
        }
    } finally {
        if (Test-Path -LiteralPath $staging) {
            Assert-SafeReplacement $staging
            Remove-Item -LiteralPath $staging -Recurse -Force
        }
        if ($previousStashed) {
            Write-Warning "The preserved previous-source backup remains at $savedPrevious"
        } elseif (Test-Path -LiteralPath $work) {
            Assert-SafeReplacement $work
            Remove-Item -LiteralPath $work -Force
        }
    }
}

function Assert-ArchivePaths([string]$Archive, [string]$ExtractRoot) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $prefix = [IO.Path]::GetFullPath($ExtractRoot).TrimEnd('\') + '\'
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        foreach ($entry in $zip.Entries) {
            if ([IO.Path]::IsPathRooted($entry.FullName) -or $entry.FullName.Contains(':')) { throw 'Release archive contains an unsafe path.' }
            $target = [IO.Path]::GetFullPath((Join-Path $ExtractRoot $entry.FullName))
            if (!$target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Release archive contains an unsafe path.' }
        }
    } finally { $zip.Dispose() }
}

function Install-OnlineRelease([string]$Destination, [string[]]$Arguments) {
    Assert-SafeTargets $Destination "$Destination.previous"
    $headers = @{ 'User-Agent' = 'claude-plusplus-installer'; 'Accept' = 'application/vnd.github+json' }
    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/kpkhxlgy0/claude-plusplus/releases/latest' -Headers $headers
    if ($release.draft -or $release.prerelease -or $release.tag_name -notmatch '^v?(?<version>\d+\.\d+\.\d+)$') {
        throw 'The official latest stable release metadata is invalid.'
    }
    $version = $Matches.version
    $archiveName = "claude-plusplus-$version-win-x64.zip"
    $archiveAsset = @($release.assets | Where-Object { $_.name -ceq $archiveName })
    $checksumAsset = @($release.assets | Where-Object { $_.name -ceq "$archiveName.sha256" })
    if ($archiveAsset.Count -ne 1) { throw "The official Windows release asset is missing: $archiveName" }
    if ($checksumAsset.Count -ne 1) { throw "The official checksum asset is missing: $archiveName.sha256" }
    $assetBase = "https://github.com/kpkhxlgy0/claude-plusplus/releases/download/$($release.tag_name)/"
    if ($archiveAsset[0].browser_download_url -cne "$assetBase$archiveName" -or
        $checksumAsset[0].browser_download_url -cne "$assetBase$archiveName.sha256") {
        throw 'The official Windows release asset URLs are invalid.'
    }
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
    Assert-UnlinkedPath $tempRoot
    $work = Join-Path $tempRoot "claude-plusplus-install-$([guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $work | Out-Null
    try {
        $archive = Join-Path $work $archiveName
        $checksum = Join-Path $work "$archiveName.sha256"
        Invoke-WebRequest -Uri $archiveAsset[0].browser_download_url -OutFile $archive -Headers $headers -UseBasicParsing
        Invoke-WebRequest -Uri $checksumAsset[0].browser_download_url -OutFile $checksum -Headers $headers -UseBasicParsing
        $checksumText = (Get-Content -LiteralPath $checksum -Raw).Trim()
        if ($checksumText -notmatch '^(?<hash>[0-9a-fA-F]{64})(?:\s+\*?(?<filename>[^\r\n]+))?$') { throw 'The release checksum is invalid.' }
        $expectedHash = $Matches.hash
        if ($Matches.filename -and $Matches.filename -cne $archiveName) { throw 'The release checksum filename is invalid.' }
        $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
        if ($actualHash -ine $expectedHash) { throw "Release archive hash mismatch. Expected $expectedHash, received $actualHash" }
        $extract = Join-Path $work 'payload'
        Assert-ArchivePaths $archive $extract
        Expand-Archive -LiteralPath $archive -DestinationPath $extract
        $payload = $extract
        if (!(Test-Path -LiteralPath (Join-Path $payload 'package.json') -PathType Leaf)) {
            $children = @(Get-ChildItem -LiteralPath $extract -Force)
            if ($children.Count -eq 1 -and $children[0].PSIsContainer) { $payload = $children[0].FullName }
        }
        Assert-Package $payload $version
        Install-ManagedPackage $payload $Destination $Arguments
    } finally {
        # Only remove the exact, invocation-owned directory under the native temp root.
        if ([IO.Path]::GetDirectoryName($work) -ine $tempRoot -or [IO.Path]::GetFileName($work) -notmatch '^claude-plusplus-install-[0-9a-f]{32}$') {
            throw "Unsafe installer temporary path: $work"
        }
        Assert-UnlinkedPath $work
        Assert-PlainPackageTree $work
        Remove-Item -LiteralPath $work -Recurse -Force
    }
}

if ($savedScriptPath) {
    $source = [IO.Path]::GetFullPath((Split-Path -Parent $savedScriptPath))
    if (Test-SourceTree $source) {
        $nodeCommand = Get-Command 'node' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
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
        $npmCommand = Get-Command 'npm.cmd' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $npmCommand) { throw 'npm is required to install Claude++ from source. Install npm and retry.' }
        Push-Location $source
        try {
            Invoke-Checked $npmCommand.Source @('ci', '--workspaces', '--include-workspace-root', '--ignore-scripts') 'Claude++ dependency installation'
            Invoke-Checked $npmCommand.Source @('run', 'build') 'Claude++ source build'
            Invoke-Checked $nodePath (@((Join-Path $source 'bin\claudeplusplus.js'), 'install') + $installArguments) 'Claude++ install command'
        } finally { Pop-Location }
        return
    }
    Assert-Package $source
}

$destination = [IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.claude-plusplus\source'))
if ($savedScriptPath) { Install-ManagedPackage $source $destination $installArguments }
else { Install-OnlineRelease $destination $installArguments }
