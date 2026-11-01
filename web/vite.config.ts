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
  // HOU-145: the SPA prerender (below) starts `vite preview` and fetches the shell from the URL it reports.
  // On "localhost" those two disagree wherever the loopback has ::1 but no other IPv6 address, as in
  // the GitHub runner's BuildKit sandbox: listen resolves localhost to ::1 first, while connect asks
  // with AI_ADDRCONFIG, drops ::1 and tries only 127.0.0.1 (ECONNREFUSED). An address literal is the
  // same on both sides. Only the build's own preview server uses this; the house is served by server/.
  preview: { host: "127.0.0.1" },
  // SPA mode: one prerendered shell (web/dist/client/_shell.html) for every path. The mask path is
  // one nobody visits, so the shell never claims to be a real page and hydration always matches.
  plugins: [tanstackStart({ spa: { enabled: true, maskPath: "/app-shell", prerender: { outputPath: "/_shell" } } }), viteReact()],
});
