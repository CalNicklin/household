CREATE TABLE "mutes" (
	"person" text PRIMARY KEY NOT NULL,
	"until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nudges" (
	"id" text PRIMARY KEY NOT NULL,
	"about" text NOT NULL,
	"to_person" text NOT NULL,
	"date" date NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scores" (
	"id" text PRIMARY KEY NOT NULL,
	"person" text NOT NULL,
	"date" date NOT NULL,
	"score" double precision NOT NULL,
	"heavy" boolean NOT NULL,
	"free_hours" double precision NOT NULL,
	"factors" jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "scores_person_date" ON "scores" USING btree ("person","date");