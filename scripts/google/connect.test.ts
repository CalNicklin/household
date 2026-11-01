import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fakeServer, json } from "../../server/integrations/fake-http.ts";
import { GOOGLE_CALENDAR_SCOPE } from "../../server/integrations/google-calendar.ts";
import { connectGoogle } from "./connect.ts";

/** HOU-147: `pnpm google:connect` against a stand-in Google token endpoint; the test plays the browser. */
let dir: string;
let closers: (() => Promise<void>)[] = [];
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "google-connect-"));
});
afterEach(async () => {
  await Promise.all(closers.map((c) => c()));
  closers = [];
  rmSync(dir, { recursive: true, force: true });
});

const SECRET = "client-secret-xyz";
const REFRESH = "1//refresh-token-never-shown";

function clientFile(body: unknown = { installed: { client_id: "cid.apps.googleusercontent.com", client_secret: SECRET, redirect_uris: ["http://localhost"] } }): string {
  const file = path.join(dir, "client_secret_test.json");
  writeFileSync(file, JSON.stringify(body));
  return file;
}

/** Run the flow; `browser` decides where Google "sends the browser back" to, given the consent link. */
async function run(options: { token?: (form: URLSearchParams) => { status: number; body: unknown }; browser?: (consent: URL) => string; before?: (consent: URL) => Promise<void>; client?: string }) {
  const token = await fakeServer((req, res) => {
    const reply = (options.token ?? (() => ({ status: 200, body: { access_token: "ya29.x", expires_in: 3599, refresh_token: REFRESH, scope: GOOGLE_CALENDAR_SCOPE, token_type: "Bearer" } })))(new URLSearchParams(req.body.toString()));
    json(res, reply.status, reply.body);
  });
  closers.push(token.close);
  const out = path.join(dir, "google.json");
  const lines: string[] = [];
  let consent: URL | null = null;
  let browserDone: Promise<Response> | null = null;
  const result = connectGoogle({
    clientFile: options.client ?? clientFile(),
    out,
    authUrl: "https://accounts.example/o/oauth2/v2/auth",
    tokenUrl: `${token.url}/token`,
    log: (l) => lines.push(l),
    onAuthUrl: (url) => {
      lines.push(url);
      consent = new URL(url);
      const back = (options.browser ?? ((c) => `${c.searchParams.get("redirect_uri")}?state=${c.searchParams.get("state")}&code=4/auth-code&scope=${encodeURIComponent(GOOGLE_CALENDAR_SCOPE)}`))(consent);
      const first = options.before?.(consent) ?? Promise.resolve();
      browserDone = first.then(() => fetch(back));
    },
  }).then(
    () => null,
    (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
  );
  const error = await result;
  const page = browserDone === null ? null : await (browserDone as Promise<Response>).then((r) => r.text());
  return { error, out, lines, consent: consent as URL | null, token, page };
}

describe("pnpm google:connect (HOU-147)", () => {
  test("[PRV-1] asks for calendar.readonly only, with PKCE S256, a state and a loopback redirect, and writes google.json mode 600 without printing the token", async () => {
    const r = await run({});
    expect(r.error).toBeNull();
    const c = r.consent;
    if (c === null) throw new Error("no consent link");
    expect(c.origin + c.pathname).toBe("https://accounts.example/o/oauth2/v2/auth");
    expect(c.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/calendar.readonly");
    expect(c.searchParams.get("client_id")).toBe("cid.apps.googleusercontent.com");
    expect(c.searchParams.get("response_type")).toBe("code");
    expect(c.searchParams.get("code_challenge_method")).toBe("S256");
    expect(c.searchParams.get("access_type")).toBe("offline");
    expect(c.searchParams.get("prompt")).toBe("consent");
    expect(c.searchParams.get("state")).toMatch(/^[\w-]{20,}$/);
    expect(c.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(c.searchParams.has("client_secret")).toBe(false);

    // The code is swapped with the verifier whose hash the link carried, on the same redirect address.
    expect(r.token.requests).toHaveLength(1);
    const form = new URLSearchParams(r.token.requests[0]?.body.toString());
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("4/auth-code");
    expect(form.get("redirect_uri")).toBe(c.searchParams.get("redirect_uri"));
    expect(form.get("client_secret")).toBe(SECRET);
    const verifier = form.get("code_verifier") ?? "";
    expect(verifier).toMatch(/^[\w-]{43,128}$/);
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(c.searchParams.get("code_challenge"));

    // The file is exactly what server/integrations/index.ts reads, for its owner only.
    expect(JSON.parse(readFileSync(r.out, "utf8"))).toEqual({ client_id: "cid.apps.googleusercontent.com", client_secret: SECRET, refresh_token: REFRESH });
    expect(statSync(r.out).mode & 0o777).toBe(0o600);
    expect(r.page).toContain("Connected");
    const said = r.lines.join("\n");
    expect(said).not.toContain(REFRESH);
    expect(said).not.toContain(SECRET);
    expect(said).not.toContain("ya29.x");
  });

  test("replaces an older google.json, still mode 600", async () => {
    writeFileSync(path.join(dir, "google.json"), "old", { mode: 0o644 });
    const r = await run({});
    expect(r.error).toBeNull();
    expect(JSON.parse(readFileSync(r.out, "utf8")).refresh_token).toBe(REFRESH);
    expect(statSync(r.out).mode & 0o777).toBe(0o600);
  });

  test("a request with another run's state is refused and never swapped, and the real reply still connects", async () => {
    let refused = 0;
    const r = await run({
      before: async (c) => {
        refused = (await fetch(`${c.searchParams.get("redirect_uri")}?state=forged&code=4/stolen`)).status;
      },
    });
    expect(refused).toBe(400);
    expect(r.error).toBeNull();
    expect(r.token.requests).toHaveLength(1);
    expect(new URLSearchParams(r.token.requests[0]?.body.toString()).get("code")).toBe("4/auth-code");
  });

  test("Google saying no writes nothing", async () => {
    const r = await run({ browser: (c) => `${c.searchParams.get("redirect_uri")}?state=${c.searchParams.get("state")}&error=access_denied` });
    expect(r.error?.message).toMatch(/access_denied/);
    expect(() => statSync(r.out)).toThrow(/ENOENT/);
  });

  test("[PRV-1] a grant wider than calendar.readonly is refused and nothing is written", async () => {
    const r = await run({ token: () => ({ status: 200, body: { access_token: "a", refresh_token: REFRESH, scope: `${GOOGLE_CALENDAR_SCOPE} https://www.googleapis.com/auth/calendar` } }) });
    expect(r.error?.message).toMatch(/not only/);
    expect(r.error?.message).not.toContain(REFRESH);
    expect(() => statSync(r.out)).toThrow(/ENOENT/);
  });

  test("no refresh token (consent given before) says how to fix it; a refused code shows only Google's error name", async () => {
    const none = await run({ token: () => ({ status: 200, body: { access_token: "a", scope: GOOGLE_CALENDAR_SCOPE } }) });
    expect(none.error?.message).toMatch(/no refresh token.*myaccount\.google\.com/);
    expect(() => statSync(none.out)).toThrow(/ENOENT/);
    const refused = await run({ token: () => ({ status: 400, body: { error: "invalid_grant", error_description: "Bad Request" } }) });
    expect(refused.error?.message).toBe("Google refused the code (HTTP 400, invalid_grant); nothing was written");
  });

  test("a Web application client is refused before anything starts", async () => {
    const r = await run({ client: clientFile({ web: { client_id: "c", client_secret: "s" } }) });
    expect(r.error?.message).toMatch(/Desktop app/);
    expect(r.consent).toBeNull();
  });
});
