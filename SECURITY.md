# Security Policy

## Supported Versions

Only the latest released version receives security fixes while Claude++ is in alpha.

## Reporting a Vulnerability

Use GitHub's private vulnerability reporting for this repository. Do not open a public issue for a suspected exploit
path.

Include:

- Affected Claude++ version or commit.
- Windows and Claude Desktop versions.
- Reproduction steps.
- Impact and any proof-of-concept details.

## Tweak Update Policy

Tweaks are local code and should be treated as untrusted until reviewed. The public Store accepts only reviewed
entries pinned to an approved full Git commit. Review repository ownership, changed files, permissions, network
behavior, and release notes before installing or updating a Tweak.

## Runtime Boundaries

Renderer Tweaks run in Claude's preload context and can modify the Claude UI. Main-process Tweaks can use the generic
Main APIs exposed by Claude++. Install only Tweaks from sources you trust.

Claude++ installs into a managed mirror. It does not modify the official WindowsApps package, write Windows registry
entries, or install a localhost receiver.
