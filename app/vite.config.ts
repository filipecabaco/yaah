/// <reference types="vitest/config" />
import path from "node:path";
import process from "node:process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  // Libraries only reached through lazy imports (ui-blocks/*) are pre-bundled with the rest,
  // so the dev server never discovers them mid-session and ends up with two copies of React.
  optimizeDeps: {
    include: ["leaflet", "react-leaflet", "@tanstack/react-table", "mermaid", "codemirror", "@codemirror/lang-sql"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },

  // `pnpm test`: real components in a DOM, talking to the same browser mock `pnpm dev` uses.
  test: {
    environment: "happy-dom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
    testTimeout: 20_000,
    coverage: {
      provider: "v8" as const,
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/components/ui/**", "src/dev/fixtures/**", "src/test/**", "src/**/*.test.{ts,tsx}", "src/vite-env.d.ts"],
      reporter: ["text-summary", "text", "html"],
    },
  },
}));
