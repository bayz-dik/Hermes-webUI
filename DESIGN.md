# DESIGN.md - Hermes Web

Direction file for the local Hermes web console. Read together with
`antislop.md` (filter) and `design-taste-frontend` (craft rules).

## Design Read

Reading this as: **local agent console for a single technical owner (phone-first,
Android/Termux)**, with a **dark ink / warm-paper language**, leaning toward a
**hand-built token system on a Kanagawa-derived palette** plus IBM Plex Sans and
JetBrains Mono. Not a landing page, not a marketing site: this is a working
surface where the data is the product.

## Why not the recommended OLED blue-slate

`ui-ux-pro-max --design-system` returned **Dark Mode (OLED)**: background
`#0F172A`, accent `#22C55E` ("code dark + run green"). That is the generic
developer-console default: cool blue-black plus terminal green. It is honest
advice for an anonymous tool, and it is exactly the palette every AI-generated
console ships.

Hermes already carries a visual identity in `ui-tui/src/theme.ts` and the
`psyche` skin. This console extends that identity instead of replacing it:
**warm ink** (`#1F1F28`, a paper-ink dark, not a blue-slate dark), one blue
accent, and status colours that mean something. Deviation is deliberate and
recorded here, per the taste-skill honesty rule.

## Palette (measured, not eyeballed)

Contrast ratios computed against `--bg` `#1F1F28` unless noted.

| Token | Hex | Role | Ratio |
|---|---|---|---|
| `--bg` | `#16161D` | page background (sumiInk0) | - |
| `--surface` | `#1F1F28` | panels, app bar (sumiInk1) | - |
| `--surface-2` | `#2A2A37` | raised rows, inputs | - |
| `--surface-3` | `#363646` | active row, code chips | - |
| `--line` | `#3A3A4C` | hairlines (non-text, decorative only) | - |
| `--text` | `#DCD7BA` | body + headings (fujiWhite) | 11.26 |
| `--muted` | `#A6A28E` | secondary text | 6.37 |
| `--dim` | `#8C8B7E` | tertiary text, on `--bg` only | 4.75 |
| `--accent` | `#7E9CD8` | the single accent (crystalBlue) | 5.94 |
| `--ok` | `#98BB6C` | status: success | 7.52 |
| `--warn` | `#DCA561` | status: warning | 7.47 |
| `--err` | `#E46876` | status: failure | 5.09 |

Rules:
- **One accent.** `--accent` is used for the primary action, focus ring, active
  nav, and links. It is never swapped for a second "highlight" colour.
- `--ok` / `--warn` / `--err` are **semantic status only** (run state, plugin
  enabled, error text). They are not decoration and never mark a plain list row.
- `--dim` and `--line` are the only tokens below 4.5:1. `--dim` never carries
  meaning alone; `--line` never carries text.
- No pure `#000` and no pure `#fff` anywhere.

## Type

- UI: **IBM Plex Sans** (400/500/600). Self-hosted woff2, `font-display: swap`.
- Data, numbers, IDs, code, tool output: **JetBrains Mono** (400/500).
- Numeric readouts use mono so columns align. Never mono for prose.
- One type scale only: 12 / 13 / 15 / 18 / 24 / 32 px.

## Shape and space

- One radius family: **3px** on every box (panels, inputs, buttons, chips).
  Not pills, not 16px cards, not mixed.
- One spacing scale: 4 / 8 / 12 / 16 / 24 / 32 / 48.
- Panels are separated by hairlines and background steps, not by drop shadows.
  There is exactly one elevation in the whole app (the drawer backdrop).

## Interaction rules

- Every interactive element has default / hover / focus-visible / active /
  disabled states. `:active` shifts `translateY(1px)`.
- Focus ring: 2px `--accent` offset 2px, always visible, never removed.
- Hit targets: 44px minimum on anything tappable, including drawer rows,
  segmented controls, and icon buttons.
- Every view has loading (skeleton in the final layout's shape), empty (names
  the cause and offers the fix), and error (says what failed and what to do)
  states. A spinner alone is not a loading state.

## Motion

`MOTION_INTENSITY: 3` - static by default. Only two motions exist:
1. the drawer slide (state transition: it explains where the panel came from),
2. a 150ms background/border transition on hover (feedback).
Both collapse under `prefers-reduced-motion: reduce`.

## Copy rules

- Plain language, no filler verbs. No em-dash anywhere (antislop + taste-skill
  hard ban). Hyphen only.
- Errors name the operation, the cause, and the next action.
- Labels name what the user gets, not the mechanism: "Skills", not "Skill
  Registry Loader".
- No emoji as icons. Icons are inline SVG, one family, `stroke-width: 1.7`.

## Layout

- `>= 1024px`: fixed 232px nav rail on the left, content column `max-w-[1180px]`.
- `< 1024px`: app bar (56px) with hamburger, off-canvas drawer, single column,
  `padding: 12px`. Nothing scrolls horizontally at 360px.
