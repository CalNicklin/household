import { createHash, randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { z } from "zod";
import { GOOGLE_CALENDAR_SCOPE } from "../../server/integrations/google-calendar.ts";

/**
 * HOU-147: get the real house a Google refresh token, on Cal's laptop, without the token ever being
 * shown or pasted. The OAuth installed-app flow (RFC 8252): a loopback redirect on 127.0.0.1, PKCE
 * (S256) and a random state, asking for `calendar.readonly` only (PRV-1). The token is written to a
 * file with mode 600 and never printed; the file then goes to the server with scp.
 */

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** The JSON Google offers to download for a "Desktop app" OAuth client (or the two fields alone). */
const zClientFile = z.union([
  z.object({ installed: z.object({ client_id: z.string().min(1), client_secret: z.string().min(1) }) }).transform((f) => f.installed),
  z.object({ client_id: z.string().min(1), client_secret: z.string().min(1) }),
]);

const zTokenResponse = z.object({ refresh_token: z.string().min(1).optional(), scope: z.string().optional(), access_token: z.string().optional() });

const base64url = (b: Buffer) => b.toString("base64url");

export type ConnectOptions = {
  /** The client JSON downloaded from Google Cloud (Credentials → the Desktop client → Download JSON). */
  clientFile: string;
  /** Where to write the credentials the house reads (GOOGLE_ACCESS_TOKEN_FILE). */
  out: string;
  /** Called with the consent link: printed for Cal to open. Tests follow it themselves. */
  onAuthUrl: (url: string) => void;
  /** Progress lines. Never given a token or the client secret. */
  log: (line: string) => void;
  authUrl?: string;
  tokenUrl?: string;
};

class ConnectError extends Error {}

async function readClient(file: string): Promise<{ client_id: string; client_secret: string }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new ConnectError(`can't read ${file} as JSON: download it from Google Cloud → Credentials → your Desktop client → Download JSON`);
  }
  if (typeof raw === "object" && raw !== null && "web" in raw) throw new ConnectError("that is a Web application client; make a Desktop app client (docs/OPERATIONS.md, Google Calendar step 1)");
  const parsed = zClientFile.safeParse(raw);
  if (!parsed.success) throw new ConnectError(`${file} has no client_id and client_secret: it should be the Desktop client's downloaded JSON`);
  return parsed.data;
}

function finish(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close" });
  res.end(text);
}

/** Wait for Google to send the browser back to the loopback address with a code (or an error). */
function awaitRedirect(state: string, onListening: (redirectUri: string) => void): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    let redirectUri = "";
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", redirectUri);
      if (url.pathname !== "/") return finish(res, 404, "not here");
      const done = (outcome: () => void, status: number, text: string) => {
        finish(res, status, text);
        server.close();
        server.closeAllConnections();
        outcome();
      };
      // Not this run's reply (a stray request, a second tab): refuse it and keep waiting for Google's.
      if (url.searchParams.get("state") !== state) return finish(res, 400, "This doesn't match the link this run printed. Nothing was saved.");
      const error = url.searchParams.get("error");
      if (error !== null) return done(() => reject(new ConnectError(`Google said "${error}"; nothing was written`)), 400, "Google didn't give access. Nothing was saved; you can close this tab.");
      const code = url.searchParams.get("code");
      if (code === null) return done(() => reject(new ConnectError("Google's reply had no code; nothing was written")), 400, "No code in Google's reply. Nothing was saved.");
      done(() => resolve({ code, redirectUri }), 200, "Connected. You can close this tab and go back to the terminal.");
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") return reject(new ConnectError("no loopback port"));
      redirectUri = `http://127.0.0.1:${address.port}/`;
      onListening(redirectUri);
    });
  });
}

/** Write JSON readable by its owner only: a fresh mode-600 file, then renamed over `out`. */
async function writePrivate(out: string, body: unknown): Promise<void> {
  const temp = path.join(path.dirname(out), `.${path.basename(out)}.${base64url(randomBytes(6))}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temp, out);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export async function connectGoogle(o: ConnectOptions): Promise<void> {
  const client = await readClient(o.clientFile);
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const state = base64url(randomBytes(16));
  const { code, redirectUri } = await awaitRedirect(state, (loopback) => {
    const url = new URL(o.authUrl ?? GOOGLE_AUTH_URL);
    url.search = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: loopback,
      response_type: "code",
      scope: GOOGLE_CALENDAR_SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      // A refresh token, and asked for again even if this account said yes before.
      access_type: "offline",
      prompt: "consent",
    }).toString();
    o.onAuthUrl(url.toString());
  });
  o.log("Google said yes; swapping the code for a refresh token…");
  const response = await fetch(o.tokenUrl ?? GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, client_id: client.client_id, client_secret: client.client_secret }).toString(),
  });
  if (!response.ok) {
    // Google's error names (e.g. invalid_grant) carry no secret; nothing else from the reply is shown.
    const reason = z.object({ error: z.string() }).safeParse(await response.json().catch(() => null));
    throw new ConnectError(`Google refused the code (HTTP ${response.status}${reason.success ? `, ${reason.data.error}` : ""}); nothing was written`);
  }
  const token = zTokenResponse.parse(await response.json());
  const granted = (token.scope ?? "").split(" ").filter((s) => s !== "");
  if (granted.length === 0 || granted.some((s) => s !== GOOGLE_CALENDAR_SCOPE)) throw new ConnectError(`Google granted "${granted.join(" ")}", not only ${GOOGLE_CALENDAR_SCOPE}; nothing was written`);
  if (token.refresh_token === undefined)
    throw new ConnectError("Google gave no refresh token; nothing was written. Remove the app's access at https://myaccount.google.com/connections and run this again");
  await writePrivate(o.out, { client_id: client.client_id, client_secret: client.client_secret, refresh_token: token.refresh_token });
  o.log(`Wrote ${o.out} (mode 600, read-only calendar access). It holds the refresh token: don't open, paste or commit it.`);
}

export function isConnectError(error: unknown): error is Error {
  return error instanceof ConnectError;
}
