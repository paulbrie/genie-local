CREATE TABLE "admin_logins" (
	"id" serial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"event" text DEFAULT 'login' NOT NULL,
	"ok" boolean NOT NULL,
	"reason" text,
	"username" text,
	"ip" text,
	"user_agent" text,
	"session_id" text
);
--> statement-breakpoint
CREATE TABLE "admin_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text,
	"via" text DEFAULT 'login' NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "admin_logins_at_idx" ON "admin_logins" ("at" DESC);--> statement-breakpoint
CREATE INDEX "admin_sessions_last_seen_idx" ON "admin_sessions" ("last_seen_at" DESC);
