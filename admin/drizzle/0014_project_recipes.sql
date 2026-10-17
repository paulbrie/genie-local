CREATE TABLE "project_recipes" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text,
	"description" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "project_recipes_name_key" ON "project_recipes" USING btree ("name");