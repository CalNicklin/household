CREATE TABLE "items" (
	"id" text PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"confirmed_tags" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"not_now_count" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_via" text NOT NULL,
	"source_message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "not_nows" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"person" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "not_nows" ADD CONSTRAINT "not_nows_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;