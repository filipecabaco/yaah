# Website test pass (2026-11-03)

A functional, responsive, accessibility, performance, content and SEO pass over `site/`, built with
`pnpm build` and served with `pnpm preview` (http://127.0.0.1:4321). Browser work was done in vitro
(local, headless Chrome). Contrast was measured with axe-core 4.14 injected into the page, plus a
script that composites translucent backgrounds and reads SVG fills, which axe skips.

Lighthouse ran two ways: vitro's `run_audit` (Lighthouse's default, mobile) and the Lighthouse 13.6
CLI for an explicit mobile and desktop preset (vitro's audit has no form-factor switch). The CLI's
headless Chrome follows macOS's dark appearance, and neither tool can set the colour scheme, so the
light and dark audits used copies of `dist/` with the saved theme forced to `"light"` or `"dark"`
in the inline theme script, served on another local port. Nothing else in those copies changed.

## Lighthouse scores

| Run | Theme | Performance | Accessibility | Best practices | SEO | FCP | LCP | CLS |
|---|---|---|---|---|---|---|---|---|
| Before, vitro (mobile) | light | 100 | **97** (color-contrast) | 100 | 100 | 0.9 s | 0.9 s | 0.0004 |
| Before, vitro (mobile) | dark | – | 100 | – | – | | | |
| Before, CLI mobile | dark | 100 | 100 | 100 | 100 | 0.9 s | 0.9 s | 0 |
| Before, CLI desktop | dark | 100 | 100 | 100 | 100 | 0.2 s | 0.4 s | 0.023 |
| After, vitro (mobile) | light | 100 | 100 | 100 | 100 | 1.2 s* | 1.2 s* | 0.0004 |
| After, vitro (mobile) | dark | 100 | 100 | 100 | 100 | 1.2 s* | 1.2 s* | 0.0004 |
| After, CLI mobile | light / dark | 100 / 100 | 100 / 100 | 100 / 100 | 100 / 100 | 0.9 s† | 0.9 s† | 0 |
| After, CLI desktop | light / dark | 100 / 100 | 100 / 100 | 100 / 100 | 100 / 100 | 0.2 s† | 0.4 s† | 0–0.023 |

\* Served from Python's `http.server` (no compression), not `astro preview`. On `astro preview`
(light, after the contrast fixes) vitro measured 0.9 s and 100 in every category.
† Timings from the `astro preview` run (dark); the forced-theme copies on `http.server` measured
1.2 s FCP/LCP on mobile and 0.3 s / 0.5 s on desktop, with the same scores.

LCP element: mobile, the hero paragraph; desktop, the hero screenshot (`pack-system-monitor`). The
only layout shift is the hero moving when Geist swaps in (0.023 on desktop at worst, well under 0.1);
every image has `width` and `height`.

Page weight: 264 KiB on first load (mobile), 304 KiB (desktop), 7–8 requests. Scrolled to the end,
about 1.0 MB per theme: the screenshots are lazy and only the current theme's set loads, except the
hero, where both captures load eagerly (48 KiB extra). Largest image: `library-pr-view` (117 KiB).

## Results

| Area | Result | Notes |
|---|---|---|
| Anchors and nav | Pass | 9 in-page links, 6 targets, all exist; each lands 72 px from the top, under the 57 px header |
| Images | Pass | 33 images and 33 full-size links return 200, all with alt text and dimensions |
| Theme toggle | Pass | Toggles, saves `yaah-theme`, survives reload, overrides the system; with nothing saved it follows the system; screenshots swap to the matching capture (16 themed + 1 single) |
| Console | Pass | No console messages. vitro lists a Chrome "LazyLoadImageIssue" per lazy screenshot; Lighthouse best practices flags nothing |
| External links | n/a | None on the page |
| Responsive 375–1920 | Pass after fix | No horizontal overflow or overlapping blocks at any width; code blocks scroll inside themselves (Postgres block at 768); diagram swap fixed (below) |
| Accessibility | Pass after fixes | Skip link works and shows; Tab order follows the page; headings h1 → h2 → h3 with no skips; reduced motion stops the mark (checked by applying the page's own `prefers-reduced-motion: reduce` rules, as vitro can't emulate the media feature) |
| Contrast | Pass after fixes | Light failures fixed; dark had none |
| Performance | Pass | 100 everywhere. Opportunity: ~150 KiB from responsive image sizes |
| Content truth | Pass | 23 pack components, 13 presets, 45 primitives, 65 themes, 5/6, 2/6 and 3/3 all match the repo; build commands match `app/README.md` and `app/package.json`; no download, licence or remote promised |
| SEO basics | Pass after fix | title, description, `lang`, favicon present; Open Graph tags added; no canonical, `og:url` or `og:image` because there is no hosted address |

## Files

| File | What it shows |
|---|---|
| `full-0375-light.jpg`, `full-0375-dark.jpg` | Full page at 375 px, after fixes |
| `full-0768-light.jpg`, `full-0768-dark.jpg` | Full page at 768 px, after fixes (tall diagram, centred) |
| `full-1024-light.jpg`, `full-1024-dark.jpg` | Full page at 1024 px, after fixes (wide diagram from here up) |
| `full-1440-light.jpg`, `full-1440-dark.jpg` | Full page at 1440 px, after fixes |
| `full-1920-light.jpg`, `full-1920-dark.jpg` | Full page at 1920 px, after fixes |
| `skip-link-focused-1440-dark.png` | First Tab: the skip link appears top left |
| `problem-before-focus-on-screenshot-link-invisible-1440-dark.jpg` | Before: a screenshot link has focus (`library-pr-view`) but no ring shows; the outline is clipped by the frame's `overflow: hidden` |
| `problem-before-light-focus-ring-low-contrast-1440.png` | Before (after the clipping fix): the light-theme ring is `--ring`, #a1a1a1, 2.6:1 on white |
| `fixed-focus-ring-on-screenshot-link-1440-light.png` | After: an inset ring in `--muted-foreground` around the focused screenshot |
| `fixed-focus-ring-on-code-block-1440-light.png` | After: the "Run the app" block focused, ring inset so its frame doesn't clip it |
| `problem-before-diagram-tiny-text-768-light.png` | Before: at 768 px the wide diagram is scaled to 623 px, so its 12.5 px labels render at about 8 px |
| `fixed-diagram-tall-at-768-light.png` | After: the tall diagram up to 1023 px, capped at 448 px wide |
| `fixed-diagram-wide-at-1024-light.png` | After: the wide diagram from 1024 px, labels at about 11 px |
| `problem-before-tool-call-note-truncated-768-dark.png` | Before: the tool-call header reads "schema and ex…" at 768 px |

## Fixes

| Problem | Fix | File |
|---|---|---|
| Key caps: `--muted-foreground` on `--muted`, 4.34:1 at 11 px (Lighthouse's only light failure) | Key background `bg-background` (4.74:1) | `site/src/components/Kbd.astro` |
| Diagram box text: `--muted-foreground` on `--muted`, 4.35:1 (axe skips SVG text) | Boxes `fill-muted/50` (4.54:1 light, 6.4:1 dark) | `site/src/components/Diagram.astro` |
| MCP arrow in brand orange: 2.62:1 on white, under 3:1 for a graphic that carries meaning | New `--brand-line` token, a darker orange in light (3.57:1), the brand colour in dark | `site/src/styles/global.css`, `Diagram.astro` |
| Wide diagram's labels at about 8 px between 768 and 1023 px | Wide drawing from `lg`, tall below, capped at `max-w-md` | `site/src/components/Diagram.astro` |
| No visible focus on screenshot links (outline clipped by `overflow: hidden`) | `focus-visible:-outline-offset-2` | `site/src/components/Shot.astro` |
| Same clipping on the two "Build from source" code blocks (`tabindex="0"`) | `focus-visible:-outline-offset-2` | `site/src/pages/index.astro` |
| Light focus ring 2.6:1 on white | `:focus-visible` uses `--muted-foreground` (4.74:1 light, 7.66:1 dark) | `site/src/styles/global.css` |
| Tool-call note truncated ("schema and ex…") | Note wraps, right-aligned; tool name doesn't shrink | `site/src/components/Json.astro` |
| No Open Graph tags | `og:type`, `og:site_name`, `og:title`, `og:description` | `site/src/layouts/Base.astro` |

## Left as is

- No canonical, `og:url` or `og:image`: they need an absolute URL and the site has no hosted address
  (`astro.config.mjs` has no `site`). Add them with one.
- Below 768 px the header has only Get started and the theme toggle; the other sections are reached
  by scrolling. A design choice, not a defect.
- The hero loads both its light and dark capture eagerly (48 KiB extra). Fixing it needs a
  `<picture>` keyed to the class-based theme; not worth it at a perf score of 100.
- Screenshots are served at 900–1600 px whatever the display width; `srcset` would save about
  150 KiB per view. An optimisation, not a defect.
- The Geist font swap shifts the hero slightly (CLS up to 0.023 on desktop, in the "good" range).
- The tall diagram's smallest labels render at about 10 px at 375 px wide.
- Chrome's "LazyLoadImageIssue" entries (DevTools Issues, not console output) for lazy screenshots.
