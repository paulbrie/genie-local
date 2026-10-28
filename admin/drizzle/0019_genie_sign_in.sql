CREATE TABLE "admin_sso_jtis" (
	"jti" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "admin_users_email_lower" CHECK ("admin_users"."email" = lower("admin_users"."email"))
);
--> statement-breakpoint
ALTER TABLE "admin_logins" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "admin_logins" ADD COLUMN "via" text;--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD COLUMN "email" text;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users" USING btree ("email");