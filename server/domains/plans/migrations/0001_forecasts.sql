CREATE TABLE "forecasts" (
	"date" date PRIMARY KEY NOT NULL,
	"hours" jsonb NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
