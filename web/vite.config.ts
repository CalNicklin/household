import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env["API_URL"] ?? "http://localhost:3001";

/** FB-1: `vite dev` on :3000 with HMR, proxying the API to the household server on :3001. */
export default defineConfig({
  root: import.meta.dirname,
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      "/api": { target: api, changeOrigin: false },
      "/mcp": { target: api, changeOrigin: false },
    },
  },
  // SPA mode: one prerendered shell (web/dist/client/_shell.html) for every path. The mask path is
  // one nobody visits, so the shell never claims to be a real page and hydration always matches.
  plugins: [tanstackStart({ spa: { enabled: true, maskPath: "/app-shell", prerender: { outputPath: "/_shell" } } }), viteReact()],
});
