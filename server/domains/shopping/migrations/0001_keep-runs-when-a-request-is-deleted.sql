ALTER TABLE "runs" DROP CONSTRAINT "runs_request_id_requests_id_fk";
--> statement-breakpoint
ALTER TABLE "runs" ALTER COLUMN "request_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "person" text;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "runs" SET "person" = "requests"."person" FROM "requests" WHERE "runs"."request_id" = "requests"."id";
