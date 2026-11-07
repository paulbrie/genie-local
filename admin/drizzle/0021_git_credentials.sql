CREATE TABLE "git_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"app" text DEFAULT '' NOT NULL,
	"remote_url" text NOT NULL,
	"token_enc" text,
	"token_hint" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "git_credentials" ADD CONSTRAINT "git_credentials_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "git_credentials_project_app_key" ON "git_credentials" USING btree ("project_id","app");