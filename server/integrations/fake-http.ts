import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type Recorded = { method: string; path: string; headers: IncomingMessage["headers"]; body: Buffer };
export type Handler = (req: Recorded, res: ServerResponse) => void;

/** A local HTTP server that records every request; integration tests never touch the network. */
export async function fakeServer(handler: Handler): Promise<{ url: string; requests: Recorded[]; close: () => Promise<void> }> {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const recorded = { method: req.method ?? "GET", path: req.url ?? "/", headers: req.headers, body: Buffer.concat(chunks) };
      requests.push(recorded);
      handler(recorded, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake server has no TCP port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
