$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$archive = Join-Path $repoRoot 'dist\claude-plusplus-0.2.3-win-x64.zip'
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
    if (Test-Path -LiteralPath (Join-Path $extract 'node_modules\@claude-plusplus')) {
        throw 'Packaged CLI contains Claude++ workspace links'
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
    } finally {
        $env:PATH = $previousPath
        $env:APPDATA = $previousAppData
        $env:LOCALAPPDATA = $previousLocalAppData
        $env:USERPROFILE = $previousUserProfile
    }
    if ($output -ne '0.2.3') {
        throw "Expected packaged CLI version 0.2.3, received: $output"
    }
    Write-Output "Packaged CLI version, status, and Doctor passed without system Node.js or npm on PATH."
    Write-Output "Package SHA-256: $actualHash"
} finally {
    $resolvedTestRoot = [System.IO.Path]::GetFullPath($testRoot)
    if (!$resolvedTestRoot.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
        $resolvedTestRoot -eq $tempRoot) {
        throw "Unsafe package-test cleanup target: $resolvedTestRoot"
    }
    Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
}
