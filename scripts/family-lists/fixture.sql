-- Family Lists' schema (github.com/CalNicklin/family-todo, drizzle/0000 + 0001, without Supabase's
-- row-level-security policies) and a small board, for the import test. Rows are inserted out of order
-- on purpose: Family Lists shows lists and items by position, then by when they were made.
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"list_id" uuid NOT NULL,
	"text" text NOT NULL,
	"checked" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"emoji" text DEFAULT '📝' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "items" ADD CONSTRAINT "items_list_id_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE cascade ON UPDATE no action;
CREATE UNIQUE INDEX "items_list_text_ci_uniq" ON "items" USING btree ("list_id",lower(btrim("text")));

INSERT INTO lists (id, name, emoji, position, created_at) VALUES
  ('22222222-2222-4222-8222-222222222222', 'To Do', '✅', 1, '2026-03-02T09:00:00Z'),
  ('11111111-1111-4111-8111-111111111111', 'To Buy', '🛒', 0, '2026-03-01T09:00:00Z'),
  ('44444444-4444-4444-8444-444444444444', 'Empty one', DEFAULT, 2, '2026-03-04T09:00:00Z'),
  ('33333333-3333-4333-8333-333333333333', 'Holiday', '🏖️', 1, '2026-03-01T10:00:00Z');

INSERT INTO items (list_id, text, checked, position, created_at) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Bread', true, 1, '2026-03-05T09:00:00Z'),
  ('11111111-1111-4111-8111-111111111111', 'Oat milk', false, 0, '2026-03-05T08:00:00Z'),
  ('11111111-1111-4111-8111-111111111111', 'Crème fraîche', false, 2, '2026-03-05T10:00:00Z'),
  ('11111111-1111-4111-8111-111111111111', 'Eggs', false, 2, '2026-03-05T09:30:00Z'),
  ('22222222-2222-4222-8222-222222222222', 'Book the MOT', false, 0, '2026-03-06T09:00:00Z'),
  ('22222222-2222-4222-8222-222222222222', 'Fix the gate', true, 1, '2026-03-06T09:00:00Z'),
  ('33333333-3333-4333-8333-333333333333', 'Passports', false, 0, '2026-03-07T09:00:00Z');
