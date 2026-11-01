CREATE TABLE "entries" (
	"id" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"date" date NOT NULL,
	"heavy" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
