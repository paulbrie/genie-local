ALTER TABLE "apps" ADD COLUMN "run_isolation" text DEFAULT 'process' NOT NULL;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "run_image" text;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "run_mem_max_mb" integer;--> statement-breakpoint
ALTER TABLE "apps" ADD COLUMN "run_cpus" real;