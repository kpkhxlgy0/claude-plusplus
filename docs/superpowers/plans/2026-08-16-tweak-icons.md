# Tweak Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add distinct GPT Context Window-style icons to the Subagent Model and Claude API Skill Override Tweaks, using local 1024px PNG assets in each manifest and matching embedded 128px PNGs in their 20px Settings sidebar entries.

**Architecture:** Each project owns one `icon.png` and embeds a reduced copy as a `data:image/png;base64` constant in `index.js`, following the existing GPT Context Window pattern. Tests validate both binary assets and sidebar embedding; the final verification uses the existing source Junction injection flow and does not build archives.

**Tech Stack:** CommonJS JavaScript, Node.js test runner, JSON Tweak manifests, ImageMagick, Claude++ compatibility scripts, PowerShell 7 Junction injection scripts.

## Global Constraints

- Presentation only: do not change Tweak behavior, settings, permissions, startup handling, management state, IDs, versions, or minimum Runtime versions.
- Do not write or otherwise mutate `C:\Users\user\.claude\settings.json`.
- Do not rebuild or update either `0.1.0.zip` archive.
- Do not add runtime dependencies or read icon files dynamically at runtime.
- Each manifest icon must be a PNG exactly 1024 × 1024 pixels and at most 1,048,576 bytes.
- Each Settings sidebar icon must embed a 128 × 128 PNG data URL inside the existing 20 × 20 SVG wrapper.
- Keep the installed Junction targets at `E:\workspace\subagent-model` and `E:\workspace\claude-api-skill-override`.
- Do not commit, push, or tag any repository.

## File Structure

### Subagent Model

- Create `E:\workspace\subagent-model\icon.png`: 1024px manifest and catalog icon.
- Modify `E:\workspace\subagent-model\manifest.json`: declare `"iconUrl": "./icon.png"`.
- Modify `E:\workspace\subagent-model\index.js`: define the embedded PNG data URL and use the image-backed sidebar wrapper.
- Modify `E:\workspace\subagent-model\test\manifest.test.js`: validate the local PNG contract.
- Modify `E:\workspace\subagent-model\test\index.test.js`: validate the embedded 128px sidebar icon.

### Claude API Skill Override

- Create `E:\workspace\claude-api-skill-override\icon.png`: 1024px manifest and catalog icon.
- Modify `E:\workspace\claude-api-skill-override\manifest.json`: declare `"iconUrl": "./icon.png"`.
- Modify `E:\workspace\claude-api-skill-override\index.js`: define the embedded PNG data URL and use the image-backed sidebar wrapper.
- Modify `E:\workspace\claude-api-skill-override\test\manifest.test.js`: validate the local PNG contract.
- Modify `E:\workspace\claude-api-skill-override\test\index.test.js`: validate the embedded 128px sidebar icon.

### Coordination documentation

- Modify `E:\workspace\claude-plusplus\docs\superpowers\specs\2026-08-16-tweak-icons-design.md`: retain the approved no-archive, Junction-injection scope.
- Create `E:\workspace\claude-plusplus\docs\superpowers\plans\2026-08-16-tweak-icons.md`: this implementation plan.

---

### Task 1: Add the Subagent Model icon

**Files:**
- Create: `E:\workspace\subagent-model\icon.png`
- Modify: `E:\workspace\subagent-model\manifest.json:5-7`
- Modify: `E:\workspace\subagent-model\index.js:1-12,108-122`
- Modify: `E:\workspace\subagent-model\test\manifest.test.js:1-22`
- Modify: `E:\workspace\subagent-model\test\index.test.js:122-139`

**Interfaces:**
- Consumes: the existing `createSettingsPage(api, injectedDeps)` settings-page contract and the GPT Context Window image-backed `iconSvg` convention.
- Produces: `manifest.iconUrl === "./icon.png"`, a valid 1024px `icon.png`, and a 128px PNG embedded in `createSettingsPage(...).iconSvg`.

