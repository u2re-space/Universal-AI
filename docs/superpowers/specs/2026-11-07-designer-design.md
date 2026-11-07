# Designer: optional design stage with templates and assets

**Date:** 2026-11-07  
**Status:** draft for discussion

## Goal

Add an **optional** `design` stage and a `designer` role that can generate page templates, visual layouts, and image assets from a task description — even when no reference images are attached. The designer reads any attached images, pulls style data from external sources (e.g. UI gradient/style resources), and may consult a project-local `DESIGN.md`. Its output feeds the downstream `decomposer`, `measurer`, `styler`, and `decorator` roles. The designer is expensive (default model `gpt-6.1-terra` with `xhigh` effort) and optional, so it is off by default.

## Non-goals

- Changing the existing pipeline roles (planner, measurer, architect, worker, etc.).
- Replacing `image-processor` or `decorator`. The designer generates *templates* and *visual direction*; `image-processor` still handles generation/editing of raster assets; `decorator` still builds ornamental SVG/CSS.
- Replacing the `decomposer`. The designer may produce sub-references itself, but does not inherit the decomposer's Figma node resolution or restoration logic.
- Adding a dedicated `DESIGN.md` discovery system. The designer simply reads the file if it exists; it does not change `agents.md` discovery or injection.
- Making the designer part of the default pipeline. It is `off` by default and must be enabled explicitly.

## Decisions

### 1. Stage position

The `design` stage runs **before** `decompose`, `measure`, and `architect`.

```
answer → classify → plan → design → decompose → measure → architect → collect → images → decor → work → iconify → review → outcome → memory
```

Dependencies:
- `after: ['plan']` — soft dependency; design should see the plan's complexity and pipeline.
- `requires: []` — no hard dependency; the stage can run standalone once the planner produces a plan.

The decomposer and measurer keep their existing `after: ['plan']` and `requires: ['plan', 'decompose']`. When `design` is present, it sits between `plan` and `decompose`.

### 2. Role definition

| Field | Value |
| --- | --- |
| name | `designer` |
| model | `gpt-6.1-terra` (default) |
| effort | `xhigh` |
| imageModel | inherited from top-level `imageModel` (e.g. `openai/gpt-image-2.6-sunburst`) |
| maxTurns | 16 |
| tools | `'images'` slice (view, crop, split, generate, edit) + read-only tools + `fetch_url` |

The designer uses the same `imageModel` as the run's `image-processor` by default, but the config allows overriding it via `roles.designer.imageModel`.

### 3. Optional pipeline flag

A new config field and CLI flag enable the stage:

- Config: `agent.design: 'off' | 'auto' | 'always'` (default `'off'`)
- `auto` = enable when the task mentions design, layout, mockup, template, style guide, or when `DESIGN.md` exists in the project root
- `always` = always run
- `off` = never run (default)

CLI flag: `--design on|off|auto` (maps to `agent.design`).

### 4. Designer prompt

The designer prompt lives in `src/roles/designer.js` and follows the same pattern as other roles:

```js
export const instructions = `You are the designer of a team of AI agents ...
You work after the planner and before the decomposer and the measurer.
Your job: produce a visual design direction, a page template (HTML structure),
and optional asset references. You may generate images using generate_image.
Read DESIGN.md if present for project-specific design tokens and conventions.
Your output goes to shared context and .tmp/<id>/design.json.`;
```

The prompt instructs the designer to:
1. Read attached images (if any) and `DESIGN.md` (if present).
2. Optionally fetch style data from external resources (e.g. gradient/style resources, font pairs, color palettes).
3. Produce a design direction: layout structure, color palette, typography, spacing scale, and visual style.
4. Generate a minimal HTML template skeleton (structure only, no content styling).
5. Generate or reference any needed visual assets (backgrounds, illustrations, hero images) via `generate_image`.
6. Output a `design.json` report and the template to the working directory.

### 5. JSON schema

A new `DESIGNER_SCHEMA` in `src/agent/schemas.js`:

