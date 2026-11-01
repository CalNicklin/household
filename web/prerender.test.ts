import { fileURLToPath } from "node:url";
import { preview } from "vite";
import { describe, expect, it } from "vitest";

/**
 * PLT-8, FB-5 (HOU-145): `vite build` prerenders the SPA shell by starting a preview server and fetching
 * from the first URL it reports (@tanstack/start-plugin-core's prerenderWithVite). The image build failed
 * on GitHub because that URL named "localhost", which the server and the fetch resolved to different
 * addresses. Started the way the plugin starts it, the server must listen on the very address its URL
 * names, so no resolver is involved.
 */
describe("the SPA prerender's preview server", () => {
  it("[PLT-8] listens on the address literal its URL names", async () => {
    const configFile = fileURLToPath(new URL("vite.config.ts", import.meta.url));
    const server = await preview({ configFile, logLevel: "silent", preview: { port: 0, open: false } });
    try {
      const url = new URL(server.resolvedUrls?.local[0] ?? "");
      const bound = server.httpServer.address();
      expect(url.hostname).toBe("127.0.0.1");
      expect(bound).toMatchObject({ address: url.hostname, port: Number(url.port) });
      // The fetch the prerender makes: the server answers it (404 or 500 without a build, never refused).
      const res = await fetch(url);
      expect(res.status).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });
});