- [ ] **Step 1: Record the Claude Code settings baseline**

Run:

```bash
sha256sum /c/Users/user/.claude/settings.json
```

Expected: one SHA-256 hash followed by `/c/Users/user/.claude/settings.json`. Save the hash in the work log for comparison in Task 3; do not edit the file.

- [ ] **Step 2: Write the failing manifest icon test**

In `E:\workspace\subagent-model\test\manifest.test.js`, change the filesystem import and replace the old undefined-icon assertion with a dedicated binary-asset test:

```js
const { readFileSync, statSync } = require("node:fs");
```

Keep the contract test, but change its final assertion to:

```js
assert.equal(manifest.iconUrl, "./icon.png");
```

Then append:

```js
test("ships the declared 1024px local Tweak icon within Claude++ limits", () => {
  const iconPath = resolve(root, manifest.iconUrl);
  const icon = readFileSync(iconPath);
  assert.equal(icon.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(icon.readUInt32BE(16), 1024);
  assert.equal(icon.readUInt32BE(20), 1024);
  assert.ok(statSync(iconPath).size <= 1_048_576);
});
```

- [ ] **Step 3: Write the failing sidebar icon test**

After the existing `Renderer registers one settings page and disposes every listener` test in `E:\workspace\subagent-model\test\index.test.js`, add:

```js
test("Renderer settings page embeds the 128px Tweak icon for sidebar navigation", () => {
  const fixture = rendererFixture();
  const lifecycle = __test.startRenderer(fixture.api, { documentApi: fixture.document });

  assert.match(fixture.registered.iconSvg, /<svg[^>]*width="20"[^>]*height="20"/);
  assert.equal(fixture.registered.iconSvg.includes("currentColor"), false);
  const embedded = fixture.registered.iconSvg.match(/href="data:image\/png;base64,([^"]+)"/);
  assert.ok(embedded);
  const icon = Buffer.from(embedded[1], "base64");
  assert.equal(icon.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(icon.readUInt32BE(16), 128);
  assert.equal(icon.readUInt32BE(20), 128);

  lifecycle.stop();
});
```

- [ ] **Step 4: Run the focused tests and verify they fail for the missing icon implementation**

Run:

```bash
node --test E:/workspace/subagent-model/test/manifest.test.js E:/workspace/subagent-model/test/index.test.js
```

Expected: failures because `manifest.iconUrl` is still undefined, `icon.png` does not exist, and the sidebar still uses `currentColor` line art.

- [ ] **Step 5: Generate the Subagent Model source artwork**

Call the image generation tool with this exact prompt:

```text
Create a single premium app icon for a developer tool named Subagent Model. Square 1024x1024 composition, transparent canvas outside one centered rounded-square tile. Match a polished dark navy glass and neon visual family: deep blue translucent tile, cyan and electric-violet rim lighting, glossy dimensional depth, clean high-contrast silhouette. The central symbol is a luminous model processor chip that branches into exactly two smaller subordinate agent nodes, clearly communicating one selected model feeding subagents. Make the branch geometry bold and readable at 20 pixels; it must not look like a generic contacts or people icon. No letters, no words, no logos, no border outside the tile, no extra objects, no mockup background. Keep generous internal padding and crisp edges.
```

Save the generated PNG temporarily as `E:\workspace\subagent-model\.icon-source.png`.

Inspect the image with the Read tool. Reject and regenerate it if the central chip, two branches, or transparent outer canvas is unclear.

- [ ] **Step 6: Normalize and compress the 1024px manifest asset**

Run:

```bash
magick E:/workspace/subagent-model/.icon-source.png -alpha on -resize "1024x1024^" -gravity center -extent 1024x1024 -strip -dither FloydSteinberg -colors 256 -define png:compression-level=9 PNG8:E:/workspace/subagent-model/icon.png
```

Run:

```bash
magick identify -format "%m %wx%h %[channels] %b\n" E:/workspace/subagent-model/icon.png
```

Expected: `PNG 1024x1024` with an alpha-capable channel description and a size no greater than 1 MiB. Inspect `icon.png` with the Read tool and confirm the reduced palette did not introduce visible banding around the central symbol.

- [ ] **Step 7: Produce the 128px sidebar asset and deterministic JavaScript constant**

Run:

```bash
magick E:/workspace/subagent-model/icon.png -filter Lanczos -resize 128x128 -strip -dither FloydSteinberg -colors 256 -define png:compression-level=9 PNG8:E:/workspace/subagent-model/.icon-sidebar.png
```

Run:

```bash
node -e "const fs=require('node:fs');const value=fs.readFileSync(process.argv[1]).toString('base64');const chunks=value.match(/.{1,100}/g)||[];const lines=['const TWEAK_ICON_DATA_URL = [','  \"data:image/png;base64,\"',...chunks.map((chunk)=>'  '+JSON.stringify(chunk)+','),'].join(\"\");',''];fs.writeFileSync(process.argv[2],lines.join('\\n'));" E:/workspace/subagent-model/.icon-sidebar.png E:/workspace/subagent-model/.icon-constant.txt
```

Read `E:\workspace\subagent-model\.icon-constant.txt`; it contains the complete constant to insert without hand-editing binary data.

- [ ] **Step 8: Declare the manifest icon**

In `E:\workspace\subagent-model\manifest.json`, insert the field directly after `githubRepo`:

```json
"iconUrl": "./icon.png",
```

Do not change any other manifest field.

- [ ] **Step 9: Embed the sidebar icon in `index.js`**

Insert the complete generated `TWEAK_ICON_DATA_URL` constant from `.icon-constant.txt` after `PRESET_MODELS` and before the lifecycle state variables.

Replace the existing line-art `iconSvg` block with:

```js
iconSvg: [
  "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" ",
  "class=\"icon-sm inline-block align-middle\" aria-hidden=\"true\">",
  `<image width="20" height="20" href="${TWEAK_ICON_DATA_URL}"/></svg>`,
].join(""),
```

Do not change the page ID, title, description, render function, settings flow, or exports.

- [ ] **Step 10: Remove generated temporary files**

Confirm `icon.png` exists and `.icon-constant.txt` was inserted, then remove only the two temporary files created in Steps 5 and 7:

```bash
rm E:/workspace/subagent-model/.icon-source.png E:/workspace/subagent-model/.icon-sidebar.png E:/workspace/subagent-model/.icon-constant.txt
```

- [ ] **Step 11: Run the focused and complete Subagent Model tests**

Run:

```bash
node --test E:/workspace/subagent-model/test/manifest.test.js E:/workspace/subagent-model/test/index.test.js
```

Expected: all focused tests pass.

Run:

```bash
npm --prefix E:/workspace/subagent-model test
```

Expected: all Subagent Model unit and compatibility-fixture tests pass with zero failures.

- [ ] **Step 12: Check the Subagent Model diff**

Run:

```bash
git -C E:/workspace/subagent-model diff --check
```

Expected: no output and exit code 0. Confirm the diff contains only `icon.png`, `manifest.json`, `index.js`, and the two icon-related test files.

---

### Task 2: Add the Claude API Skill Override icon

**Files:**
- Create: `E:\workspace\claude-api-skill-override\icon.png`
- Modify: `E:\workspace\claude-api-skill-override\manifest.json:5-7`
- Modify: `E:\workspace\claude-api-skill-override\index.js:1-10,185-198`
- Modify: `E:\workspace\claude-api-skill-override\test\manifest.test.js:1-23`
- Modify: `E:\workspace\claude-api-skill-override\test\index.test.js:288-304`