```json
{
  "summary": "string — what the design direction covers",
  "layout": {
    "summary": "string — page structure and component layout",
    "structure": [
      {
        "name": "string — section or component name",
        "type": "enum: header | hero | grid | card | nav | footer | aside | main | other",
        "purpose": "string — what this section does",
        "children": ["string — child section names"]
      }
    ]
  },
  "typography": {
    "family": "string — primary font family recommendation",
    "headingFamily": "string | null — heading font family",
    "scale": "string — type scale description",
    "weights": ["string — recommended weights"],
    "cssFamily": "string — css font-family value"
  },
  "color": {
    "palette": {
      "name": "string — palette name",
      "colors": [
        { "name": "string", "value": "string (hex/rgb)", "role": "string" }
      ]
    },
    "gradients": [
      { "name": "string", "stops": ["string"], "direction": "string" }
    ]
  },
  "spacing": {
    "scale": ["number — base unit in px"],
    "rules": ["string — spacing conventions"]
  },
  "assets": {
    "generated": [
      {
        "path": "string — project-relative output path",
        "size": "string — resolution like 3072x2048 or 1920x1080",
        "purpose": "string — what this asset is for"
      }
    ],
    "external": [
      {
        "url": "string — verified external URL",
        "purpose": "string",
        "license": "string — license or usage note"
      }
    ]
  },
  "template": {
    "path": "string — project-relative path to generated HTML skeleton",
    "description": "string — what the template covers"
  },
  "designMd": {
    "read": "boolean — whether DESIGN.md was found and read",
    "tokens": ["string — key tokens/conventions extracted from DESIGN.md"],
    "conflicts": ["string — any conflicts between DESIGN.md and the design direction"]
  },
  "notes": ["string — ambiguities, assumptions, or limitations"]
}
```

### 6. Image resolutions

The designer may call `generate_image` with these preset sizes:

| Resolution | Purpose |
| --- | --- |
| `3072x2048` | High-res hero / desktop wide |
| `1536x1024` | Standard desktop preview |
| `1920x1080` | Desktop 16:9 |
| `640x1280` | Mobile portrait |

The size is chosen based on the task context and the `image.size` config. The designer passes `size` explicitly in the `generate_image` call.

### 7. DESIGN.md support

- The designer reads `<project-root>/DESIGN.md` if it exists (same discovery path as `AGENTS.md` via `discoverAgents` or a direct `read_file` check).
- DESIGN.md is treated as a project-level design system specification: tokens, color rules, typography conventions, component patterns.
- If DESIGN.md exists, the designer extracts tokens and notes conflicts with the generated design direction.
- DESIGN.md is **not** injected into every role's system prompt. Only the designer reads it. Downstream roles (`styler`, `decorator`, `architect`) can reference the designer's output which summarizes DESIGN.md tokens.
- The `designMd` field in the schema captures whether DESIGN.md was read and what tokens were extracted.

### 8. External resource fetching

The designer may use `fetch_url` to read style resources (e.g. gradient collections, font pairings, color palettes). This is not a new MCP server — just a `fetch_url` call to a known resource URL. The prompt includes a list of recommended resource URLs that the designer may choose from:

```
Recommended resources:
- Gradient/style collections (e.g. https://ui.gradientdeck.com/styles/moooi)
- Google Fonts pairing recommendations
- Color palette generators
```

The designer validates any fetched content before including it in the design direction. URLs are verified and the response is checked for reasonableness.

### 9. Output artifacts

When the designer runs, it produces:

| Artifact | Path | Content |
| --- | --- | --- |
| Design report | `.tmp/<id>/design.json` | JSON matching `DESIGNER_SCHEMA` |
| HTML template | `.tmp/<id>/design-template.html` | Minimal HTML skeleton |
| Generated images | `.tmp/<id>/design-assets/*.png` | Images generated by the designer |

The design report is rendered as text in the shared context (via a new `renderDesign` function, analogous to `renderMeasurements` and `renderArchitecture`). The template path is noted so the `worker` can extend it.

### 10. Downstream role integration

- **Decomposer**: if the designer generated images, the decomposer can treat them as reference sources (just like user-attached images). The decomposer's `source` field in sub-references will point to the designer's output images.
- **Measurer**: measures on the designer's images or templates just as it measures on user-attached references. The measurement sheet notes `source: "designer-generated"` when applicable.
- **Architect**: reads the designer's layout and color direction when producing the architecture brief. The design section of `architecture.json` includes a reference to the design direction.
- **Styler**: uses the designer's color palette, typography, and spacing values as starting tokens. The styler's instructions are extended with a note about the design direction.
- **Decorator**: uses the designer's visual direction to decide ornament style (e.g. matching the palette and spacing).
- **Worker**: extends the designer's HTML template instead of starting from scratch. The plan step guidance includes a note about the template.

