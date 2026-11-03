// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";

// A static site: no adapter, no integrations, no client framework.
export default defineConfig({
  // Keep whitespace between inline elements as written (no "forClaude").
  compressHTML: false,
  vite: { plugins: [tailwindcss()] },
});
