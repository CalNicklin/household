import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./server/domains/wellbeing/schema.ts",
  out: "./server/domains/wellbeing/migrations",
  dbCredentials: { url: `${process.env["DATABASE_URL"] ?? "postgres://postgres@localhost:5432"}/${process.env["DB_PREFIX"] ?? "practice"}_wellbeing` },
});
