CREATE TABLE "project_production" (
	"project_id" integer PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_production" ADD CONSTRAINT "project_production_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;