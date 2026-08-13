# Contributing

## Development

Claude++ targets Windows and requires Node.js 24 or newer when building from source.

```powershell
npm ci
npm test
npm run package:windows
```

Runtime code lives in `packages/runtime`, public Tweak author types live in `packages/sdk`, Loader code lives in
`packages/loader`, and install/maintenance commands live in `packages/installer`.

Workflow-specific Tweaks are developed and distributed from their own repositories. Do not vendor private Tweak
source or metadata into this repository or the public Store.

## Release Checklist

1. Update all package versions using semantic versioning.
2. Update `CHANGELOG.md` and the matching document under `docs/releases`.
3. Run `npm test`.
4. Run `npm run package:windows` and verify the generated checksum.
5. Test install, status, Doctor, repair, update, launch, and uninstall against the supported Claude Desktop build.
6. Confirm the official Claude executable and `app.asar` remain unchanged.
7. Create a GitHub Release with a semantic version tag.
