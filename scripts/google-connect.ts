import { parseArgs } from "node:util";
import { connectGoogle, isConnectError } from "./google/connect.ts";

/**
 * HOU-147, on Cal's laptop: `pnpm google:connect --client <downloaded client JSON> [--out google.json]`.
 * Opens nothing by itself: it prints Google's consent link, waits for the browser to come back to
 * 127.0.0.1, and writes the credentials file (mode 600). Copy that file to the server with scp
 * (docs/OPERATIONS.md, "Google Calendar").
 */
// `pnpm google:connect -- --client …` passes the `--` on; it is not an argument.
const { values } = parseArgs({ args: process.argv.slice(2).filter((a) => a !== "--"), options: { client: { type: "string" }, out: { type: "string", default: "google.json" } } });
if (values.client === undefined) {
  console.error("usage: pnpm google:connect --client ~/Downloads/client_secret_….json [--out google.json]");
  process.exit(2);
}
try {
  await connectGoogle({
    clientFile: values.client,
    out: values.out,
    onAuthUrl: (url) => console.error(`Open this link in the browser where you are signed in to the Google account that has the family calendar:\n\n${url}\n\nWaiting for Google to send you back here… (Ctrl-C to stop)`),
    log: (line) => console.error(line),
  });
} catch (error) {
  if (!isConnectError(error)) throw error;
  console.error(error.message);
  process.exit(1);
}
