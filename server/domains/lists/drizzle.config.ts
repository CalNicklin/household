import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./server/domains/lists/schema.ts",
  out: "./server/domains/lists/migrations",
  dbCredentials: { url: `${process.env["DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5432"}/${process.env["DB_PREFIX"] ?? "practice"}_lists` },
});
