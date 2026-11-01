import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./server/domains/health/schema.ts",
  out: "./server/domains/health/migrations",
  dbCredentials: { url: `${process.env["DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5432"}/${process.env["DB_PREFIX"] ?? "practice"}_health` },
});
