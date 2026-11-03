# yaah website

A one-page site that shows what yaah does, with real screenshots and real tool calls. Static
[Astro](https://astro.build), Tailwind 4 and Geist, styled with the app's own tokens
(`app/src/index.css`), radius scale, mark and loader. No client framework; the only scripts are the
theme switch and the install command's copy button.

Deployed to GitHub Pages at <https://filipecabaco.github.io/yaah/> by `.github/workflows/site.yml`,
on every push to `main` that touches `site/` (or by hand, with "Run workflow"). Pages has to be set to
"GitHub Actions" as its source in the repository settings.

## Run

The toolchain matches `app/mise.toml` (`mise install` sets it up).

```sh
cd site
pnpm install
pnpm dev       # http://localhost:4321, live reload
pnpm build     # static output in dist/
pnpm preview   # serve dist/ at http://localhost:4321/yaah/ (stop it with: pnpm astro preview stop)
```

The site lives under `/yaah/` (`base` in `astro.config.mjs`), in development too. Links to files in
`public/` go through `asset()` in `src/lib/url.ts`, which prefixes the base; in-page anchors
(`#features`) need nothing.

## Versions

Pinned exactly in `package.json`: `astro` 7.4.1, `tailwindcss` and `@tailwindcss/vite` 4.3.3,
`@fontsource-variable/geist` 5.3.0. `pnpm-workspace.yaml` sets `minimumReleaseAge` to two weeks, so
transitive dependencies are also at least two weeks old when resolved.

## Layout

```
src/pages/index.astro        the page: hero, features, examples, how it works, build from source
src/layouts/Base.astro       head, header, footer, the theme switch
src/styles/global.css        tokens copied from app/src/index.css; the mark's loader animation from app/index.html
src/components/Mark.astro    the four-tile mark (geometry from app/src/components/brand/mark.tsx)
src/components/Shot.astro    a screenshot in its light and dark capture, shown by theme
src/components/Json.astro    a tool call's JSON, highlighted at build time (src/lib/json.ts)
src/components/Diagram.astro how ACP and MCP connect yaah and the agent (inline SVG)
src/components/Command.astro a shell command with a copy button (the install one-liner)
src/lib/examples.ts          the tool calls shown, taken from app/src/dev/fixtures/
src/lib/url.ts               base-aware URLs for public/, and the repo, releases and install links
public/shots/                the screenshots, as WebP
public/og.svg, og.png        the social image (1200×630); og.png is rendered from og.svg
public/robots.txt            allows everything, points at the sitemap
public/sitemap.xml           the one page, by hand (no sitemap integration for one URL)
```

## Social image

`public/og.svg` is generated, with the text as Geist outlines so it renders the same anywhere, and
`public/og.png` is rendered from it with `rsvg-convert`. Both come from
`docs/experiments/2026-11-03-website/deploy/og.exs`; its header has the steps (it needs `hb-view`,
`rsvg-convert` and Geist as a TTF).

## Screenshots

Every image in `public/shots/` is the app, captured from its browser mock (`pnpm dev` in `app/`,
http://localhost:1420) replaying recorded agent sessions, at 2× in light and dark. The originals and
how they were taken are in `docs/experiments/2026-11-03-website/`. To refresh one, capture it again
there and convert it to WebP into `public/shots/` with the same name (`<name>-light.webp`,
`<name>-dark.webp`).

## Content rules

The page only states what `app/README.md`, `app/PRODUCT.md`, `REVIEW.md` and `docs/` say is built.
Anything planned is listed under "Not there yet". Install instructions follow `install.sh` and the
Install and Releases sections of `app/README.md`; building from source is the secondary path. The
repository has no licence file, so the page says nothing about a licence, and it gives no download
counts or other numbers it can't source.
