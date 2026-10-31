import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./server/domains/shopping/schema.ts",
  out: "./server/domains/shopping/migrations",
  dbCredentials: { url: `${process.env["DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:5432"}/${process.env["DB_PREFIX"] ?? "practice"}_shopping` },
});
