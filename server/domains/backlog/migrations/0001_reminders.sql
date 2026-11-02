CREATE TABLE "reminders" (
	"id" text PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"for" text[] NOT NULL,
	"date" date NOT NULL,
	"time" text,
	"asked_by" text NOT NULL,
	"created_via" text NOT NULL,
	"source_message" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"item_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone,
	CONSTRAINT "reminders_source_message_unique" UNIQUE("source_message")
);
--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;