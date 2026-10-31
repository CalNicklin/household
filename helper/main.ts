import { startHelper } from "./app.ts";
import { readLockedCredentials } from "./secrets.ts";

const token = process.env["HELPER_TOKEN"];
const credentialsFile = process.env["SUPERMARKET_CREDENTIALS_FILE"] ?? "/run/secrets/supermarket";
if (token === undefined || token === "") throw new Error("HELPER_TOKEN is required");

const { url } = await startHelper({
  token,
  credentials: readLockedCredentials(credentialsFile),
  dataDir: process.env["HELPER_DATA_DIR"] ?? ".data/helper",
  port: Number(process.env["PORT"] ?? 3003),
});
process.stdout.write(`${JSON.stringify({ helper: `listening on ${url}` })}\n`);
