import { lastConfirmation } from "./confirmation.ts";

/**
 * HOU-150 / HOU-169: run by `household-email last-confirmation` inside the mail container. Prints the
 * code on its own line, then the confirmation link if there was one; nothing else of the email.
 */
const saved = await lastConfirmation(process.env["MAIL_STATE_DIR"] ?? "/run/mail-state", new Date());
if (saved === null) {
  console.error("no Gmail forwarding confirmation in the last hour");
  process.exit(1);
}
console.log(saved.code ?? "(no code in the email; use the link)");
if (saved.link !== null) console.log(saved.link);
