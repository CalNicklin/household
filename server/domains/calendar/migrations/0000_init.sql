CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"start" timestamp with time zone NOT NULL,
	"end" timestamp with time zone NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"attendees" text[] DEFAULT '{}' NOT NULL,
	"away" text[] DEFAULT '{}' NOT NULL,
	"work" boolean DEFAULT false NOT NULL,
	"solo_with_kids" text,
	"sync_id" text,
	CONSTRAINT "events_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "syncs" (
	"id" text PRIMARY KEY NOT NULL,
	"sync_token" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_dates" text[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_sync_id_syncs_id_fk" FOREIGN KEY ("sync_id") REFERENCES "public"."syncs"("id") ON DELETE no action ON UPDATE no action;