ALTER TABLE "connections" ADD COLUMN "auto_key" text;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_auto_key_unique" UNIQUE("auto_key");