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
const zCompose = z.looseObject({ name: z.string().optional(), "x-memory": z.record(z.string(), z.string()).optional(), services: z.record(z.string(), zService) });

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
    // The caps are set in one place: change a value in x-memory and that service's cap changes with it.
    const caps = main["x-memory"] ?? {};
    expect(Object.keys(caps).sort()).toEqual(services.map(([name]) => name).sort());
    const edited = zCompose.parse(parse(read("compose.yml").replace(/^(\s+app: &app-memory )\S+$/m, "$11g"), { merge: true }));
    expect(edited.services["app"]?.mem_limit).toBe("1g");
    expect(edited.services["app"]?.memswap_limit).toBe("1g");
    for (const [name, s] of services) expect(s.mem_limit, `${name}'s cap is not its x-memory value`).toBe(caps[name]);
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
    // The app runs whatever image household-deploy names, and compose refuses to start without one.
    expect(main.services["app"]?.image).toMatch(/^\$\{HOUSEHOLD_IMAGE:\?.*\}$/);
    expect(main.services["app"]?.["environment"]).toMatchObject({ PRACTICE: "false", HELPER_URL: "" });
    // Credential files (the Google token) reach the app read-only.
    expect(main.services["app"]?.volumes).toEqual(["./credentials:/run/household-credentials:ro"]);
    expect(Object.keys(main.services)).not.toContain("helper");
  });

  it("[PLT-8] serves one domain, set in one place", () => {
    // Caddy serves the site named by HOUSEHOLD_DOMAIN, and the app's public URL is that same domain.
    expect(read("Caddyfile")).toMatch(/^\{\$HOUSEHOLD_DOMAIN\}\s*\{/m);
    expect(main.services["caddy"]?.["environment"]).toMatchObject({ HOUSEHOLD_DOMAIN: expect.stringMatching(/^\$\{HOUSEHOLD_DOMAIN[:?}]/) });
    expect(main.services["app"]?.["environment"]).toMatchObject({ PUBLIC_URL: expect.stringMatching(/^https:\/\/\$\{HOUSEHOLD_DOMAIN\}$/) });
  });
});

describe("HOU-175: other apps' sites on the house's Caddy", () => {
  const overlay = zCompose.parse(parse(read("compose.caddy-sites.yml"), { merge: true }));
  const caddy = overlay.services["caddy"] ?? zService.parse({});
  const common = read("household-common.sh");
  const install = read("install.sh");

  it("[PLT-8] the overlay touches only Caddy: no new service, no memory cap changed, no port, no network", () => {
    expect(Object.keys(overlay.services)).toEqual(["caddy"]);
    expect(overlay["x-memory"]).toBeUndefined();
    expect(caddy.mem_limit).toBeUndefined();
    expect(caddy.memswap_limit).toBeUndefined();
    expect(caddy.ports).toBeUndefined();
    expect(caddy.network_mode).toBeUndefined();
    expect(caddy["networks"]).toBeUndefined();
    expect(caddy.privileged ?? false).toBe(false);
    expect(Object.keys(caddy).sort()).toEqual(["extra_hosts", "labels", "volumes"]);
  });

  it("[PRV-6] the sites reach Caddy read-only, and Caddy gets only a name for the host", () => {
    expect(caddy.volumes).toEqual(["${SITES_DIR:?}:/etc/caddy/sites:ro"]);
    expect(caddy["extra_hosts"]).toEqual(["host.docker.internal:host-gateway"]);
    expect(common).toMatch(/^SITES_DIR="\$\{SITES_DIR:-\/etc\/household\/sites\}"$/m);
    expect(read("Caddyfile")).toMatch(/^import \/etc\/caddy\/sites\/\*\.caddy$/m);
    // The base project never names the sites; only the overlay does.
    expect(read("compose.yml")).not.toMatch(/sites|host-gateway/);
  });

  it("[PLT-8] is added only when root alone can write the directory and every *.caddy in it", () => {
    expect(common).toMatch(/^if \[ -f "\$HOUSEHOLD_DIR\/compose\.caddy-sites\.yml" \] && sites_usable; then$/m);
    const check = /sites_usable\(\) \{[\s\S]*?\n\}/.exec(common)?.[0] ?? "";
    expect(check).toContain('[ -d "$SITES_DIR" ] || return 1');
    // The directory: not a symlink, owned by root, writable by no group or other user.
    expect(check).toContain('[ -L "$SITES_DIR" ] || [ "$(stat -c %u "$SITES_DIR")" != 0 ] || (( 0$(stat -c %a "$SITES_DIR") & 022 ))');
    // Each file the same, and at least one of them.
    expect(check).toContain('[ -L "$f" ] || [ ! -f "$f" ] || [ "$(stat -c %u "$f")" != 0 ] || (( 0$(stat -c %a "$f") & 022 ))');
    expect(check).toMatch(/\[ -n "\$found" \]\n\}$/);
  });

  it("[PLT-8] install.sh makes the directory root's (0755) and puts nothing in it; the deploy user can't add a site", () => {
    expect(install).toMatch(/^install -d -o root -g root -m 755 "\$etc\/sites"$/m);
    expect(install.match(/\$etc\/sites/g)).toHaveLength(1);
    expect(install).toContain('"$repo/deploy/compose.caddy-sites.yml"');
    // The deploy user stays a non-root user outside the docker group whose keys run exactly two commands,
    // so it can neither write /etc/household/sites nor start a Caddy with other files.
    expect(install).toMatch(/^echo 'household ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/household-deploy, \/usr\/local\/sbin\/household-preview' > "\$rule"$/m);
    expect(install).toMatch(/^gpasswd -d household docker /m);
    expect(read("household-deploy.sh")).not.toMatch(/SITES_DIR=|sites\/\S*\.caddy\s*>/);
  });

  it("[PLT-8] every command that starts the house validates Caddy's whole config with the sites first", () => {
    expect(common).toContain("household_compose run --rm --no-deps -T caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile");
    for (const [file, before] of [["household-deploy.sh", "household_compose up"], ["household-setup.sh", "household_compose up"], ["household-restore.sh", "\"$HOUSEHOLD_LIB/restore.sh\""]] as const) {
      const text = read(file);
      const validate = text.search(/^(if ! )?sites_valid\b/m);
      expect(validate, `${file} never validates the sites`).toBeGreaterThan(0);
      expect(validate, `${file} starts something before validating`).toBeLessThan(text.indexOf(before));
      expect(text.slice(validate)).toMatch(/^.*exit 1/m);
    }
  });
});
