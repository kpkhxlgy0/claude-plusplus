$ErrorActionPreference = 'Stop'

function Get-NormalizedAbsolutePath([string]$Path, [string]$BasePath = '') {
    $candidate = $Path
    if ($candidate.StartsWith('\\?\UNC\', [System.StringComparison]::OrdinalIgnoreCase) -or
        $candidate.StartsWith('\??\UNC\', [System.StringComparison]::OrdinalIgnoreCase)) {
        $candidate = '\\' + $candidate.Substring(8)
    } elseif ($candidate.StartsWith('\\?\', [System.StringComparison]::OrdinalIgnoreCase) -or
        $candidate.StartsWith('\??\', [System.StringComparison]::OrdinalIgnoreCase)) {
        $candidate = $candidate.Substring(4)
    }
    if ([System.IO.Path]::IsPathFullyQualified($candidate)) {
        $absolute = [System.IO.Path]::GetFullPath($candidate)
    } elseif (![string]::IsNullOrEmpty($BasePath)) {
        $absolute = [System.IO.Path]::GetFullPath($candidate, $BasePath)
    } else {
        $absolute = [System.IO.Path]::GetFullPath($candidate)
    }
    $root = [System.IO.Path]::GetPathRoot($absolute)
    if ($absolute.Length -gt $root.Length) {
        return $absolute.TrimEnd('\', '/')
    }
    return $absolute
}

function Assert-ContainedPath([string]$Root, [string]$Candidate, [string]$Label) {
    $resolvedRoot = (Get-NormalizedAbsolutePath $Root).TrimEnd('\') + '\'
    $resolvedCandidate = Get-NormalizedAbsolutePath $Candidate
    if (!$resolvedCandidate.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label escaped its disposable root: $resolvedCandidate"
    }
    return $resolvedCandidate
}

function Assert-ExpectedJunction([string]$LinkPath, [string]$ExpectedTarget, [string]$ProfileRoot) {
    $resolvedLink = Assert-ContainedPath $ProfileRoot $LinkPath 'Packaged dev link'
    $linkItem = Get-Item -LiteralPath $resolvedLink -Force -ErrorAction Stop
    if ($linkItem.LinkType -ne 'Junction') {
        throw "Packaged dev link is not a Junction: $($linkItem.LinkType)"
    }
    $targets = @($linkItem.Target)
    if ($targets.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$targets[0])) {
        throw "Packaged dev Junction has an invalid target representation: $($targets -join ', ')"
    }
    $resolvedTarget = Get-NormalizedAbsolutePath ([string]$targets[0]) (Split-Path -Parent $resolvedLink)
    $resolvedExpectedTarget = Get-NormalizedAbsolutePath $ExpectedTarget
    if (![string]::Equals($resolvedExpectedTarget, $resolvedTarget, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Packaged dev Junction target mismatch. Expected $resolvedExpectedTarget, received $resolvedTarget"
    }
}

function Remove-ContainedReparseEntry([string]$LinkPath, [string]$ProfileRoot) {
    $resolvedLink = Assert-ContainedPath $ProfileRoot $LinkPath 'Packaged dev link cleanup'
    $linkItem = Get-Item -LiteralPath $resolvedLink -Force -ErrorAction SilentlyContinue
    if ($null -eq $linkItem) { return }
    if (($linkItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
        throw "Refusing to unlink a non-reparse packaged dev entry: $resolvedLink"
    }
    Remove-Item -LiteralPath $resolvedLink -Force
    if ($null -ne (Get-Item -LiteralPath $resolvedLink -Force -ErrorAction SilentlyContinue)) {
        throw "Packaged dev reparse entry remains after unlink: $resolvedLink"
    }
}

function Get-DisposableTreeSnapshot([string]$Root) {
    $resolvedRoot = Get-NormalizedAbsolutePath $Root
    $rootItem = Get-Item -LiteralPath $resolvedRoot -Force -ErrorAction SilentlyContinue
    if ($null -eq $rootItem) { return @("missing:$resolvedRoot") }
    if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        return @("root-reparse:$resolvedRoot`:$($rootItem.LinkType)`:$(@($rootItem.Target) -join '|')")
    }
    if (!$rootItem.PSIsContainer) {
        return @("root-file:$resolvedRoot`:$((Get-FileHash -LiteralPath $resolvedRoot -Algorithm SHA256).Hash)")
    }
    return @("root-directory:$resolvedRoot") + @(Get-ChildItem -LiteralPath $resolvedRoot -Recurse -Force |
        Sort-Object FullName |
        ForEach-Object {
            $relativePath = [System.IO.Path]::GetRelativePath($resolvedRoot, $_.FullName)
            if (($_.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                return "reparse:$relativePath`:$($_.LinkType)`:$(@($_.Target) -join '|')"
            }
            if ($_.PSIsContainer) { return "directory:$relativePath" }
            return "file:$relativePath`:$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)"
        })
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$archive = Join-Path $repoRoot 'dist\claude-plusplus-0.3.0-win-x64.zip'
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
$profileRoot = Join-Path $testRoot 'profile'
$mutationTarget = Join-Path $tempRoot ('claude-plusplus-package-link-target-' + [guid]::NewGuid().ToString('N'))
$mutationSentinel = Join-Path $mutationTarget 'sentinel.txt'
$extract = Join-Path $testRoot 'extract'
$liveLink = $null
$mutationJunctionInstalled = $false
New-Item -ItemType Directory -Path $extract -Force | Out-Null

try {
    Expand-Archive -LiteralPath $archive -DestinationPath $extract
    foreach ($required in @(
        'packages\runtime\dist\main.js',
        'packages\runtime\dist\preload\index.js',
        'packages\loader\loader.cjs',
        'packages\installer\dist\cli.js',
        'docs\tweak-authoring.md',
        'docs\tweaks\README.md',
        'docs\tweaks\getting-started.md',
        'docs\tweaks\manifest.md',
        'docs\tweaks\runtime-lifecycle.md',
        'docs\tweaks\api-reference.md',
        'docs\tweaks\typescript-and-bundling.md',
        'docs\tweaks\distribution-debugging.md',
        'store\index.json',
        'install.ps1',
        'LICENSE',
        'THIRD_PARTY_NOTICES.md'
    )) {
        if (!(Test-Path -LiteralPath (Join-Path $extract $required) -PathType Leaf)) {
            throw "Required release content is missing: $required"
        }
    }
    $tweakDocsIndex = Get-Content -LiteralPath (Join-Path $extract 'docs\tweaks\README.md') -Raw
    foreach ($relativeLink in @(
        './getting-started.md',
        './manifest.md',
        './runtime-lifecycle.md',
        './api-reference.md',
        './typescript-and-bundling.md',
        './distribution-debugging.md',
        '../tweak-authoring.md'
    )) {
        if (!$tweakDocsIndex.Contains("]($relativeLink)")) {
            throw "Packaged Tweak authoring index is missing relative link: $relativeLink"
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
        if (!(Test-Path -LiteralPath (Join-Path $packagedSdk $requiredSdkPath) -PathType Leaf)) {
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
        $liveRoot = Join-Path $env:APPDATA 'claude-plusplus\tweaks'
        $liveLink = Join-Path $liveRoot 'com.example.package-smoke'
        $liveMarker = Join-Path $liveRoot '.claudepp-dev-reload'
        $tweakSource = Join-Path $testRoot 'authoring\package-smoke'
        $commandHelpMutationRoots = @(
            $tweakSource,
            (Join-Path $env:APPDATA 'claude-plusplus'),
            (Join-Path $env:LOCALAPPDATA 'claude-plusplus'),
            (Join-Path $env:USERPROFILE '.claude-plusplus')
        )
        $beforeCommandHelp = @($commandHelpMutationRoots | ForEach-Object {
            Get-DisposableTreeSnapshot $_
        })
        foreach ($helpCase in @(
            @{
                Command = 'create-tweak'
                Description = 'Scaffold a new local Tweak'
                Usage = '$ claudeplusplus create-tweak <target> [options]'
                Options = @('--id <id>', '--name <display-name>', '--repo <owner/repo>', '--scope renderer|main|both', '--force', '-h, --help')
                Absent = @('--no-watch')
            },
            @{
                Command = 'validate-tweak'
                Description = 'Validate a Tweak manifest and entry point'
                Usage = '$ claudeplusplus validate-tweak [target] [options]'
                Options = @('-h, --help')
                Absent = @('--id <id>', '--no-watch')
            },
            @{
                Command = 'dev'
                Description = 'Link a Tweak into the Claude++ Tweaks directory for local development'
                Usage = '$ claudeplusplus dev [target] [options]'
                Options = @('--name <link-name>', '--replace', '--no-watch', '-h, --help')
                Absent = @('--scope renderer|main|both')
            }
        )) {
            foreach ($helpFlag in @('-h', '--help')) {
                $commandName = $helpCase.Command
                $commandHelpOutput = (& $command $commandName $helpFlag 2>&1 | Out-String).Trim()
                if ($LASTEXITCODE -ne 0) {
                    throw "Packaged $commandName $helpFlag exited with code $LASTEXITCODE`: $commandHelpOutput"
                }
                if (!$commandHelpOutput.Contains($helpCase.Usage)) {
                    throw "Packaged $commandName $helpFlag is missing usage: $($helpCase.Usage)"
                }
                if (!$commandHelpOutput.Contains("Description`n    $($helpCase.Description)") -and
                    !$commandHelpOutput.Contains("Description`r`n    $($helpCase.Description)")) {
                    throw "Packaged $commandName $helpFlag is missing its description: $($helpCase.Description)"
                }
                if ($commandHelpOutput.IndexOf('Description') -ge $commandHelpOutput.IndexOf('Usage') -or
                    $commandHelpOutput.IndexOf('Usage') -ge $commandHelpOutput.IndexOf('Options')) {
                    throw "Packaged $commandName $helpFlag has the wrong help section order"
                }
                foreach ($expectedOption in $helpCase.Options) {
                    if (!$commandHelpOutput.Contains($expectedOption)) {
                        throw "Packaged $commandName $helpFlag is missing option: $expectedOption"
                    }
                }
                foreach ($unexpectedOption in $helpCase.Absent) {
                    if ($commandHelpOutput.Contains($unexpectedOption)) {
                        throw "Packaged $commandName $helpFlag contains another command's option: $unexpectedOption"
                    }
                }
                $afterCommandHelp = @($commandHelpMutationRoots | ForEach-Object {
                    Get-DisposableTreeSnapshot $_
                })
                $commandHelpDifference = @(Compare-Object $beforeCommandHelp $afterCommandHelp)
                if ($commandHelpDifference.Count -ne 0) {
                    $differenceText = ($commandHelpDifference | Out-String).Trim()
                    throw "Packaged $commandName $helpFlag mutated protected profile or authoring state: $differenceText"
                }
                if ((Test-Path -LiteralPath $tweakSource) -or (Test-Path -LiteralPath $liveRoot)) {
                    throw "Packaged $commandName $helpFlag created authoring or live-profile state"
                }
            }
        }
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
        & $command create-tweak $tweakSource --id com.example.package-smoke --name 'Package Smoke' --repo example/package-smoke --scope both
        if ($LASTEXITCODE -ne 0) { throw 'Packaged create-tweak failed' }
        & $command validate-tweak $tweakSource
        if ($LASTEXITCODE -ne 0) { throw 'Packaged validate-tweak failed' }
        & $command dev $tweakSource --no-watch
        if ($LASTEXITCODE -ne 0) { throw 'Packaged dev --no-watch failed' }

        Assert-ExpectedJunction $liveLink $tweakSource $profileRoot
        if (!(Test-Path -LiteralPath $liveMarker)) {
            throw 'Packaged dev reload marker is missing'
        }
        Assert-ContainedPath $profileRoot $liveMarker 'Packaged dev marker' | Out-Null

        New-Item -ItemType Directory -Force -Path $mutationTarget | Out-Null
        Set-Content -LiteralPath $mutationSentinel -Value 'retained' -NoNewline
        Remove-ContainedReparseEntry $liveLink $profileRoot
        New-Item -ItemType Junction -Path $liveLink -Target $mutationTarget | Out-Null
        $mutationJunctionInstalled = $true
        $mutationRejected = $false
        try {
            Assert-ExpectedJunction $liveLink $tweakSource $profileRoot
        } catch {
            if (!$_.Exception.Message.StartsWith('Packaged dev Junction target mismatch.', [System.StringComparison]::Ordinal)) {
                throw
            }
            $mutationRejected = $true
        }
        if (!$mutationRejected) {
            throw 'Portable smoke accepted a Junction targeting an external directory'
        }
    } finally {
        $env:PATH = $previousPath
        $env:APPDATA = $previousAppData
        $env:LOCALAPPDATA = $previousLocalAppData
        $env:USERPROFILE = $previousUserProfile
    }
    if ($output -ne '0.3.0') {
        throw "Expected packaged CLI version 0.3.0, received: $output"
    }
} finally {
    $safeToRemoveDisposableRoots = $false
    try {
        if ($null -ne $liveLink) {
            Remove-ContainedReparseEntry $liveLink $profileRoot
        }
        if ($mutationJunctionInstalled) {
            if (!(Test-Path -LiteralPath $mutationSentinel -PathType Leaf)) {
                throw 'Defensive packaged dev link cleanup removed the external sentinel'
            }
            Write-Output 'Portable smoke rejected an external-target Junction and retained its sentinel during cleanup.'
            $mutationJunctionInstalled = $false
        }
        $safeToRemoveDisposableRoots = $true
    } finally {
        if ($safeToRemoveDisposableRoots) {
            $resolvedTestRoot = Get-NormalizedAbsolutePath $testRoot
            if (!$resolvedTestRoot.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
                $resolvedTestRoot -eq $tempRoot) {
                throw "Unsafe package-test cleanup target: $resolvedTestRoot"
            }
            Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force

            if (Test-Path -LiteralPath $mutationTarget) {
                $resolvedMutationTarget = Get-NormalizedAbsolutePath $mutationTarget
                if (!$resolvedMutationTarget.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
                    $resolvedMutationTarget -eq $tempRoot) {
                    throw "Unsafe package-link mutation cleanup target: $resolvedMutationTarget"
                }
                $mutationTargetItem = Get-Item -LiteralPath $resolvedMutationTarget -Force
                if (($mutationTargetItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                    throw "Package-link mutation cleanup root is a reparse point: $resolvedMutationTarget"
                }
                Remove-Item -LiteralPath $resolvedMutationTarget -Recurse -Force
            }
        }
    }
}
Write-Output "Packaged CLI version, status, Doctor, and Tweak authoring passed without system Node.js or npm on PATH."
Write-Output "Package SHA-256: $actualHash"
