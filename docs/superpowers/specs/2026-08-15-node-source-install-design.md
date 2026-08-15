# Node.js Source Installation Design

## Goal

Make the root `install.ps1` support both the self-contained Windows release and a Git source checkout. A source
checkout must use an already installed system Node.js and npm; the script must never download or install Node.js.

## Current Failure

The source repository contains `bin\claudeplusplus.js`, while `bin\claudeplusplus.cmd` is generated only when the
Windows release is packaged. The current `install.ps1` always requires the generated `.cmd` launcher after copying
the source into `%USERPROFILE%\.claude-plusplus\source`, so running it from a source checkout fails with
`Bundled Claude++ CLI is missing`.

## Installation Modes

`install.ps1` determines the mode from the files in its original source directory before copying anything:

- **Packaged release:** `bin\claudeplusplus.cmd` exists. Preserve the existing self-contained path and invoke the
  copied `.cmd` launcher. No system Node.js or npm is required.
- **Source checkout:** the packaged launcher is absent and `bin\claudeplusplus.js` exists. Validate the system
  toolchain, build the checkout, copy it into the managed source directory, and invoke the copied JavaScript launcher
  with the validated system Node.js executable.
- **Invalid payload:** neither launcher exists. Stop with an error that identifies both expected launcher paths.

The mode is selected from the original source directory so stale files in an existing managed source directory cannot
cause a source checkout to be mistaken for a packaged release.

## Source Checkout Flow

For source mode, `install.ps1` performs these steps in order:

1. Resolve `node.exe` from `PATH`. If it is unavailable, print an actionable error requiring Node.js 24 or newer and
   exit with a non-zero status.
2. Run `node --version`, parse the major version, and reject an invalid version string or a version below 24.
3. Resolve `npm.cmd` from `PATH`. If it is unavailable, explain that npm is required and exit with a non-zero status.
4. In the original checkout, run the repository-equivalent dependency and build commands:
   `npm ci --workspaces --include-workspace-root --ignore-scripts`, followed by `npm run build`.
5. Copy the now-built checkout into `%USERPROFILE%\.claude-plusplus\source` using the existing managed-root guard.
6. Invoke the copied `bin\claudeplusplus.js install` with the exact Node.js executable validated in step 1.

Every external command is checked. A failed version query, dependency install, build, or Claude++ CLI invocation stops
the script and reports the failing command or phase.

## Packaged Release Compatibility

The packaged path remains unchanged: copy the extracted payload to the managed source directory, then run the copied
`bin\claudeplusplus.cmd install`. The release continues to use `toolchain\node.exe` through that launcher and must work
when neither system Node.js nor npm is on `PATH`.

## Testing

Add a Node test that executes a temporary copy of `install.ps1` with isolated `USERPROFILE`, `APPDATA`, and
`LOCALAPPDATA` paths and controlled command shims. It covers:

- a packaged payload choosing `claudeplusplus.cmd` without probing system Node.js;
- a source payload with Node.js 24 and npm running dependency installation, build, and the copied JavaScript launcher;
- source mode with Node.js missing producing the actionable error and no build attempt;
- source mode with Node.js 23 producing the version error and no build attempt;
- an invalid payload producing a launcher-specific error.

The existing full test suite and Windows packaging test remain the regression checks for the release payload.

## Scope

This change affects only installation entry-point selection, source toolchain validation, source build orchestration,
and associated documentation/tests. It does not publish an npm package, add global npm installation, download Node.js,
change the managed Claude mirror, or alter update-channel behavior.
