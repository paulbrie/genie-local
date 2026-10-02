CREATE TABLE "diagrams" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"format" text DEFAULT 'mermaid' NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
