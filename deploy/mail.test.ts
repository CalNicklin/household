import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

/**
 * HOU-150 on the VPS: the mail receiver is an overlay the house takes only once install.sh is given
 * --mail-domain, so a deploy without it runs exactly the four containers it did. When it runs, it is
 * the one container on port 25, capped like the rest and with no power over anything but its own mail.
 */
const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
const zService = z.looseObject({
  image: z.string().optional(),
  mem_limit: z.string().optional(),
  memswap_limit: z.string().optional(),
  ports: z.array(z.string()).optional(),
  user: z.string().optional(),
  cap_drop: z.array(z.string()).optional(),
  cap_add: z.array(z.string()).optional(),
  security_opt: z.array(z.string()).optional(),
  read_only: z.boolean().optional(),
  privileged: z.boolean().optional(),
  network_mode: z.string().optional(),
  networks: z.unknown().optional(),
  volumes: z.array(z.string()).optional(),
  env_file: z.unknown().optional(),
  environment: z.record(z.string(), z.string()).optional(),
});
const zCompose = z.looseObject({ "x-memory": z.record(z.string(), z.string()).optional(), services: z.record(z.string(), zService) });
const overlay = zCompose.parse(parse(read("compose.mail.yml"), { merge: true }));
const mail = overlay.services["mail"] ?? zService.parse({});
const megabytes = (limit: string) => Number(/^(\d+)m$/.exec(limit)?.[1] ?? Number.NaN);

describe("the mail receiver on the VPS", () => {
  it("[PLT-8] is added only when MAIL_DOMAIN is set, so a deploy without install.sh --mail-domain is unchanged", () => {
    expect(read("household-common.sh")).toMatch(/if grep -qE '\^MAIL_DOMAIN=\.\+' "\$HOUSEHOLD_DIR\/\.env"; then COMPOSE_FILE="\$COMPOSE_FILE:\$HOUSEHOLD_DIR\/compose\.mail\.yml"; fi/);
    expect(read("compose.yml")).not.toMatch(/mail/i);
    expect(read("Caddyfile")).toMatch(/^import \/etc\/caddy\/mail\/\*\.caddy$/m);
    // The Caddy site that gets the certificate exists only through the overlay's mount.
    expect(overlay.services["caddy"]?.volumes).toEqual(["./Caddyfile.mail:/etc/caddy/mail/mail.caddy:ro"]);
    expect(read("Caddyfile.mail")).toMatch(/^\{\$MAIL_DOMAIN\} \{\n\trespond 404\n\}/m);
    expect(read("install.sh")).toContain('"$repo/deploy/compose.mail.yml"');
    expect(read("install.sh")).toContain('"$repo/deploy/Caddyfile.mail"');
  });

  it("[PLT-8] has a hard memory cap, swap included, set in x-memory, that keeps the house under 700 MB", () => {
    expect(mail.mem_limit).toBe(overlay["x-memory"]?.["mail"]);
    expect(mail.memswap_limit).toBe(mail.mem_limit);
    const house = z.object({ services: z.record(z.string(), z.looseObject({ mem_limit: z.string() })) }).parse(parse(read("compose.yml"), { merge: true }));
    const total = Object.values(house.services).reduce((sum, s) => sum + megabytes(s.mem_limit), megabytes(mail.mem_limit ?? ""));
    expect(total).toBeLessThanOrEqual(700);
  });

  it("[PRV-6] opens only port 25, runs the house's image, and has nothing but its own mail to touch", () => {
    expect(mail.ports).toEqual(["25:2525"]);
    expect(mail.image).toMatch(/^\$\{HOUSEHOLD_IMAGE:\?.*\}$/);
    expect(mail.network_mode).toBeUndefined();
    expect(mail.privileged ?? false).toBe(false);
    expect(mail.read_only).toBe(true);
    expect(mail.cap_drop).toEqual(["ALL"]);
    // Only to become the unprivileged `house` user after reading Caddy's key (mail/entrypoint.sh).
    expect(mail.cap_add).toEqual(["SETUID", "SETGID"]);
    expect(mail.security_opt).toContain("no-new-privileges:true");
    expect(read("../mail/entrypoint.sh")).toMatch(/^exec setpriv --reuid="\$\(id -u house\)" --regid="\$\(id -g house\)" --clear-groups --inh-caps=-all node mail\/main\.ts$/m);
    expect(mail.volumes).toEqual(["caddy-data:/caddy-data:ro"]);
    for (const v of mail.volumes ?? []) expect(v).not.toContain("docker.sock");
    // Only the webhook's own secret, not the house's .env.
    expect(mail.env_file).toBeUndefined();
    expect(Object.keys(mail.environment ?? {}).sort()).toEqual(["EMAIL_WEBHOOK_SECRET", "EMAIL_WEBHOOK_URL", "MAIL_DOMAIN", "NODE_OPTIONS"]);
    expect(mail.environment?.["EMAIL_WEBHOOK_URL"]).toBe("http://app:3001/webhooks/email");
  });

  it("[PRV-6] household-email prints only the confirmation code, and the deploy user can't run it", () => {
    expect(read("household-email.sh")).toContain("household_compose exec -T --user house mail node mail/last-confirmation.ts");
    expect(read("install.sh")).toMatch(/^echo 'household ALL=\(root\) NOPASSWD: \/usr\/local\/sbin\/household-deploy, \/usr\/local\/sbin\/household-preview' > "\$rule"$/m);
    expect(read("install.sh")).toMatch(/for c in deploy setup backup restore preview email; do/);
  });
});
