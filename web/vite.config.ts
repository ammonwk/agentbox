import { defineConfig } from "vite";
import { sourceRevision } from "../src/revision";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  define: { __AGENTBOX_REVISION__: JSON.stringify(sourceRevision()) },
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4479",
      "/ws": { target: "ws://127.0.0.1:4479", ws: true },
    },
  },
});
