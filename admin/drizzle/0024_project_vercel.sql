CREATE TABLE "project_vercel" (
	"project_id" integer PRIMARY KEY NOT NULL,
	"token_enc" text NOT NULL,
	"token_hint" text NOT NULL,
	"team_id" text,
	"vercel_project_id" text,
	"vercel_project_name" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_vercel" ADD CONSTRAINT "project_vercel_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;