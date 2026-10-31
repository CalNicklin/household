import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeServer } from "./fake-http.ts";
import { decrypt, encrypt, FsObjectStore, S3ObjectStore } from "./s3-object-store.ts";

const KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const PLAINTEXT = new TextEncoder().encode("Screenshot of the Ocado basket: Oatly Barista 1L");

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((c) => c()));
});

/** A tiny S3 stand-in: path-style PUT/GET/DELETE, keeping exactly the bytes it was sent. */
async function fakeS3() {
  const objects = new Map<string, { body: Buffer; headers: Record<string, string> }>();
  const server = await fakeServer((req, res) => {
    const key = decodeURIComponent(new URL(req.path, "http://x").pathname);
    if (req.method === "PUT") {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && k.startsWith("x-amz-")) headers[k] = v;
      objects.set(key, { body: req.body, headers });
      res.writeHead(200, { etag: '"1"' });
      return res.end();
    }
    if (req.method === "GET") {
      const obj = objects.get(key);
      if (obj === undefined) {
        res.writeHead(404, { "content-type": "application/xml" });
        return res.end("<?xml version=\"1.0\"?><Error><Code>NoSuchKey</Code><Message>missing</Message></Error>");
      }
      const meta = obj.headers["x-amz-meta-plain-content-type"];
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(obj.body.length), ...(meta === undefined ? {} : { "x-amz-meta-plain-content-type": meta }) });
      return res.end(obj.body);
    }
    if (req.method === "DELETE") {
      objects.delete(key);
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(405);
    res.end();
  });
  cleanups.push(server.close);
  return { server, objects };
}

describe("object storage", () => {
  it("[PLT-7] objects are encrypted before they leave the process", async () => {
    const { server, objects } = await fakeS3();
    const store = new S3ObjectStore({ endpoint: server.url, bucket: "household", accessKeyId: "minio", secretAccessKey: "minio-secret", encryptionKey: KEY, sse: true });
    await store.put("runs/r1/basket.png", PLAINTEXT, "image/png");

    const stored = objects.get("/household/runs/r1/basket.png");
    expect(stored).toBeDefined();
    const bytes = stored?.body ?? Buffer.alloc(0);
    expect(bytes.includes(Buffer.from("Oatly"))).toBe(false);
    expect(bytes.length).toBe(12 + PLAINTEXT.length + 16);
    expect(stored?.headers["x-amz-server-side-encryption"]).toBe("AES256");

    const back = await store.get("runs/r1/basket.png");
    expect(back?.contentType).toBe("image/png");
    expect(new TextDecoder().decode(back?.body)).toBe(new TextDecoder().decode(PLAINTEXT));

    expect(await store.get("runs/r1/missing.png")).toBeNull();
    await store.delete("runs/r1/basket.png");
    expect(await store.get("runs/r1/basket.png")).toBeNull();
  });

  it("[PLT-7] tampered ciphertext is rejected, not returned", () => {
    const key = Buffer.from(KEY, "hex");
    const sealed = encrypt(key, PLAINTEXT);
    const last = sealed.length - 1;
    sealed[last] = (sealed[last] ?? 0) ^ 1;
    expect(() => decrypt(key, sealed)).toThrow(/authenticate/);
  });

  it("[PLT-7] the local-disk store uses the same encryption and stays inside its folder", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "objects-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const store = new FsObjectStore({ dir, encryptionKey: KEY });
    await store.put("runs/r2/step-1.png", PLAINTEXT, "image/png");
    const raw = await readFile(path.join(dir, "runs/r2/step-1.png"));
    expect(raw.includes(Buffer.from("Oatly"))).toBe(false);
    expect((await store.get("runs/r2/step-1.png"))?.contentType).toBe("image/png");
    await expect(store.put("../escape.png", PLAINTEXT, "image/png")).rejects.toThrow(/escapes/);
    await store.delete("runs/r2/step-1.png");
    expect(await readdir(path.join(dir, "runs/r2"))).toEqual([]);
  });

  it("refuses a key that is not 32 bytes", () => {
    expect(() => new FsObjectStore({ dir: "/tmp/x", encryptionKey: "abcd" })).toThrow(/32 bytes/);
  });
});
