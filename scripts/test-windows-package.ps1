$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$archive = Join-Path $repoRoot 'dist\claude-plusplus-0.2.9-win-x64.zip'
$archiveHash = "$archive.sha256"
if (!(Test-Path -LiteralPath $archive)) {
    throw "Windows release archive does not exist: $archive"
}
if (!(Test-Path -LiteralPath $archiveHash)) {
    throw "Windows release checksum does not exist: $archiveHash"
}
$expectedHash = ((Get-Content -LiteralPath $archiveHash -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
$actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($expectedHash -ne $actualHash) {
    throw "Windows release checksum mismatch. Expected $expectedHash, received $actualHash"
}

$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$testRoot = Join-Path $tempRoot ('claude-plusplus-package-test-' + [guid]::NewGuid().ToString('N'))
$extract = Join-Path $testRoot 'extract'
New-Item -ItemType Directory -Path $extract -Force | Out-Null

try {
    Expand-Archive -LiteralPath $archive -DestinationPath $extract
    foreach ($required in @(
        'packages\runtime\dist\main.js',
        'packages\runtime\dist\preload\index.js',
        'packages\loader\loader.cjs',
        'packages\installer\dist\cli.js',
        'docs\tweak-authoring.md',
        'store\index.json',
        'install.ps1',
        'LICENSE',
        'THIRD_PARTY_NOTICES.md'
    )) {
        if (!(Test-Path -LiteralPath (Join-Path $extract $required))) {
            throw "Required release content is missing: $required"
        }
    }
    $packageNames = @(Get-ChildItem -LiteralPath (Join-Path $extract 'packages') -Directory |
        Select-Object -ExpandProperty Name |
        Sort-Object)
    $expectedPackageNames = @('installer', 'loader', 'runtime', 'sdk')
    if (@(Compare-Object $expectedPackageNames $packageNames).Count -ne 0) {
        throw "Expected exactly the four public packages; received: $($packageNames -join ', ')"
    }
    @(
        'node_modules\@claude-plusplus\claude-host',
        'packages\claude-host',
        'scripts\run-feasibility-check.ps1'
    ) | ForEach-Object {
        if (Test-Path -LiteralPath (Join-Path $extract $_)) {
            throw "Private host content leaked into package: $_"
        }
    }
    $storeSource = Get-Content -LiteralPath (Join-Path $extract 'store\index.json') -Raw
    $store = $storeSource | ConvertFrom-Json
    if ($store.schemaVersion -ne 1 -or @($store.entries).Count -ne 0) {
        throw 'Packaged Tweak Store must be an empty schema-1 registry.'
    }
    $command = Join-Path $extract 'bin\claudeplusplus.cmd'
    if (!(Test-Path -LiteralPath $command)) {
        throw "Packaged CLI is missing: $command"
    }
    $workspaceNamespace = Join-Path $extract 'node_modules\@claude-plusplus'
    if (!(Test-Path -LiteralPath $workspaceNamespace -PathType Container)) {
        throw 'Packaged CLI is missing the Claude++ dependency namespace'
    }
    $workspaceDependencies = @(Get-ChildItem -LiteralPath $workspaceNamespace -Force |
        Select-Object -ExpandProperty Name |
        Sort-Object)
    if (@(Compare-Object @('sdk') $workspaceDependencies).Count -ne 0) {
        throw "Expected exactly the packaged SDK dependency; received: $($workspaceDependencies -join ', ')"
    }
    $packagedSdk = Join-Path $workspaceNamespace 'sdk'
    if (((Get-Item -LiteralPath $packagedSdk -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Packaged SDK dependency is a reparse point'
    }
    foreach ($requiredSdkPath in @('package.json', 'dist\index.js', 'dist\index.d.ts')) {
        if (!(Test-Path -LiteralPath (Join-Path $packagedSdk $requiredSdkPath))) {
            throw "Packaged SDK dependency is missing: $requiredSdkPath"
        }
    }
    $staleWorkspaceBins = Get-ChildItem -LiteralPath (Join-Path $extract 'node_modules\.bin') -Force |
        Where-Object { $_.Name -like 'claude-plusplus*' -or $_.Name -like 'claudeplusplus*' }
    if ($staleWorkspaceBins.Count -gt 0) {
        throw "Packaged CLI contains stale workspace launchers: $($staleWorkspaceBins.Name -join ', ')"
    }
    $previousPath = $env:PATH
    $previousAppData = $env:APPDATA
    $previousLocalAppData = $env:LOCALAPPDATA
    $previousUserProfile = $env:USERPROFILE
    try {
        $env:PATH = Join-Path $env:SystemRoot 'System32'
        $env:APPDATA = Join-Path $testRoot 'profile\appdata'
        $env:LOCALAPPDATA = Join-Path $testRoot 'profile\localappdata'
        $env:USERPROFILE = Join-Path $testRoot 'profile'
        New-Item -ItemType Directory -Force -Path $env:APPDATA, $env:LOCALAPPDATA, $env:USERPROFILE | Out-Null
        $helpOutput = (& $command help 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) {
            throw "Packaged help exited with code $LASTEXITCODE`: $helpOutput"
        }
        foreach ($commandShape in @(
            'create-tweak <target>',
            'validate-tweak [target]',
            'dev [target] [--name <link-name>] [--replace] [--no-watch]'
        )) {
            if (!$helpOutput.Contains($commandShape)) {
                throw "Packaged help is missing command shape: $commandShape"
            }
        }
        $output = (& $command --version 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) {
            throw "Packaged CLI exited with code $LASTEXITCODE`: $output"
        }
        $statusOutput = (& $command status 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) {
            throw "Packaged status exited with code $LASTEXITCODE`: $statusOutput"
        }
        $status = $statusOutput | ConvertFrom-Json
        if ($status.installed -ne $false -or $status.runtimeReady -ne $false) {
            throw "Expected an isolated uninstalled status, received: $statusOutput"
        }
        $doctorOutput = (& $command doctor 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) {
            throw "Packaged Doctor exited with code $LASTEXITCODE`: $doctorOutput"
        }
        $doctor = $doctorOutput | ConvertFrom-Json
        $doctorNames = @($doctor.checks | Select-Object -ExpandProperty name)
        foreach ($requiredCheck in @('settings-runtime', 'config', 'tweak-store', 'watcher')) {
            if ($doctorNames -notcontains $requiredCheck) {
                throw "Packaged Doctor is missing check: $requiredCheck"
            }
        }
        $tweakSource = Join-Path $testRoot 'authoring\package-smoke'
        & $command create-tweak $tweakSource --id com.example.package-smoke --name 'Package Smoke' --repo example/package-smoke --scope both
        if ($LASTEXITCODE -ne 0) { throw 'Packaged create-tweak failed' }
        & $command validate-tweak $tweakSource
        if ($LASTEXITCODE -ne 0) { throw 'Packaged validate-tweak failed' }
        & $command dev $tweakSource --no-watch
        if ($LASTEXITCODE -ne 0) { throw 'Packaged dev --no-watch failed' }

        $liveRoot = Join-Path $env:APPDATA 'claude-plusplus\tweaks'
        $liveLink = Join-Path $liveRoot 'com.example.package-smoke'
        if (!(Test-Path -LiteralPath $liveLink)) { throw 'Packaged dev link is missing' }
        if (((Get-Item -LiteralPath $liveLink -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
            throw 'Packaged dev link is not a Junction'
        }
        $liveMarker = Join-Path $liveRoot '.claudepp-dev-reload'
        if (!(Test-Path -LiteralPath $liveMarker)) {
            throw 'Packaged dev reload marker is missing'
        }

        $resolvedProfileRoot = [System.IO.Path]::GetFullPath((Join-Path $testRoot 'profile')).TrimEnd('\') + '\'
        foreach ($isolatedPath in @($liveLink, $liveMarker)) {
            $resolvedIsolatedPath = [System.IO.Path]::GetFullPath($isolatedPath)
            if (!$resolvedIsolatedPath.StartsWith($resolvedProfileRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Packaged dev artifact escaped the isolated profile: $resolvedIsolatedPath"
            }
        }
    } finally {
        $env:PATH = $previousPath
        $env:APPDATA = $previousAppData
        $env:LOCALAPPDATA = $previousLocalAppData
        $env:USERPROFILE = $previousUserProfile
    }
    if ($output -ne '0.2.9') {
        throw "Expected packaged CLI version 0.2.9, received: $output"
    }
    Write-Output "Packaged CLI version, status, Doctor, and Tweak authoring passed without system Node.js or npm on PATH."
    Write-Output "Package SHA-256: $actualHash"
} finally {
    $resolvedTestRoot = [System.IO.Path]::GetFullPath($testRoot)
    if (!$resolvedTestRoot.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        $resolvedTestRoot -eq $tempRoot) {
        throw "Unsafe package-test cleanup target: $resolvedTestRoot"
    }
    Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
}
