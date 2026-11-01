import { readFile } from "node:fs/promises";
import type { CalendarWatch } from "@household/contracts";
import type { Env } from "../../server/env.ts";
import { type CalendarListEntry, listCalendars } from "../../server/integrations/google-calendar.ts";
import { IntegrationError } from "../../server/integrations/http.ts";
import { googleTokenFromFile } from "../../server/integrations/index.ts";
import type { Clock } from "../../server/ports.ts";

/**
 * HOU-147: `sudo household-google check` on the server, inside the app's image with the house's own
 * settings. It refreshes a token, lists the calendars the token can see (names and IDs, never events),
 * and says whether the watch is open and when it ends. It prints no token and no secret.
 */
export type CheckDeps = { env: Env; clock: Clock; watch: () => Promise<CalendarWatch | null>; out: (line: string) => void };

const HOUR = 3_600_000;
const inDaysHours = (ms: number) => `${Math.floor(ms / (24 * HOUR))}d ${Math.floor((ms % (24 * HOUR)) / HOUR)}h`;

type Report = { ok: (line: string) => void; bad: (line: string) => void };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The credentials file: a refresh-token grant (the right one) or a fixed access token (dies within the hour). */
async function credentialsForm(file: string, r: Report): Promise<"refresh" | "fixed" | null> {
  let creds: unknown;
  try {
    creds = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
    r.bad(code === undefined ? `${file} is not JSON: copy google.json from \`pnpm google:connect\` again` : `can't read ${file} (${code}): it must be owned by uid 10001, mode 400 (docs/OPERATIONS.md)`);
    return null;
  }
  const refresh = typeof creds === "object" && creds !== null && "refresh_token" in creds;
  if (!refresh) r.bad(`${file} holds a fixed access token, which expires within the hour: run \`pnpm google:connect\` on the laptop and copy its google.json instead`);
  return refresh ? "refresh" : "fixed";
}

async function tokenWorks(getAccessToken: () => Promise<string>, form: "refresh" | "fixed", r: Report): Promise<boolean> {
  try {
    await getAccessToken();
  } catch (error) {
    const refused = error instanceof IntegrationError && (error.status === 400 || error.status === 401);
    r.bad(
      refused
        ? `Google refused the refresh token (HTTP ${error.status}): it expired or was revoked (in testing mode it lasts 7 days). Run \`pnpm google:connect\` again and copy the new google.json`
        : `couldn't get a token: ${message(error)}`,
    );
    return false;
  }
  r.ok(form === "refresh" ? "✓ token: refreshed from the refresh token" : "✓ token: the fixed access token works for now");
  return true;
}

async function calendarsSeen(env: Env, getAccessToken: () => Promise<string>, out: (line: string) => void, r: Report): Promise<void> {
  let calendars: CalendarListEntry[];
  try {
    calendars = await listCalendars({ getAccessToken, baseUrl: env.GOOGLE_CALENDAR_API });
  } catch (error) {
    r.bad(`couldn't list calendars: ${message(error)}`);
    return;
  }
  out(`Calendars this account can see (${calendars.length}):`);
  for (const c of calendars) out(`  ${c.id === env.GOOGLE_CALENDAR_ID ? "→" : " "} ${c.name}${c.primary ? " (primary)" : ""}  ${c.id}  [${c.accessRole}]`);
  const chosen = calendars.find((c) => c.id === env.GOOGLE_CALENDAR_ID);
  if (env.GOOGLE_CALENDAR_ID === undefined) r.bad("GOOGLE_CALENDAR_ID is not set: put the family calendar's ID from the list above in /srv/household/.env");
  else if (chosen === undefined) r.bad(`GOOGLE_CALENDAR_ID (${env.GOOGLE_CALENDAR_ID}) is not one of them: use an ID from the list above`);
  else r.ok(`✓ calendar: the house reads "${chosen.name}"`);
}

function watchState(env: Env, w: CalendarWatch | null, now: Date, r: Report): void {
  const address = `${env.PUBLIC_URL.replace(/\/+$/, "")}/webhooks/calendar`;
  if (w === null) return r.bad("watch: none open yet. The app opens it when it starts with GOOGLE_CALENDAR_ID and the token file set: redeploy, then check again");
  const left = new Date(w.expiresAt).getTime() - now.getTime();
  if (left <= 0) return r.bad(`watch: ended ${w.expiresAt}. The app renews it hourly; see \`docker logs household-app-1 | grep calendar-watch\``);
  if (w.address !== address) return r.bad(`watch: sends to ${w.address}, not ${address}; the hourly check moves it, or redeploy`);
  r.ok(`✓ watch: open since ${w.openedAt}, sending to ${w.address}; Google ends it ${w.expiresAt} (in ${inDaysHours(left)}), and the house renews it a day before`);
}

/** Exit code: 0 when every part is right, 1 when something needs doing (each problem says what). */
export async function googleCheck({ env, clock, watch, out }: CheckDeps): Promise<number> {
  let problems = 0;
  const r: Report = {
    ok: out,
    bad: (line) => {
      problems += 1;
      out(`✗ ${line}`);
    },
  };
  const file = env.GOOGLE_ACCESS_TOKEN_FILE;
  if (file === undefined) {
    r.bad("GOOGLE_ACCESS_TOKEN_FILE is not set in /srv/household/.env (it should be /run/household-credentials/google.json)");
    return 1;
  }
  const form = await credentialsForm(file, r);
  if (form === null) return 1;
  const getAccessToken = googleTokenFromFile(file, clock);
  if (!(await tokenWorks(getAccessToken, form, r))) return 1;
  await calendarsSeen(env, getAccessToken, out, r);
  watchState(env, await watch(), clock.now(), r);
  out(problems === 0 ? "All good." : `${problems} thing${problems === 1 ? "" : "s"} to fix (above).`);
  return problems === 0 ? 0 : 1;
}
