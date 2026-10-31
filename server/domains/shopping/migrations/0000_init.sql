CREATE TABLE "basket_adds" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" text PRIMARY KEY NOT NULL,
	"item" text NOT NULL,
	"person" text NOT NULL,
	"status" text NOT NULL,
	"chosen" jsonb,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"request_id" text NOT NULL,
	"log" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"screenshots" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "summaries" (
	"id" text PRIMARY KEY NOT NULL,
	"person" text NOT NULL,
	"delivery_date" text NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "basket_adds" ADD CONSTRAINT "basket_adds_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE cascade ON UPDATE no action;