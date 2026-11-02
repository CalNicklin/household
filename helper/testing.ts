import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startSupermarket, type SupermarketState } from "../practice/supermarket/app.ts";
import { startHelper } from "./app.ts";
import { readLockedCredentials } from "./secrets.ts";

export const TEST_USERNAME = "practice-shopper";
/** A fresh login every run: no password lives in the repo, not even a test one. */
export const TEST_PASSWORD = randomBytes(18).toString("base64url");
export const TEST_TOKEN = randomBytes(18).toString("base64url");

export type HelperFixture = {
  helperUrl: string;
  supermarketUrl: string;
  state: SupermarketState;
  dataDir: string;
  logs: string[];
  close: () => Promise<void>;
};

/** The practice supermarket and the sealed helper, both real, on random ports. */
export async function startHelperFixture(): Promise<HelperFixture> {
  const dir = mkdtempSync(path.join(tmpdir(), "helper-"));
  const supermarket = await startSupermarket({ port: 0, username: TEST_USERNAME, password: TEST_PASSWORD });
  const credentialsFile = path.join(dir, "supermarket.json");
  writeFileSync(credentialsFile, JSON.stringify({ url: supermarket.url, username: TEST_USERNAME, password: TEST_PASSWORD }), { mode: 0o600 });
  const logs: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const capture = (chunk: string | Uint8Array, ...rest: never[]): boolean => {
    logs.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return write(chunk, ...rest);
  };
  process.stdout.write = capture;
  const dataDir = path.join(dir, "data");
  const helper = await startHelper({ port: 0, token: TEST_TOKEN, credentials: readLockedCredentials(credentialsFile), dataDir });
  return {
    helperUrl: helper.url,
    supermarketUrl: supermarket.url,
    state: supermarket.state,
    dataDir,
    logs,
    close: async () => {
      process.stdout.write = write;
      await helper.close();
      await supermarket.close();
    },
  };
}
