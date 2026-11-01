CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"ref" text NOT NULL,
	"person" text NOT NULL,
	"date" date NOT NULL,
	"day_part" text NOT NULL,
	"weekday" text NOT NULL,
	"hour" integer NOT NULL,
	"weather" text NOT NULL,
	"day_mode" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forgotten" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"value" text NOT NULL,
	"sentence" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" text PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"subject" text NOT NULL,
	"text" text NOT NULL,
	"options" jsonb NOT NULL,
	"asked_on" date NOT NULL,
	"answer" text,
	"rhythm_id" text
);
--> statement-breakpoint
CREATE TABLE "rhythms" (
	"id" text PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"every_days" integer NOT NULL,
	"usual_weekday" text,
	"source" text NOT NULL,
	CONSTRAINT "rhythms_subject_unique" UNIQUE("subject")
);
--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_rhythm_id_rhythms_id_fk" FOREIGN KEY ("rhythm_id") REFERENCES "public"."rhythms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "preferences_kind_subject" ON "preferences" USING btree ("kind","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "questions_topic_subject" ON "questions" USING btree ("topic","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "questions_asked_on" ON "questions" USING btree ("asked_on");