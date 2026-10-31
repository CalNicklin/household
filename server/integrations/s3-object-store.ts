import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ObjectStore } from "../ports.ts";

const IV_BYTES = 12;
const TAG_BYTES = 16;

function parseKey(hex: string): Buffer {
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) throw new Error("storage key must be 32 bytes of hex (AES-256)");
  return key;
}

/** PLT-7: AES-256-GCM before anything leaves the process. Layout: [12-byte IV][ciphertext][16-byte tag]. */
export function encrypt(key: Buffer, plaintext: Uint8Array): Uint8Array {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return new Uint8Array(Buffer.concat([iv, body, cipher.getAuthTag()]));
}

export function decrypt(key: Buffer, sealed: Uint8Array): Uint8Array {
  const buf = Buffer.from(sealed);
  if (buf.length < IV_BYTES + TAG_BYTES) throw new Error("stored object is too short to be encrypted");
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(buf.subarray(IV_BYTES, buf.length - TAG_BYTES)), decipher.final()]));
}

export type S3ObjectStoreOptions = {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** 32-byte hex key for client-side encryption. */
  encryptionKey: string;
  region?: string;
  /** Also ask the server to encrypt at rest (SSE-S3); MinIO needs KMS configured for this. */
  sse?: boolean;
};

/**
 * Objects in S3-compatible storage we run (MinIO), referenced from Postgres by key (PLT-7).
 * The server only ever sees ciphertext.
 */
export class S3ObjectStore implements ObjectStore {
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #key: Buffer;
  readonly #sse: boolean;
  constructor(options: S3ObjectStoreOptions) {
    this.#client = new S3Client({
      endpoint: options.endpoint,
      region: options.region ?? "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
    this.#bucket = options.bucket;
    this.#key = parseKey(options.encryptionKey);
    this.#sse = options.sse ?? false;
  }

  /** First start on a fresh server: make the bucket if it is not there yet. */
  async ensureBucket(): Promise<void> {
    try {
      await this.#client.send(new HeadBucketCommand({ Bucket: this.#bucket }));
    } catch {
      await this.#client.send(new CreateBucketCommand({ Bucket: this.#bucket }));
    }
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: encrypt(this.#key, body),
        ContentType: "application/octet-stream",
        Metadata: { "plain-content-type": contentType },
        ...(this.#sse ? { ServerSideEncryption: "AES256" } : {}),
      }),
    );
  }

  async get(key: string): Promise<{ body: Uint8Array; contentType: string } | null> {
    try {
      const out = await this.#client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
      if (out.Body === undefined) return null;
      const sealed = await out.Body.transformToByteArray();
      return { body: decrypt(this.#key, sealed), contentType: out.Metadata?.["plain-content-type"] ?? "application/octet-stream" };
    } catch (error) {
      if (error instanceof NoSuchKey || (error instanceof Error && error.name === "NoSuchKey")) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.#client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }
}

/** The same encryption on local disk, for a single box with no object store yet. */
export class FsObjectStore implements ObjectStore {
  readonly #dir: string;
  readonly #key: Buffer;
  constructor(options: { dir: string; encryptionKey: string }) {
    this.#dir = path.resolve(options.dir);
    this.#key = parseKey(options.encryptionKey);
  }

  #path(key: string): string {
    const file = path.resolve(this.#dir, key);
    if (!file.startsWith(`${this.#dir}${path.sep}`)) throw new Error(`object key escapes the store: ${key}`);
    return file;
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    const file = this.#path(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, encrypt(this.#key, body));
    await writeFile(`${file}.type`, contentType);
  }

  async get(key: string): Promise<{ body: Uint8Array; contentType: string } | null> {
    const file = this.#path(key);
    try {
      const sealed = await readFile(file);
      const contentType = await readFile(`${file}.type`, "utf8").catch(() => "application/octet-stream");
      return { body: decrypt(this.#key, sealed), contentType };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const file = this.#path(key);
    await rm(file, { force: true });
    await rm(`${file}.type`, { force: true });
  }
}