**Interfaces:**
- Consumes: the existing `createSettingsPage(api, injectedDeps)` contract and exact-path Claude Code settings behavior, which must remain untouched.
- Produces: `manifest.iconUrl === "./icon.png"`, a valid 1024px `icon.png`, and a 128px PNG embedded in the Settings sidebar without any settings write.

- [ ] **Step 1: Write the failing manifest icon test**

In `E:\workspace\claude-api-skill-override\test\manifest.test.js`, change the filesystem import to:

```js
const { readFileSync, statSync } = require("node:fs");
```

Change the final icon assertion in the contract test to:

```js
assert.equal(manifest.iconUrl, "./icon.png");
```

Append:

```js
test("ships the declared 1024px local Tweak icon within Claude++ limits", () => {
  const iconPath = resolve(root, manifest.iconUrl);
  const icon = readFileSync(iconPath);
  assert.equal(icon.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(icon.readUInt32BE(16), 1024);
  assert.equal(icon.readUInt32BE(20), 1024);
  assert.ok(statSync(iconPath).size <= 1_048_576);
});
```

- [ ] **Step 2: Write the failing sidebar icon test**

After `Renderer registers one page and disposes every listener` in `E:\workspace\claude-api-skill-override\test\index.test.js`, add:

```js
test("Renderer settings page embeds the 128px Tweak icon for sidebar navigation", () => {
  const fixture = rendererFixture();
  const lifecycle = tweak.__test.startRenderer(fixture.api, { documentApi: fixture.document });

  assert.match(fixture.registered.iconSvg, /<svg[^>]*width="20"[^>]*height="20"/);
  assert.equal(fixture.registered.iconSvg.includes("currentColor"), false);
  const embedded = fixture.registered.iconSvg.match(/href="data:image\/png;base64,([^"]+)"/);
  assert.ok(embedded);
  const icon = Buffer.from(embedded[1], "base64");
  assert.equal(icon.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(icon.readUInt32BE(16), 128);
  assert.equal(icon.readUInt32BE(20), 128);

  lifecycle.stop();
});
```

- [ ] **Step 3: Run the focused tests and verify they fail for the missing icon implementation**

Run:

```bash
node --test E:/workspace/claude-api-skill-override/test/manifest.test.js E:/workspace/claude-api-skill-override/test/index.test.js
```

Expected: failures because `manifest.iconUrl` is undefined, `icon.png` does not exist, and the sidebar still uses `currentColor` line art. Existing tests proving startup and first load do not mutate Claude Code settings must remain green.

- [ ] **Step 4: Generate the Claude API Skill Override source artwork**

Call the image generation tool with this exact prompt:

```text
Create a single premium app icon for a developer tool named Claude API Skill Override. Square 1024x1024 composition, transparent canvas outside one centered rounded-square tile. Match a polished dark navy glass and neon visual family: deep blue translucent tile, cyan and electric-violet rim lighting, glossy dimensional depth, clean high-contrast silhouette. The central symbol is one modular skill or API component tile with a bold diagonal disabled-state slash across it, communicating that exactly one bundled skill is overridden to off. Use a restrained warm orange-red glow only on the disable slash. It must not suggest deleting files, shutting down all APIs, blocking the whole application, or destructive behavior. Make the module and slash readable at 20 pixels. No letters, no words, no logos, no border outside the tile, no extra objects, no mockup background. Keep generous internal padding and crisp edges.
```

Save the generated PNG temporarily as `E:\workspace\claude-api-skill-override\.icon-source.png`.

Inspect the image with the Read tool. Reject and regenerate it if the single module, disable slash, or transparent outer canvas is unclear, or if the icon looks like a global shutdown symbol.

- [ ] **Step 5: Normalize and compress the 1024px manifest asset**

Run:

```bash
magick E:/workspace/claude-api-skill-override/.icon-source.png -alpha on -resize "1024x1024^" -gravity center -extent 1024x1024 -strip -dither FloydSteinberg -colors 256 -define png:compression-level=9 PNG8:E:/workspace/claude-api-skill-override/icon.png
```

