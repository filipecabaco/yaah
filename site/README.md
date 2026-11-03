# yaah website

A one-page site that shows what yaah does, with real screenshots and real tool calls. Static
[Astro](https://astro.build), Tailwind 4 and Geist, styled with the app's own tokens
(`app/src/index.css`), radius scale, mark and loader. No client framework; the only scripts are the
theme switch.

Local only: nothing here deploys or publishes anything.

## Run

The toolchain matches `app/mise.toml` (`mise install` sets it up).

```sh
cd site
pnpm install
pnpm dev       # http://localhost:4321, live reload
pnpm build     # static output in dist/
pnpm preview   # serve dist/ (stop it with: pnpm astro preview stop)
```

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
src/lib/examples.ts          the tool calls shown, taken from app/src/dev/fixtures/
public/shots/                the screenshots, as WebP
```

## Screenshots

Every image in `public/shots/` is the app, captured from its browser mock (`pnpm dev` in `app/`,
http://localhost:1420) replaying recorded agent sessions, at 2× in light and dark. The originals and
how they were taken are in `docs/experiments/2026-11-03-website/`. To refresh one, capture it again
there and convert it to WebP into `public/shots/` with the same name (`<name>-light.webp`,
`<name>-dark.webp`).

## Content rules

The page only states what `app/README.md`, `app/PRODUCT.md`, `REVIEW.md` and `docs/` say is built.
Anything planned is listed under "Not there yet". There is no release, download, licence or hosted
repository to link to; the page says "build from source" and points to the README.
