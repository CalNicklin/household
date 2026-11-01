import { readFile } from "node:fs/promises";
import { CalendarOwnerKind, type CalendarWatch, type HouseCalendar } from "@household/contracts";
import { type Env, houseCalendars } from "../../server/env.ts";
import { type CalendarListEntry, listCalendars } from "../../server/integrations/google-calendar.ts";
import { IntegrationError } from "../../server/integrations/http.ts";
import { googleTokenFromFile } from "../../server/integrations/index.ts";
import type { Clock } from "../../server/ports.ts";

/**
 * HOU-147 / HOU-152: `sudo household-google check` on the server, inside the app's image with the
 * house's own settings. It refreshes a token, lists the calendars the token can see (names and IDs,
 * never events), then, for each calendar the house reads (GOOGLE_CALENDARS): its owner, whether this
 * account can read it, whether it shows full details or only free/busy, and its watch. It prints no
 * token and no secret.
 */
export type CheckDeps = {
  env: Env;
  clock: Clock;
  /** The push channels in use (the calendar domain's `watches`). */
  watches: () => Promise<CalendarWatch[]>;
  /** The household's people, by ID, so an owner that isn't one is caught. */
  people: () => Promise<{ id: string; name: string }[]>;
  out: (line: string) => void;
};

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

async function calendarsSeen(env: Env, getAccessToken: () => Promise<string>, chosen: HouseCalendar[], out: (line: string) => void, r: Report): Promise<CalendarListEntry[] | null> {
  let calendars: CalendarListEntry[];
  try {
    calendars = await listCalendars({ getAccessToken, baseUrl: env.GOOGLE_CALENDAR_API });
  } catch (error) {
    r.bad(`couldn't list calendars: ${message(error)}`);
    return null;
  }
  out(`Calendars this account can see (${calendars.length}):`);
  for (const c of calendars) out(`  ${chosen.some((x) => x.calendarId === c.id) ? "→" : " "} ${c.name}${c.primary ? " (primary)" : ""}  ${c.id}  [${c.accessRole}]`);
  return calendars;
}

const whose = (owner: string, people: { id: string; name: string }[]) => (owner === CalendarOwnerKind.shared ? "the shared calendar" : `${people.find((p) => p.id === owner)?.name ?? owner}'s calendar`);

/** One calendar the house reads: whose it is, whether this account can read it, and how much it sees. */
function calendarState(c: HouseCalendar, seen: CalendarListEntry[] | null, people: { id: string; name: string }[], r: Report): void {
  const label = `${whose(c.owner, people)} (${c.owner}: ${c.calendarId})`;
  if (c.owner !== CalendarOwnerKind.shared && !people.some((p) => p.id === c.owner))
    r.bad(`${label}: "${c.owner}" is not anyone in the household; use a person's ID (${people.map((p) => p.id).join(", ")}) or "shared" in GOOGLE_CALENDARS`);
  if (seen === null) return;
  const entry = seen.find((x) => x.id === c.calendarId);
  if (entry === undefined) return r.bad(`${label}: this account can't see it. If it is someone else's, they share it with this Google account ("See all event details") and you accept the share; check the ID against the list above`);
  if (entry.accessRole === "freeBusyReader")
    return r.bad(`${label}: "${entry.name}" is shared as free/busy only, so the house sees when ${c.owner} is busy but no titles ("Busy"). For titles, share it with "See all event details"`);
  r.ok(`✓ ${label}: "${entry.name}", readable, full details [${entry.accessRole}]`);
}

function watchState(env: Env, c: HouseCalendar, w: CalendarWatch | undefined, now: Date, r: Report): void {
  const address = `${env.PUBLIC_URL.replace(/\/+$/, "")}/webhooks/calendar`;
  const who = `watch on ${c.owner}`;
  if (w === undefined) return r.bad(`${who}: none open yet. The app opens one per calendar when it starts with GOOGLE_CALENDARS and the token file set, and retries hourly: redeploy, then check again`);
  const left = new Date(w.expiresAt).getTime() - now.getTime();
  if (left <= 0) return r.bad(`${who}: ended ${w.expiresAt}. The app renews it hourly; see \`docker logs household-app-1 | grep calendar-watch\``);
  if (w.address !== address) return r.bad(`${who}: sends to ${w.address}, not ${address}; the hourly check moves it, or redeploy`);
  r.ok(`✓ ${who}: open since ${w.openedAt}, sending to ${w.address}; Google ends it ${w.expiresAt} (in ${inDaysHours(left)}), and the house renews it a day before`);
}

/** Exit code: 0 when every part is right, 1 when something needs doing (each problem says what). */
export async function googleCheck(deps: CheckDeps): Promise<number> {
  const { env, clock, out } = deps;
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
  const chosen = houseCalendars(env);
  const seen = await calendarsSeen(env, getAccessToken, chosen, out, r);
  if (chosen.length === 0) {
    r.bad("GOOGLE_CALENDARS is not set: in /srv/household/.env name each calendar from the list above with its owner, e.g. GOOGLE_CALENDARS=cal:<id>,chloe:<id>,shared:<id>");
  } else {
    if (env.GOOGLE_CALENDARS !== undefined && env.GOOGLE_CALENDAR_ID !== undefined) out(`  (GOOGLE_CALENDAR_ID is ignored: GOOGLE_CALENDARS is set)`);
    out(`The house reads ${chosen.length} calendar${chosen.length === 1 ? "" : "s"}:`);
    const people = await deps.people();
    const watches = await deps.watches();
    const now = clock.now();
    for (const c of chosen) {
      calendarState(c, seen, people, r);
      watchState(env, c, watches.find((w) => w.calendarId === c.calendarId), now, r);
    }
  }
  out(problems === 0 ? "All good." : `${problems} thing${problems === 1 ? "" : "s"} to fix (above).`);
  return problems === 0 ? 0 : 1;
}
