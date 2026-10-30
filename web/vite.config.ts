import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The app, and the block page extensions may frame (src/blocks/main.tsx).
    rollupOptions: { input: { index: resolve(import.meta.dirname, "index.html"), blocks: resolve(import.meta.dirname, "blocks.html") } },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4479",
      "/ws": { target: "ws://127.0.0.1:4479", ws: true },
      "/x": "http://127.0.0.1:4479",
    },
  },
});
