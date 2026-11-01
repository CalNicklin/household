import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE = "hh_session";
const WEEKS = 26;

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** HOME-6: a kitchen iPad stays logged in for months; the cookie is signed, httpOnly and SameSite. */
export function sessionCookie(person: string, secret: string, now: Date, secure: boolean): string {
  const exp = now.getTime() + WEEKS * 7 * 86_400_000;
  const payload = Buffer.from(`${person}|${exp}`).toString("base64url");
  const value = `${payload}.${sign(payload, secret)}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${WEEKS * 7 * 86_400}${secure ? "; Secure" : ""}`;
}

export function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function personFromCookie(header: string | null | undefined, secret: string, now: Date): string | null {
  if (header === null || header === undefined) return null;
  const raw = header
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (raw === undefined) return null;
  const [payload, mac] = raw.split(".");
  if (payload === undefined || mac === undefined) return null;
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const [person, exp] = Buffer.from(payload, "base64url").toString().split("|");
  if (person === undefined || exp === undefined || Number(exp) < now.getTime()) return null;
  return person;
}