### 11. Renderer integration

A new entry in `src/ui/renderer.js` `STAGES` map:

```js
const STAGES = {
    // ... existing ...
    design: 'дизайн',
};
```

### 12. Config fields

New fields in `src/core/config-defaults.js`:

```json
{
  "agent": {
    "design": "off",
    "designerMaxTurns": 16
  },
  "roles": {
    "designer": {
      "model": "gpt-6.1-terra",
      "effort": "xhigh",
      "imageModel": null
    }
  }
}
```

Config validation (in `src/core/config.js`):
- `agent.design: off | auto | always`
- `agent.designerMaxTurns: positive integer`
- `roles.designer` fields follow the standard `ROLE_FIELDS` shape

### 13. Cost considerations

The designer is the most expensive stage:
- It runs a senior model (`gpt-6.1-terra`) at `xhigh` effort.
- It may call `generate_image` multiple times (one per asset, potentially 2-5 images).
- It may call `fetch_url` for external resources.

Because of this, the designer is `off` by default and the config warns when enabled:

```
info: Дизайнер включён — это дорогой этап (xhigh + генерация изображений).
```

The `--design auto` mode tries to be conservative: only enable when the task or project suggests visual work is needed.

## Files changed

| File | Change |
| --- | --- |
| `src/agent/pipeline.js` | Add `design` stage to `STAGE_CATALOG` |
| `src/agent/schemas.js` | Add `DESIGNER_SCHEMA` |
| `src/agent/role-registry.js` | Add `designer` executor spec |
| `src/agent/team.js` | Add `design` stage body; add `renderDesign` helper |
| `src/roles/designer.js` | New file — designer prompt |
| `src/roles/index.js` | Import and export `designer` instructions |
| `src/core/config-defaults.js` | Add `agent.design`, `agent.designerMaxTurns`, `roles.designer` |
| `src/core/config.js` | Validate new fields; add `designer` to role whitelist |
| `src/ui/renderer.js` | Add `design: 'дизайн'` to `STAGES` |
| `src/agent/team-text.js` | Add `renderDesign` function |
| `src/commands/flags.js` | Add `--design` flag |
| `src/commands/run.js` | Pass `design` config to `runTeam` |

## Open questions

1. **Should DESIGN.md be discoverable by all roles or only the designer?** Current proposal: only the designer reads it. If downstream roles need design tokens, the architect or styler could read the designer's output instead.
2. **Should the designer produce full styled HTML or just the skeleton?** Skeleton only — styling is the styler's job. The designer produces structure, classes, and a note about the design direction.
3. **Should the designer be able to edit the designer's own output?** The designer is a single-run stage (like the measurer). It does not iterate. If the planner detects the design is insufficient, it can add a `design` step to the plan, but this would run a new designer invocation.
4. **External resource caching?** Results of `fetch_url` calls are cached under `.tmp/<id>/design-cache/` — the cache key is the SHA-256 of the URL. Before fetching, check if a cache file exists. If it does, reuse it and set `"cached": true` in the external assets entry. Cache entries are not invalidated between stages; a new run with the same work directory reuses the same cache.
5. **Multi-screen template generation?** If the task implies multiple pages (e.g. a multi-page app), should the designer generate multiple HTML templates? Yes — one per page/screen, with a shared layout component.

## Implementation order

1. **Schema** — add `DESIGNER_SCHEMA` to `schemas.js`
2. **Role file** — create `src/roles/designer.js` with the prompt
3. **Role registration** — add to `src/roles/index.js` and `src/agent/role-registry.js`
4. **Config** — add `agent.design`, `agent.designerMaxTurns`, `roles.designer` defaults and validation
5. **CLI flag** — add `--design` to `flags.js`
6. **Pipeline** — add `design` stage to `STAGE_CATALOG` in `pipeline.js`
7. **Stage body** — implement the `design` stage in `team.js` with `renderDesign` helper
8. **Renderer** — add `design` to `STAGES` in `renderer.js`
9. **Downstream integration** — update decomposer/measurer/architect prompts to reference designer output when present
