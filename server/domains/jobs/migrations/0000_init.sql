CREATE TABLE "dropped" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"address" text NOT NULL,
	"reason" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"channel" text NOT NULL,
	"person" text,
	"intent" text DEFAULT '' NOT NULL,
	"status" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_micros" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"dedupe_key" text NOT NULL,
	"channel" text NOT NULL,
	"person" text,
	"text" text NOT NULL,
	"attachments" jsonb NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"redacted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"person" text NOT NULL,
	"message" text NOT NULL,
	"urgency" text NOT NULL,
	"channel" text NOT NULL,
	"actions" jsonb NOT NULL,
	"status" text NOT NULL,
	"counts_towards_budget" boolean NOT NULL,
	"external_id" text,
	"job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "replies" (
	"id" text PRIMARY KEY NOT NULL,
	"person" text,
	"channel" text NOT NULL,
	"text" text NOT NULL,
	"in_reply_to" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timer_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"timer" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"fired_at" timestamp with time zone,
	"missed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_in_reply_to_messages_id_fk" FOREIGN KEY ("in_reply_to") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_dedupe" ON "messages" USING btree ("dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_key_person" ON "notifications" USING btree ("key","person");--> statement-breakpoint
CREATE UNIQUE INDEX "timer_runs_timer_scheduled" ON "timer_runs" USING btree ("timer","scheduled_for");