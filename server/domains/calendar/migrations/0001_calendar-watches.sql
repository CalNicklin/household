CREATE TABLE "watches" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"resource_id" text NOT NULL,
	"address" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	CONSTRAINT "watches_channel_id_unique" UNIQUE("channel_id")
);
