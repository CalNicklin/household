import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * HOU-175: the real household-common.sh, household-deploy.sh, -setup.sh and -restore.sh, run by bash against
 * temporary directories and a stand-in `docker` that logs its calls. The owner they require is root on the
 * server (SITES_OWNER_UID, root's household.conf); here it is whoever runs the tests, so they run unprivileged.
 * deploy/test-deploy.sh does the same against real Docker and a real Caddy.
 */
const deploy = path.dirname(new URL(import.meta.url).pathname);
const uid = process.getuid?.() ?? 0;
const digest = `sha256:${"a".repeat(64)}`;
const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The stand-in docker: logs each call; `compose run … caddy sh -c` answers as the throwaway Caddy would.
const stubDocker = `#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
case "$*" in
  *"caddy sh -c"*)
    case "$STUB_SITES" in
      invalid) echo "Error: adapting config using caddyfile: /etc/caddy/sites/bad.caddy:2: unrecognized directive: not_a_directive" >&2; exit 1 ;;
      ipv6) echo 172.18.0.3; echo '{"apps":{"http":{"servers":{"srv0":{"listen":["[::]:443"]}}}}}' ;;
      *) echo 172.18.0.3; echo '{"apps":{"http":{"servers":{"srv0":{"listen":["172.18.0.3:443"]},"srv1":{"listen":["127.0.0.1:5555"]}}}}}' ;;
    esac ;;
esac
exit 0
`;

/** A server laid out as install.sh leaves it, in a temporary directory, with the household-* commands beside a stand-in restore.sh. */
function server(options: { owner?: number } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "hou-175-"));
  made.push(root);
  const srv = path.join(root, "srv");
  const lib = path.join(root, "lib");
  const bin = path.join(root, "bin");
  const sites = path.join(root, "sites");
  for (const dir of [srv, lib, bin]) mkdirSync(dir);
  writeFileSync(path.join(srv, ".env"), "HOUSEHOLD_DOMAIN=house.example.com\n");
  writeFileSync(path.join(srv, "image"), `ghcr.io/calnicklin/household@${digest}\n`);
  copyFileSync(path.join(deploy, "compose.caddy-sites.yml"), path.join(srv, "compose.caddy-sites.yml"));
  for (const file of readdirSync(deploy).filter((f) => /^household-.*\.sh$/.test(f))) copyFileSync(path.join(deploy, file), path.join(lib, file));
  // The one change to the real scripts: the owner they require is root's uid on the server, the test runner's here.
  const common = readFileSync(path.join(deploy, "household-common.sh"), "utf8");
  const owned = common.replace(/^SITES_OWNER_UID=0$/m, `SITES_OWNER_UID=${options.owner ?? uid}`);
  if (owned === common && (options.owner ?? uid) !== 0) throw new Error("household-common.sh no longer sets SITES_OWNER_UID=0");
  writeFileSync(path.join(lib, "household-common.sh"), owned);
  writeFileSync(path.join(lib, "restore.sh"), '#!/usr/bin/env bash\necho "restore.sh $*" >> "$STUB_LOG"\n', { mode: 0o755 });
  writeFileSync(path.join(bin, "docker"), stubDocker, { mode: 0o755 });
  const conf = path.join(root, "household.conf");
  writeFileSync(conf, `HOUSEHOLD_DIR=${srv}\nSITES_DIR=${sites}\nPREVIEWS_DIR=${path.join(root, "previews")}\n`);
  const log = path.join(root, "docker.log");
  writeFileSync(log, "");
  return {
    srv,
    sites,
    /** Writes a site file (mode 0644 unless given). */
    site(name: string, mode = 0o644) {
      mkdirSync(sites, { recursive: true, mode: 0o755 });
      chmodSync(sites, 0o755);
      writeFileSync(path.join(sites, name), "trader.example.com {\n\treverse_proxy host.docker.internal:3847\n}\n", { mode });
      chmodSync(path.join(sites, name), mode);
    },
    /** Runs bash with household-common.sh sourced, or one of the household-* commands, as the server would. */
    run(args: string[], extra: { stdin?: string; sites?: "valid" | "invalid" | "ipv6" } = {}) {
      const result = spawnSync("bash", args, {
        cwd: root,
        input: extra.stdin ?? "",
        encoding: "utf8",
        env: { PATH: `${bin}:${process.env["PATH"] ?? ""}`, HOUSEHOLD_CONF: conf, STUB_LOG: log, STUB_SITES: extra.sites ?? "valid" },
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls: readFileSync(log, "utf8").split("\n").filter(Boolean) };
    },
    common(script: string) {
      return this.run(["-c", `source "${path.join(lib, "household-common.sh")}"\n${script}`]);
    },
    command(name: string, args: string[] = [], extra: { stdin?: string; sites?: "valid" | "invalid" | "ipv6" } = {}) {
      return this.run([path.join(lib, `household-${name}.sh`), ...args], extra);
    },
  };
}

