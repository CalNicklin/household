-- HOU-156: a mode can start later than it was set. Modes already recorded started when they were set.
ALTER TABLE "modes" ADD COLUMN "starts_at" timestamp with time zone;--> statement-breakpoint
UPDATE "modes" SET "starts_at" = "set_at";--> statement-breakpoint
ALTER TABLE "modes" ALTER COLUMN "starts_at" SET NOT NULL;
