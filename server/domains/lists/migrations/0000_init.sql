CREATE TABLE "items" (
	"id" text PRIMARY KEY NOT NULL,
	"list_id" text NOT NULL,
	"text" text NOT NULL,
	"checked" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"source" text NOT NULL,
	"source_message" text,
	"source_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lists" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"emoji" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_list_id_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "items_list_text_ci_uniq" ON "items" USING btree ("list_id",lower(btrim("text")));--> statement-breakpoint
CREATE INDEX "items_created_by_idx" ON "items" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "items_list_source_key_uniq" ON "items" USING btree ("list_id","source_key");