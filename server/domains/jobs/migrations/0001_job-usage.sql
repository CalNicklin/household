CREATE TABLE "job_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"source" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_micros" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_usage" ADD CONSTRAINT "job_usage_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_usage_job_source" ON "job_usage" USING btree ("job_id","source");