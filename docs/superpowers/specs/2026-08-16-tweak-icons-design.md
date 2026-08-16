# Subagent Model and Claude API Skill Override Icon Design

## Goal

Give the `Subagent Model` and `Claude API Skill Override` Tweaks distinct, polished icons that belong to the same visual family as the existing GPT Context Window icon. Each Tweak must use the same artwork in the Tweak catalog and the Settings sidebar, with resolution-specific assets for each surface.

This work changes presentation only. It must not change either Tweak's settings, permissions, startup behavior, management state, or Claude Code configuration handling.

## Visual system

Both icons use the established GPT Context Window visual language:

- a rounded square app tile on a transparent outer canvas;
- deep blue glass with cyan and violet neon lighting;
- a bright, centered semantic symbol with strong silhouette contrast;
- subtle depth and gloss without fine details that disappear at 20px;
- balanced padding so the artwork remains legible when rendered in the Settings sidebar.

The two icons share materials, lighting, corner radius, and overall composition, but use different central symbols and accent colors.

### Subagent Model

The central symbol combines a model chip with a branching agent network. One primary node or chip branches into two smaller subordinate nodes, communicating that the selected model applies specifically to Claude Code subagents.

The dominant accents are cyan and electric violet. The branch geometry must remain visually distinct at 20px and must not resemble a generic contacts or users icon.

### Claude API Skill Override

The central symbol combines a modular skill or API tile with a clear disabled-state slash. It communicates that one bundled skill is overridden to `off`, without suggesting deletion, global API shutdown, or destructive system behavior.

The tile remains blue and violet, with a restrained warm orange-red highlight on the disable mark. The slash and module silhouette must remain clear at 20px; text such as `API` is avoided because it would become illegible when reduced.

## Asset architecture

Each Tweak project receives a local manifest asset:

- `E:\workspace\subagent-model\icon.png`
- `E:\workspace\claude-api-skill-override\icon.png`

Each file must be:

- PNG;
- exactly 1024 × 1024 pixels;
- no larger than 1 MiB;
- transparent outside the rounded tile.

Each `manifest.json` declares:

```json
"iconUrl": "./icon.png"
```

A 128 × 128 reduction of each approved icon is encoded as a PNG data URL in that Tweak's `index.js`. The Settings page uses the same wrapper pattern as GPT Context Window:

```js
iconSvg: [
  "<svg width=\"20\" height=\"20\" viewBox=\"0 0 20 20\" fill=\"none\" ",
  "class=\"icon-sm inline-block align-middle\" aria-hidden=\"true\">",
  `<image width="20" height="20" href="${TWEAK_ICON_DATA_URL}"/></svg>`,
].join("")
```

The current unrelated monochrome line icons are removed. No new runtime dependency or filesystem read is introduced; the reduced sidebar artwork remains self-contained in the Tweak module.

## Implementation boundaries

The implementation changes only:

- the two new `icon.png` files;
- each Tweak's `manifest.json` icon declaration;
- each Tweak's `index.js` sidebar icon constant and wrapper;
- icon-related tests.

It does not change:

- `CLAUDE_CODE_SUBAGENT_MODEL` handling;
- `skillOverrides.claude-api` handling;
- Claude Code user settings during install or load;
- manifest permissions or declared settings paths;
- Tweak identifiers, versions, or minimum Runtime versions;
- installed Junction targets.

## Validation

Each project adds or updates tests that verify:

1. `manifest.iconUrl` is exactly `./icon.png`.
2. The declared file has the PNG signature.
3. The PNG IHDR width and height are both 1024.
4. The file is at most 1,048,576 bytes.
5. The Renderer settings page includes a PNG data URL.
6. The sidebar wrapper is a 20 × 20 SVG containing a 20 × 20 image.
7. The former `currentColor` line-art icon is no longer used.

After the asset and source changes:

- run each Tweak's complete standalone test suite;
- run each real-host Claude++ compatibility validator;
- run each Junction safety regression test;
- verify both installed Junctions still resolve to the modified source directories and remain injectable;
- verify the Claude Code user settings file was not changed by the icon work.

## Acceptance criteria

The work is complete when both Tweaks show distinct icons in the Tweak catalog and matching icons in the Settings sidebar, the icons remain recognizable at 20px, all icon and regression tests pass, both existing source Junctions remain injectable, and no functional or user-settings state has changed.
