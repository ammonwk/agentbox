import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      // The app; the block page extensions may frame (src/blocks/main.tsx); and
      // agentbox/client (src/plugin/client.ts), which extensions' clients import
      // from the server by its built name, so it must keep its exports.
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        blocks: resolve(import.meta.dirname, "blocks.html"),
        "agentbox-client": resolve(import.meta.dirname, "src/plugin/client.ts"),
      },
      preserveEntrySignatures: "exports-only",
    },
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
