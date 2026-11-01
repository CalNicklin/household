ALTER TABLE "events" ADD COLUMN "calendar_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "owner" text DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "uid" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "busy" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "syncs" ADD COLUMN "sync_tokens" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "watches" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "syncs" DROP COLUMN "sync_token";--> statement-breakpoint
-- CH-6: before this, the newest channel was the one in use and older ones had been closed in Google;
-- record that, so only the newest counts as open.
UPDATE "watches" SET "closed_at" = now() WHERE "id" NOT IN (SELECT "id" FROM "watches" ORDER BY "opened_at" DESC LIMIT 1);
