import path from "node:path";
import { defineConfig } from "<repo>/app/node_modules/vite/dist/node/index.js";
import react from "<repo>/app/node_modules/@vitejs/plugin-react/dist/index.js";
import tailwindcss from "<repo>/app/node_modules/@tailwindcss/vite/dist/index.mjs";
export default defineConfig({
  root: "<scratch>/prodmock",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": "<repo>/app/src" } },
  build: { outDir: "<scratch>/prodmock/dist", emptyOutDir: true, target: "esnext" },
  server: { fs: { allow: ["<repo>/app", "/private/tmp/claude-501/-Users-filipecabaco-Documents-workspace-yaah/db3a3876-6a4e-4137-ac8f-d6a19e7c13e4/scratchpad"] } },
  preview: { port: 4173, strictPort: true },
});
