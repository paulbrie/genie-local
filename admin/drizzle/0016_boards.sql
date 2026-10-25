CREATE TABLE "boards" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"doc" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
