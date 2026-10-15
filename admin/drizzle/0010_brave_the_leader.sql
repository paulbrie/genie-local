CREATE TABLE "task_attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size" bigint NOT NULL,
	"path" text NOT NULL,
	"author" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "status" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "commit_sha" text;--> statement-breakpoint
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
UPDATE "tasks" SET "status" = 'done' WHERE "done";--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_status_check" CHECK ("status" IN ('open', 'in_progress', 'done'));--> statement-breakpoint
-- `status` is the source of truth; keep the legacy `done` flag in step so older
-- writers (local-genie MCP sessions started before this change) keep working:
-- a write that only flips `done` moves `status`, and any status write sets `done`.
CREATE OR REPLACE FUNCTION tasks_sync_status() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.done AND NEW.status <> 'done' THEN NEW.status := 'done'; END IF;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    NULL;
  ELSIF NEW.done IS DISTINCT FROM OLD.done THEN
    NEW.status := CASE WHEN NEW.done THEN 'done' ELSE 'open' END;
  END IF;
  NEW.done := NEW.status = 'done';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER tasks_sync_status BEFORE INSERT OR UPDATE ON "tasks"
  FOR EACH ROW EXECUTE FUNCTION tasks_sync_status();
