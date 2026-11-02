import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./server/domains/backlog/schema.ts",
  out: "./server/domains/backlog/migrations",
  dbCredentials: { url: `${process.env["DATABASE_URL"] ?? "postgres://postgres@localhost:5432"}/${process.env["DB_PREFIX"] ?? "practice"}_backlog` },
});
