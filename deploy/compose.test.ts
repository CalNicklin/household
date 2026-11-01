import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

/**
 * PLT-8 on Cal's VPS, next to the trader app, hindsight and docker-ib-gateway-1: the household's own
 * compose project can never take their memory, and opens nothing to the internet but 80 and 443.
 */
const zService = z.looseObject({
  image: z.string().optional(),
  build: z.unknown().optional(),
  mem_limit: z.string().optional(),
  memswap_limit: z.string().optional(),
  ports: z.array(z.string()).optional(),
  privileged: z.boolean().optional(),
  network_mode: z.string().optional(),
  volumes: z.array(z.string()).optional(),
});
const zCompose = z.looseObject({ name: z.string().optional(), services: z.record(z.string(), zService) });

const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
const main = zCompose.parse(parse(read("compose.yml"), { merge: true }));
const hindsight = zCompose.parse(parse(read("compose.hindsight.yml")));

const MB = { m: 1, g: 1024 } as const;
function megabytes(limit: string): number {
  const m = /^(\d+)([mg])$/.exec(limit);
  if (m?.[1] === undefined || (m[2] !== "m" && m[2] !== "g")) throw new Error(`unreadable memory limit ${limit}`);
  return Number(m[1]) * MB[m[2]];
}

/** Host side of a short-syntax port: `[ip:]host:container[/proto]`, or a bare container port (published on every address). */
function published(port: string): { ip: string; host: string } {
  const parts = port.replace(/\/(tcp|udp)$/, "").split(":");
  if (parts.length === 3) return { ip: parts[0] ?? "", host: parts[1] ?? "" };
  if (parts.length === 2) return { ip: "0.0.0.0", host: parts[0] ?? "" };
  return { ip: "0.0.0.0", host: "random" };
}

describe("the production compose project", () => {
  it("[PLT-8] is its own project, and every service has a hard memory cap, swap included, about 550 MB in all", () => {
    expect(main.name).toBe("household");
    const services = Object.entries(main.services);
    expect(services.map(([name]) => name).sort()).toEqual(["app", "caddy", "objects", "postgres"]);
    for (const [name, s] of services) {
      expect(s.mem_limit, `${name} has no mem_limit`).toBeDefined();
      expect(s.memswap_limit, `${name} may swap past its cap`).toBe(s.mem_limit);
    }
    const total = services.reduce((sum, [, s]) => sum + megabytes(s.mem_limit ?? "0g"), 0);
    expect(total).toBeLessThanOrEqual(560);
    // The caps are set in one place (x-memory) and only referred to by the services.
    const lines = read("compose.yml").split("\n").filter((l) => /^\s+(mem_limit|memswap_limit):/.test(l));
    for (const line of lines) expect(line, "a cap set outside x-memory").toMatch(/:\s+\*[a-z]+-memory$/);
  });

  it("[PRV-6] opens only 80 and 443 to the internet; anything else would have to bind to localhost", () => {
    for (const file of [main, hindsight])
      for (const [name, s] of Object.entries(file.services)) {
        expect(s.network_mode, `${name} shares the host's network`).toBeUndefined();
        for (const port of s.ports ?? []) {
          const { ip, host } = published(port);
          if (ip === "127.0.0.1") continue;
          expect(["80", "443"], `${name} publishes ${port}`).toContain(host);
        }
      }
    expect(Object.entries(main.services).filter(([, s]) => (s.ports ?? []).length > 0).map(([name]) => name)).toEqual(["caddy"]);
  });

  it("[PLT-8] builds nothing on the server, gets no power over Docker, and runs without the shopping helper", () => {
    for (const [name, s] of Object.entries(main.services)) {
      expect(s.build, `${name} would build on the server`).toBeUndefined();
      expect(s.image, `${name} has no image`).toBeDefined();
      expect(s.privileged ?? false).toBe(false);
      for (const v of s.volumes ?? []) expect(v, `${name} mounts the Docker socket`).not.toContain("docker.sock");
    }
    expect(main.services["app"]?.image).toBe("${HOUSEHOLD_IMAGE:?household-deploy sets HOUSEHOLD_IMAGE}");
    expect(main.services["app"]?.["environment"]).toMatchObject({ PRACTICE: "false", HELPER_URL: "" });
    expect(Object.keys(main.services)).not.toContain("helper");
  });

  it("[PLT-8] serves one domain, set in one place", () => {
    expect(read("Caddyfile")).toContain("{$HOUSEHOLD_DOMAIN} {");
    expect(main.services["caddy"]?.["environment"]).toMatchObject({ HOUSEHOLD_DOMAIN: expect.stringContaining("${HOUSEHOLD_DOMAIN:?") });
    expect(main.services["app"]?.["environment"]).toMatchObject({ PUBLIC_URL: "https://${HOUSEHOLD_DOMAIN}" });
  });
});
