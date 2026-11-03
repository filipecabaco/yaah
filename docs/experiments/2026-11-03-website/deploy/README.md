# Website: ready for GitHub Pages (2026-11-03)

The site in `site/` moved under the base path `/yaah/` for https://filipecabaco.github.io/yaah/, got
the install one-liner and first-release content, canonical and social tags, a social image, and a
Pages workflow (`.github/workflows/site.yml`). These checks re-run the earlier test pass
(`../tests/`) on the new build: `pnpm build`, then `pnpm preview` at http://127.0.0.1:4321/yaah/.
Browser work was done in vitro (local, headless Chrome).

## Results

| Check | Result | Notes |
|---|---|---|
| URLs under `/yaah/` | Pass | Every root-relative `href`/`src` in `dist/index.html` and every `url()` in the CSS, plus `/yaah/robots.txt`, `/yaah/sitemap.xml`, `/yaah/og.png`, `/yaah/og.svg`: 46 URLs, all 200. Nothing points at the host root (`/` itself is a 404 on the preview, as on Pages) |
| Images | Pass | 33 images and 33 full-size links, all under `/yaah/shots/`; none broken in light or dark (17 shown per theme: 16 themed + 1 single) |
| Anchors | Pass | 9 in-page links, every target exists |
| Head | Pass | canonical and `og:url` `https://filipecabaco.github.io/yaah/`, `og:image` and `twitter:image` `https://filipecabaco.github.io/yaah/og.png` (1200×630, with alt), `twitter:card` `summary_large_image`, favicon `/yaah/favicon.svg` |
| Responsive | Pass | No horizontal overflow at 375 or 1440, light or dark. The install command sits on one line at 1440 and wraps inside its box at 375 |
| Copy button | Pass (fallback path) | Shown only when the clipboard API is there. Headless Chrome refuses `clipboard.writeText` without a permission grant, so the success path (check icon, "Copied" status) couldn't be seen here; the refusal path selects the command and says to press Ctrl+C or ⌘C, which was checked with a real click |

## Lighthouse (vitro `run_audit`, mobile)

As before, vitro's audit can't set the colour scheme, so it ran against copies of `dist/` with the
saved theme forced to `"light"` or `"dark"` in the inline theme script, served with `astro preview`
under `/yaah/` on port 4322. Nothing else in the copies changed.

| Theme | Performance | Accessibility | Best practices | SEO | FCP | LCP | CLS |
|---|---|---|---|---|---|---|---|
| light | 100 | 100 | 100 | 100 | 0.9 s | 0.9 s | 0.0005 |
| dark | 100 | 100 | 100 | 100 | 0.9 s | 0.9 s | 0.0005 |

No failed audits and no opportunities in either run.

## Files

| File | What it shows |
|---|---|
| `full-1440-light.jpg`, `full-1440-dark.jpg` | Full page at 1440 px (1425 px of page beside the scrollbar) |
| `full-0375-light.jpg`, `full-0375-dark.jpg` | Full page at 375 px (captured at 2×, saved at 1×) |
| `hero-1440-dark.png` | The hero: install command with its copy button, GitHub, Releases and examples |
| `get-started-1440-light.png` | Get started: the command on one line, what the installer does, its options, the macOS signing note |
| `hero-0375-light.png`, `get-started-0375-dark.png` | The same two at 375 px (2×), the command wrapping inside its box |
| `og.exs` | Builds `site/public/og.svg` and `og.png`; the header has the steps |

## Social image

`site/public/og.png` (1200×630) is rendered with `rsvg-convert` from `site/public/og.svg`, which
`og.exs` writes: the site's dark tokens, "yaah", "Agents answer with interface.", "A desktop harness
for coding agents.", the address, and the mark at 6×. Text is shaped with HarfBuzz (`hb-view`) in
Geist and kept as outlines, because `rsvg-convert` on macOS draws text through CoreText, which
doesn't have Geist, and the site only ships Geist as woff2. The woff2 was decompressed to a TTF once
with fontTools' CLI (`uvx --with brotli --from fonttools fonttools ttLib.woff2 decompress`), as a
single shell tool; nothing was added to the site's dependencies.

## Notes

- `robots.txt` is served at `/yaah/robots.txt`. Crawlers only read `robots.txt` at the host root
  (`filipecabaco.github.io/robots.txt`), which belongs to a `filipecabaco.github.io` user site, not
  this repo, so this file is informational; the sitemap is also linked from the page
  (`<link rel="sitemap">`) and can be submitted in Search Console.
- A newer build is served from cache in the same browser session; navigate with a query string
  (`?v=2`) when re-checking.
