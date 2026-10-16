-- Push every change to a project's tasks, comments and files to the admin as
-- NOTIFY task_changes '<json>', so open boards refresh live (the admin LISTENs
-- and streams them per project over SSE), whoever made the change: the UI,
-- the local-genie MCP from any Claude session, or plain SQL.
CREATE OR REPLACE FUNCTION notify_task_change() RETURNS trigger AS $$
DECLARE
  rec record := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  pid integer;
  tid integer;
BEGIN
  IF TG_TABLE_NAME = 'tasks' THEN
    pid := rec.project_id;
    tid := rec.id;
  ELSE
    tid := rec.task_id;
    -- NULL when the parent task is being deleted (its own row notifies).
    SELECT project_id INTO pid FROM tasks WHERE id = tid;
  END IF;
  IF pid IS NOT NULL THEN
    PERFORM pg_notify('task_changes', json_build_object(
      'projectId', pid, 'taskId', tid, 'table', TG_TABLE_NAME, 'op', TG_OP
    )::text);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER tasks_notify AFTER INSERT OR UPDATE OR DELETE ON "tasks"
  FOR EACH ROW EXECUTE FUNCTION notify_task_change();--> statement-breakpoint
CREATE TRIGGER task_comments_notify AFTER INSERT OR UPDATE OR DELETE ON "task_comments"
  FOR EACH ROW EXECUTE FUNCTION notify_task_change();--> statement-breakpoint
CREATE TRIGGER task_attachments_notify AFTER INSERT OR UPDATE OR DELETE ON "task_attachments"
  FOR EACH ROW EXECUTE FUNCTION notify_task_change();
