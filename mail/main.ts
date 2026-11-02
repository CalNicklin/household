import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createReceiver } from "./receiver.ts";

/**
 * HOU-150: the mail receiver's process (deploy/compose.mail.yml). It runs unprivileged; mail/entrypoint.sh
 * copies Caddy's certificate for MAIL_DOMAIN into MAIL_TLS_DIR as it is issued and renewed.
 */
const env = z
  .object({
    MAIL_DOMAIN: z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/),
    EMAIL_WEBHOOK_URL: z.url(),
    EMAIL_WEBHOOK_SECRET: z.string().min(16),
    MAIL_PORT: z.coerce.number().int().default(2525),
    MAIL_TLS_DIR: z.string().default("/run/mail-tls"),
    MAIL_STATE_DIR: z.string().default("/run/mail-state"),
  })
  .parse(process.env);

const keyFile = path.join(env.MAIL_TLS_DIR, "key.pem");
const certFile = path.join(env.MAIL_TLS_DIR, "cert.pem");
const certTime = () => (existsSync(certFile) && existsSync(keyFile) ? statSync(certFile).mtimeMs : null);
const loadTls = () => ({ key: readFileSync(keyFile), cert: readFileSync(certFile) });

let loaded = certTime();
const server = createReceiver({
  domain: env.MAIL_DOMAIN,
  webhookUrl: env.EMAIL_WEBHOOK_URL,
  webhookSecret: env.EMAIL_WEBHOOK_SECRET,
  stateDir: env.MAIL_STATE_DIR,
  tls: loaded === null ? undefined : loadTls(),
});
server.listen(env.MAIL_PORT, () => console.info(JSON.stringify({ event: "mail-listening", port: env.MAIL_PORT, starttls: loaded !== null })));

// A renewed certificate is swapped in; the first one restarts the receiver so it offers STARTTLS
// (restart: unless-stopped brings it back within seconds).
setInterval(
  () => {
    const now = certTime();
    if (now === null || now === loaded) return;
    if (loaded === null) {
      console.info(JSON.stringify({ event: "mail-certificate-arrived" }));
      server.close(() => process.exit(0));
      return;
    }
    try {
      server.updateSecureContext(loadTls());
      loaded = now;
      console.info(JSON.stringify({ event: "mail-certificate-renewed" }));
    } catch (error) {
      console.warn(JSON.stringify({ event: "mail-certificate-unreadable", reason: error instanceof Error ? error.message : String(error) }));
    }
  },
  10 * 60 * 1000,
).unref();

for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => server.close(() => process.exit(0)));
