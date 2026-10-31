CREATE TABLE "arrivals" (
	"id" text PRIMARY KEY NOT NULL,
	"shop" text NOT NULL,
	"expected_date" date NOT NULL,
	"time_window" text,
	"needs_someone_in" boolean DEFAULT false NOT NULL,
	"person" text,
	"source_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "arrivals_source" ON "arrivals" USING btree ("source_key");