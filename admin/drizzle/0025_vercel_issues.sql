CREATE TABLE "vercel_issues" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"kind" text NOT NULL,
	"level" text NOT NULL,
	"title" text NOT NULL,
	"sample" text DEFAULT '' NOT NULL,
	"recent" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_deployment_id" text,
	"task_id" integer,
	"dismissed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "vercel_issues" ADD CONSTRAINT "vercel_issues_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vercel_issues_project_fingerprint_key" ON "vercel_issues" USING btree ("project_id","fingerprint");--> statement-breakpoint
CREATE INDEX "vercel_issues_project_last" ON "vercel_issues" USING btree ("project_id","last_seen");