Run:

```bash
magick identify -format "%m %wx%h %[channels] %b\n" E:/workspace/claude-api-skill-override/icon.png
```

Expected: `PNG 1024x1024`, alpha-capable channels, and no more than 1 MiB. Inspect the final image with the Read tool and confirm the warm slash remains distinct without overpowering the blue-violet family.

- [ ] **Step 6: Produce the 128px sidebar asset and deterministic JavaScript constant**

Run:

```bash
magick E:/workspace/claude-api-skill-override/icon.png -filter Lanczos -resize 128x128 -strip -dither FloydSteinberg -colors 256 -define png:compression-level=9 PNG8:E:/workspace/claude-api-skill-override/.icon-sidebar.png
```

Run:

```bash
node -e "const fs=require('node:fs');const value=fs.readFileSync(process.argv[1]).toString('base64');const chunks=value.match(/.{1,100}/g)||[];const lines=['const TWEAK_ICON_DATA_URL = [','  \"data:image/png;base64,\"',...chunks.map((chunk)=>'  '+JSON.stringify(chunk)+','),'].join(\"\");',''];fs.writeFileSync(process.argv[2],lines.join('\\n'));" E:/workspace/claude-api-skill-override/.icon-sidebar.png E:/workspace/claude-api-skill-override/.icon-constant.txt
```

Read `E:\workspace\claude-api-skill-override\.icon-constant.txt` and insert the complete generated constant without manually altering its base64 data.

- [ ] **Step 7: Declare the manifest icon**

In `E:\workspace\claude-api-skill-override\manifest.json`, insert directly after `githubRepo`:

```json
"iconUrl": "./icon.png",
```

Do not change permissions, `claudeCodeSettings.paths`, version, or minimum Runtime.

- [ ] **Step 8: Embed the sidebar icon in `index.js`**

Insert the complete generated `TWEAK_ICON_DATA_URL` constant after `REVISION_PATTERN` and before lifecycle state variables.

Replace the current line-art `iconSvg` block with:

```js
iconSvg: [
  "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" ",
  "class=\"icon-sm inline-block align-middle\" aria-hidden=\"true\">",
  `<image width="20" height="20" href="${TWEAK_ICON_DATA_URL}"/></svg>`,
].join(""),
```

Do not change the settings state machine, Main handlers, page copy, save actions, or exports.

- [ ] **Step 9: Remove generated temporary files**

Confirm `icon.png` exists and the constant is present in `index.js`, then remove only:

```bash
rm E:/workspace/claude-api-skill-override/.icon-source.png E:/workspace/claude-api-skill-override/.icon-sidebar.png E:/workspace/claude-api-skill-override/.icon-constant.txt
```

- [ ] **Step 10: Run focused and complete Override tests**

Run:

```bash
node --test E:/workspace/claude-api-skill-override/test/manifest.test.js E:/workspace/claude-api-skill-override/test/index.test.js
```

Expected: all focused tests pass, including startup and first-load no-write assertions.

Run:

```bash
npm --prefix E:/workspace/claude-api-skill-override test
```

Expected: all Claude API Skill Override unit and compatibility-fixture tests pass with zero failures.

- [ ] **Step 11: Check the Override diff**

Run:

```bash
git -C E:/workspace/claude-api-skill-override diff --check
```

Expected: no output and exit code 0. Confirm the diff contains only `icon.png`, `manifest.json`, `index.js`, and the two icon-related test files.

---

### Task 3: Validate compatibility and inject both source Tweaks

**Files:**
- Verify only: `E:\workspace\subagent-model\scripts\compatibility\validate-claudeplusplus.mjs`
- Verify only: `E:\workspace\claude-api-skill-override\scripts\compatibility\validate-claudeplusplus.mjs`
- Verify only: both `Inject-ClaudePlusPlus.ps1` entry points and installed Junctions.
- Verify unchanged: `C:\Users\user\.claude\settings.json`

