CREATE TABLE "identities" (
	"id" text PRIMARY KEY NOT NULL,
	"person_id" text NOT NULL,
	"channel" text NOT NULL,
	"address" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "logins" (
	"person_id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	CONSTRAINT "logins_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "modes" (
	"id" text PRIMARY KEY NOT NULL,
	"mode" text NOT NULL,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nursery_events" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"date" date NOT NULL,
	"title" text NOT NULL,
	"covered_by" text
);
--> statement-breakpoint
CREATE TABLE "nursery_terms" (
	"id" text PRIMARY KEY NOT NULL,
	"start" date NOT NULL,
	"end" date NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"nursery_days" text[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person_settings" (
	"person_id" text PRIMARY KEY NOT NULL,
	"daily_message_budget" integer NOT NULL,
	"quiet_start_hour" integer NOT NULL,
	"quiet_end_hour" integer NOT NULL,
	"routing" jsonb NOT NULL,
	"wellbeing_enabled" boolean DEFAULT true NOT NULL,
	"health_in_score" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"spec" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"household" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"retain_messages" boolean DEFAULT true NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"health_owner" text
);
--> statement-breakpoint
CREATE TABLE "sitter_bookings" (
	"id" text PRIMARY KEY NOT NULL,
	"sitter_id" text NOT NULL,
	"date" date NOT NULL,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sitter_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"sitter_id" text NOT NULL,
	"channel" text NOT NULL,
	"address" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sitters" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"known_free_days" text[] DEFAULT '{}' NOT NULL,
	CONSTRAINT "sitters_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "tag_hints" (
	"id" text PRIMARY KEY NOT NULL,
	"word" text NOT NULL,
	"tag" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wellbeing_ideas" (
	"id" text PRIMARY KEY NOT NULL,
	"text" text NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logins" ADD CONSTRAINT "logins_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "modes" ADD CONSTRAINT "modes_set_by_people_id_fk" FOREIGN KEY ("set_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nursery_events" ADD CONSTRAINT "nursery_events_covered_by_people_id_fk" FOREIGN KEY ("covered_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_settings" ADD CONSTRAINT "person_settings_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitter_bookings" ADD CONSTRAINT "sitter_bookings_sitter_id_sitters_id_fk" FOREIGN KEY ("sitter_id") REFERENCES "public"."sitters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitter_bookings" ADD CONSTRAINT "sitter_bookings_recorded_by_people_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitter_identities" ADD CONSTRAINT "sitter_identities_sitter_id_sitters_id_fk" FOREIGN KEY ("sitter_id") REFERENCES "public"."sitters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wellbeing_ideas" ADD CONSTRAINT "wellbeing_ideas_created_by_people_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "identities_channel_address" ON "identities" USING btree ("channel","address");