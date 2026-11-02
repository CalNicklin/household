import { lastConfirmation } from "./confirmation.ts";

/** HOU-150: run by `household-email last-confirmation` inside the mail container. Prints the code only. */
const code = await lastConfirmation(process.env["MAIL_STATE_DIR"] ?? "/run/mail-state", new Date());
if (code === null) {
  console.error("no Gmail forwarding confirmation in the last hour");
  process.exit(1);
}
console.log(code);
