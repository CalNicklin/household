import { startSupermarket } from "./app.ts";

const { url } = await startSupermarket({ port: Number(process.env["PORT"] ?? 3002) });
process.stdout.write(`practice supermarket on ${url}\n`);