const overlay = (s: ReturnType<typeof server>) => s.common('echo "$COMPOSE_FILE"; echo "${SITES_HASH:-}"');
const withSites = (s: ReturnType<typeof server>) => overlay(s).stdout.split("\n")[0]?.endsWith(":" + path.join(s.srv, "compose.caddy-sites.yml")) ?? false;

describe("HOU-175: which sites the house's Caddy takes (household-common.sh)", () => {
  it("[PLT-8] no sites directory, or one with no *.caddy file: the overlay is left out, silently", () => {
    const s = server();
    expect(withSites(s)).toBe(false);
    expect(overlay(s).stderr).toBe("");
    mkdirSync(s.sites, { mode: 0o755 });
    writeFileSync(path.join(s.sites, "README"), "not a site\n");
    expect(withSites(s)).toBe(false);
    expect(overlay(s).stderr).toBe("");
  });

  it("[PLT-8] a directory and *.caddy files only their owner can write: the overlay, with the files' hash as Caddy's label", () => {
    const s = server();
    s.site("trader.caddy");
    expect(withSites(s)).toBe(true);
    const hash = overlay(s).stdout.split("\n")[1];
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    writeFileSync(path.join(s.sites, "trader.caddy"), "trader.example.com {\n\trespond 404\n}\n");
    expect(overlay(s).stdout.split("\n")[1], "a changed site would not recreate Caddy").not.toBe(hash);
    // A hidden file is a site too (Caddy's glob loads it): it counts in the hash, and alone it is enough.
    const before = overlay(s).stdout.split("\n")[1];
    writeFileSync(path.join(s.sites, ".monitor.caddy"), "monitor.example.com {\n\trespond 404\n}\n", { mode: 0o644 });
    chmodSync(path.join(s.sites, ".monitor.caddy"), 0o644);
    expect(overlay(s).stdout.split("\n")[1], "a hidden site would not recreate Caddy").not.toBe(before);
    rmSync(path.join(s.sites, "trader.caddy"));
    expect(withSites(s)).toBe(true);
  });

  it("[PRV-6] anything but root alone able to change a site leaves the overlay out, and says why", () => {
    const cases: [string, (s: ReturnType<typeof server>) => void, RegExp][] = [
      ["a group-writable directory", (s) => chmodSync(s.sites, 0o775), /is not root's alone/],
      ["an other-writable directory", (s) => chmodSync(s.sites, 0o757), /is not root's alone/],
      ["a group-writable file", (s) => chmodSync(path.join(s.sites, "trader.caddy"), 0o664), /trader\.caddy is not a root-owned file/],
      ["an other-writable file", (s) => chmodSync(path.join(s.sites, "trader.caddy"), 0o646), /trader\.caddy is not a root-owned file/],
      ["a symlinked file", (s) => symlinkSync("/etc/hostname", path.join(s.sites, "link.caddy")), /link\.caddy is not a root-owned file/],
      ["a hidden group-writable file (Caddy's glob loads it)", (s) => {
        writeFileSync(path.join(s.sites, ".old.caddy"), "x\n");
        chmodSync(path.join(s.sites, ".old.caddy"), 0o664);
      }, /\.old\.caddy is not a root-owned file/],
      ["a file named just .caddy", (s) => symlinkSync("/etc/hostname", path.join(s.sites, ".caddy")), /sites\/\.caddy is not a root-owned file/],
      ["a hidden symlink", (s) => symlinkSync("/etc/hostname", path.join(s.sites, ".link.caddy")), /\.link\.caddy is not a root-owned file/],
    ];
    for (const [what, spoil, note] of cases) {
      const s = server();
      s.site("trader.caddy");
      spoil(s);
      expect(withSites(s), what).toBe(false);
      expect(overlay(s).stderr, what).toMatch(note);
    }
    // A symlinked directory, even to a good one.
    const s = server();
    s.site("trader.caddy");
    const link = path.join(path.dirname(s.sites), "linked");
    symlinkSync(s.sites, link);
    writeFileSync(path.join(path.dirname(s.srv), "household.conf"), readFileSync(path.join(path.dirname(s.srv), "household.conf"), "utf8").replace(`SITES_DIR=${s.sites}`, `SITES_DIR=${link}`));
    expect(withSites(s)).toBe(false);
  });

  it("[PRV-6] files and a directory owned by anyone but the required owner (root on the server) are left out", () => {
    const s = server({ owner: uid + 1 });
    s.site("trader.caddy");
    expect(withSites(s)).toBe(false);
    expect(overlay(s).stderr).toMatch(/is not root's alone/);
  });
});

const check = (front: string, json: string) => server().common(`sites_listeners_ok '${front}' <<'JSON'\n${json}\nJSON`);
const servers = (...listen: string[][]) => JSON.stringify({ apps: { http: { servers: Object.fromEntries(listen.map((l, i) => [`srv${i}`, { listen: l }])) } } });

describe("HOU-175: Caddy's listeners with the sites (sites_listeners_ok)", () => {
  it("[FB-5] takes the front address (any port, tcp or udp) and 127.0.0.1, a site bound to the front address included", () => {
    expect(check("172.18.0.3", servers(["172.18.0.3:443"], ["udp/172.18.0.3:443"], ["127.0.0.1:5555"], ["172.18.0.3:8443"])).status).toBe(0);
  });

  it("[FB-5] refuses any other listener, naming it: IPv6, every address, another IP, or one only like the front address", () => {
    for (const listen of [["[::]:443"], ["[::1]:443"], ["0.0.0.0:443"], [":443"], ["172.18.0.31:443"], ["172.18.0.3:443", "10.0.0.1:80"], ["172x18x0x3:443"]]) {
      const r = check("172.18.0.3", servers(["172.18.0.3:443"], listen));
      expect(r.status, listen.join(" ")).toBe(1);
      expect(r.stderr, listen.join(" ")).toContain(`a site listens on ${JSON.stringify(listen)}, not only on the front address 172.18.0.3`);
    }
  });

  it("[FB-5] fails closed: no front address, or no listener at all", () => {
    expect(check("", servers(["172.18.0.3:443"])).stderr).toContain("no front address");
    expect(check("172.18.0.3", "{}").stderr).toContain("the config has no listener");
  });
});

const firstUp = (calls: string[]) => calls.findIndex((c) => /^docker compose up\b/.test(c) || c.startsWith("restore.sh"));
const validation = (calls: string[]) => calls.findIndex((c) => c.startsWith("docker compose run --rm --no-deps -T caddy sh -c"));

describe("HOU-175: every command that starts the house validates the sites first", () => {
  const commands: [string, string[], string][] = [
    ["deploy", [digest], ""],
    ["setup", [], '{"name":"Home"}'],
    ["restore", ["/var/backups/household/x"], ""],
  ];

  it("[PLT-8] without sites nothing is validated and each command runs as before", () => {
    for (const [name, args, stdin] of commands) {
      const r = server().command(name, args, { stdin });
      expect(r.status, `${name}: ${r.stderr}`).toBe(0);
      expect(validation(r.calls), name).toBe(-1);
      expect(firstUp(r.calls), name).toBeGreaterThanOrEqual(0);
    }
  });

  it("[PLT-8] valid sites: validated in a throwaway Caddy before anything is started", () => {
    for (const [name, args, stdin] of commands) {
      const s = server();
      s.site("trader.caddy");
      const r = s.command(name, args, { stdin });
      expect(r.status, `${name}: ${r.stderr}`).toBe(0);
      expect(validation(r.calls), name).toBeGreaterThanOrEqual(0);
      expect(validation(r.calls), `${name} started something before validating`).toBeLessThan(firstUp(r.calls));
      expect(r.calls.slice(0, validation(r.calls)).filter((c) => /^docker compose (up|run)/.test(c)), name).toEqual([]);
      expect(r.stdout, name).toContain(`caddy config with ${s.sites} is valid`);
    }
  });

  it("[PLT-8] an invalid site or a listener beyond the front address: the command stops, names it, and starts nothing", () => {
    for (const [sites, said] of [
      ["invalid", "/sites/bad.caddy:2: unrecognized directive: not_a_directive"], // the host path, not Caddy's /etc/caddy/sites
      ["ipv6", 'a site listens on ["[::]:443"], not only on the front address 172.18.0.3'],
    ] as const)
      for (const [name, args, stdin] of commands) {
        const s = server();
        s.site("trader.caddy");
        const r = s.command(name, args, { stdin, sites });
        expect(r.status, `${name} ${sites}`).toBe(1);
        expect(r.stderr, `${name} ${sites}`).toContain(said);
        expect(r.stderr, `${name} ${sites} named Caddy's path, not the server's`).not.toContain("/etc/caddy/sites/");
        expect(r.calls.filter((c) => /^docker compose (up|run --rm -T --no-deps app)/.test(c) || c.startsWith("restore.sh")), `${name} started something with ${sites} sites`).toEqual([]);
      }
  });
});
