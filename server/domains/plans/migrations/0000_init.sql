CREATE TABLE "hand_overs" (
	"id" text PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"title" text NOT NULL,
	"from_person" text NOT NULL,
	"to_person" text NOT NULL,
	"response_id" text,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" text PRIMARY KEY NOT NULL,
	"item_id" text NOT NULL,
	"date" date NOT NULL,
	"person" text,
	"plan_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" text PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"version" integer NOT NULL,
	"blocks" jsonb NOT NULL,
	"inputs" jsonb NOT NULL,
	"trigger" text NOT NULL,
	"job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "responses" (
	"id" text PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"action" text NOT NULL,
	"person" text NOT NULL,
	"channel" text NOT NULL,
	"date" date NOT NULL,
	"value" text,
	"plan_id" text,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hand_overs" ADD CONSTRAINT "hand_overs_response_id_responses_id_fk" FOREIGN KEY ("response_id") REFERENCES "public"."responses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "offers_item" ON "offers" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "offers_date" ON "offers" USING btree ("date");--> statement-breakpoint
CREATE UNIQUE INDEX "plans_date_version" ON "plans" USING btree ("date","version");