**Interfaces:**
- Consumes: both completed icon implementations, Claude++ Runtime 0.2.5 source APIs, and each project's Junction installer.
- Produces: real-host compatibility passes, safe/current source Junctions, and proof that icon work did not modify Claude Code user settings.

- [ ] **Step 1: Run both real-host Claude++ compatibility validators**

Run:

```bash
node --import tsx E:/workspace/subagent-model/scripts/compatibility/validate-claudeplusplus.mjs E:/workspace/claude-plusplus E:/workspace/subagent-model
```

Expected:

```text
claudeplusplus-compatibility=passed runtime=0.2.5 tweak=0.1.0
```

Run:

```bash
node --import tsx E:/workspace/claude-api-skill-override/scripts/compatibility/validate-claudeplusplus.mjs E:/workspace/claude-plusplus E:/workspace/claude-api-skill-override
```

Expected:

```text
claudeplusplus-compatibility=passed runtime=0.2.5 tweak=0.1.0
```

The Override validator must continue to report success without creating or mutating a settings file in its temporary user root.

- [ ] **Step 2: Run both Junction safety regression suites**

Run:

```bash
pwsh -NoProfile -File E:/workspace/subagent-model/scripts/test/TweakLink.Tests.ps1
```

Expected:

```text
PASS Subagent Model Junction safety
```

Run:

```bash
pwsh -NoProfile -File E:/workspace/claude-api-skill-override/scripts/test/TweakLink.Tests.ps1
```

Expected:

```text
PASS Claude API Skill Override Junction safety
```

- [ ] **Step 3: Apply the idempotent source injections**

Run:

```bash
pwsh -NoProfile -File E:/workspace/subagent-model/Inject-ClaudePlusPlus.ps1
```

Expected: `Status: Current` followed by `The Subagent Model Tweak Junction is already current.` If it was missing, the script may safely create the Junction and report that Claude must reload it.

Run:

```bash
pwsh -NoProfile -File E:/workspace/claude-api-skill-override/Inject-ClaudePlusPlus.ps1
```

Expected: `Status: Current` followed by `The Claude API Skill Override Tweak Junction is already current.` If missing, the script may safely create it.

- [ ] **Step 4: Verify both live Junctions resolve to the intended source**

Run:

```bash
pwsh -NoProfile -File E:/workspace/subagent-model/Inject-ClaudePlusPlus.ps1 -CheckOnly
```

Expected output includes:

```text
Status: Current
Current target: E:\workspace\subagent-model
```

Run:

```bash
pwsh -NoProfile -File E:/workspace/claude-api-skill-override/Inject-ClaudePlusPlus.ps1 -CheckOnly
```

Expected output includes:

```text
Status: Current
Current target: E:\workspace\claude-api-skill-override
```

- [ ] **Step 5: Re-run both complete Tweak test suites after injection**

Run:

```bash
npm --prefix E:/workspace/subagent-model test
```

Expected: zero failures.

Run:

```bash
npm --prefix E:/workspace/claude-api-skill-override test
```

Expected: zero failures, including every no-write and recovery-state test.

- [ ] **Step 6: Verify Claude Code user settings are byte-for-byte unchanged**

Run:

```bash
sha256sum /c/Users/user/.claude/settings.json
```

Expected: the hash exactly matches the baseline recorded in Task 1 Step 1. If it differs, stop and inspect the byte-level diff before any further action; icon generation and Junction injection are not permitted to change this file.

- [ ] **Step 7: Run final repository checks without packaging or commits**

Run:

```bash
git -C E:/workspace/subagent-model diff --check
```

Expected: exit code 0.

Run:

```bash
git -C E:/workspace/claude-api-skill-override diff --check
```

Expected: exit code 0.

Run:

```bash
git -C E:/workspace/claude-plusplus diff --check
```

Expected: exit code 0. Do not build ZIP archives and do not commit, push, or tag.
