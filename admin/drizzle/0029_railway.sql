CREATE TABLE "project_railway" (
	"project_id" integer PRIMARY KEY NOT NULL,
	"token_enc" text,
	"token_hint" text,
	"token_kind" text,
	"workspace_id" text,
	"railway_project_id" text,
	"railway_project_name" text,
	"environment_id" text,
	"environment_name" text,
	"collected_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "railway_issues" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"kind" text NOT NULL,
	"level" text NOT NULL,
	"title" text NOT NULL,
	"sample" text DEFAULT '' NOT NULL,
	"recent" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"services" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_deployment_id" text,
	"task_id" integer,
	"dismissed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "project_railway" ADD CONSTRAINT "project_railway_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "railway_issues" ADD CONSTRAINT "railway_issues_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "railway_issues_project_fingerprint_key" ON "railway_issues" USING btree ("project_id","fingerprint");--> statement-breakpoint
CREATE INDEX "railway_issues_project_last" ON "railway_issues" USING btree ("project_id","last_seen");