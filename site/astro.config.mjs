// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// A static site: no adapter, no integrations, no client framework.
// Hosted on GitHub Pages as a project site, so every page and asset lives under /yaah/
// (src/lib/url.ts joins paths onto import.meta.env.BASE_URL).
export default defineConfig({
  site: "https://filipecabaco.github.io",
  base: "/yaah",
  // Keep whitespace between inline elements as written (no "forClaude").
  compressHTML: false,
  vite: { plugins: [tailwindcss()] },
});
