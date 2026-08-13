# Third-Party Notices

## Codex++

Parts of Claude++ originate from the following fixed Codex++ source snapshot:

- Repository: https://github.com/b-nnett/codex-plusplus
- Release tag: `v1.0.0`
- Commit: `f98e7e9d1fa068dde9e0dddfb43b128acb4e2fd7`
- License: MIT License, reproduced in the repository root `LICENSE`
- Copyright: Copyright (c) 2026 Bennett

Copied and modified areas include general installer, ASAR Loader, Runtime lifecycle, and Tweak SDK infrastructure.
Codex-, Owl-, AppKit-, Metal-, Homebrew-, macOS-, and Linux-specific implementations are not part of Claude++.

Claude++ is an unofficial, independently maintained modification. It is not an official fork, partnership, or
runtime dependency of Codex++.

## Portable Node.js Runtime

The Windows release contains Node.js v24.19.0 from https://nodejs.org/ so users do not need a system Node.js or npm
installation. Node.js is distributed under its upstream license, included as `toolchain/NODE_LICENSE` in the release.

Production npm dependencies retain their package metadata and license files under `node_modules` in the release.
