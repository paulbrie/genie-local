CREATE TABLE "board_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"board_id" integer NOT NULL,
	"doc" jsonb NOT NULL,
	"label" text,
	"authors" text,
	"changes" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "board_snapshots" ADD CONSTRAINT "board_snapshots_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "board_snapshots_board_time" ON "board_snapshots" USING btree ("board_id","created_at");