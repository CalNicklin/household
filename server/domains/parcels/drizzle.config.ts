import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./server/domains/parcels/schema.ts",
  out: "./server/domains/parcels/migrations",
  dbCredentials: { url: `${process.env["DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5432"}/${process.env["DB_PREFIX"] ?? "practice"}_parcels` },
});
