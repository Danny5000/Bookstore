CREATE TYPE "public"."revision_state" AS ENUM('uploaded', 'processing', 'ready_for_review', 'failed', 'active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."title_format" AS ENUM('prose', 'comic');--> statement-breakpoint
CREATE TYPE "public"."title_visibility" AS ENUM('private', 'public', 'archived');--> statement-breakpoint
CREATE TYPE "public"."audit_actor_type" AS ENUM('anonymous', 'guest', 'user', 'system');--> statement-breakpoint
CREATE TYPE "public"."audit_outcome" AS ENUM('succeeded', 'failed', 'denied');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'delivered', 'failed');--> statement-breakpoint
CREATE TABLE "title_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title_id" uuid NOT NULL,
	"parent_revision_id" uuid,
	"state" "revision_state" DEFAULT 'uploaded' NOT NULL,
	"created_by_actor_id" text NOT NULL,
	"change_summary" text NOT NULL,
	"original_storage_key" text,
	"original_checksum_sha256" varchar(64),
	"original_mime_type" text,
	"original_byte_size" bigint,
	"original_filename" text,
	"failure_code" text,
	"failure_details" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processing_started_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	CONSTRAINT "title_revisions_title_id_id_unique" UNIQUE("title_id","id"),
	CONSTRAINT "title_revisions_byte_size_positive" CHECK ("title_revisions"."original_byte_size" is null or "title_revisions"."original_byte_size" > 0),
	CONSTRAINT "title_revisions_checksum_shape" CHECK ("title_revisions"."original_checksum_sha256" is null or "title_revisions"."original_checksum_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "titles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"subtitle" text,
	"description" text NOT NULL,
	"creator_name" text NOT NULL,
	"format" "title_format" NOT NULL,
	"price_minor" integer NOT NULL,
	"currency" varchar(3) NOT NULL,
	"visibility" "title_visibility" DEFAULT 'private' NOT NULL,
	"active_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "titles_price_minor_nonnegative" CHECK ("titles"."price_minor" >= 0),
	CONSTRAINT "titles_currency_iso_shape" CHECK ("titles"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "titles_slug_shape" CHECK ("titles"."slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" "audit_actor_type" NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"outcome" "audit_outcome" NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"correlation_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	CONSTRAINT "audit_events_actor_id_required" CHECK ("audit_events"."actor_type" = 'anonymous' or "audit_events"."actor_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"deduplication_key" text,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_attempts_nonnegative" CHECK ("jobs"."attempts" >= 0),
	CONSTRAINT "jobs_max_attempts_positive" CHECK ("jobs"."max_attempts" > 0),
	CONSTRAINT "jobs_running_has_lease" CHECK (("jobs"."status" = 'running') = ("jobs"."locked_at" is not null and "jobs"."locked_by" is not null)),
	CONSTRAINT "jobs_terminal_has_completion" CHECK (("jobs"."status" in ('succeeded', 'failed')) = ("jobs"."completed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "outbox_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"dispatch_job_id" uuid NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_delivered_has_timestamp" CHECK (("outbox_messages"."status" = 'delivered') = ("outbox_messages"."delivered_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "title_revisions" ADD CONSTRAINT "title_revisions_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "title_revisions" ADD CONSTRAINT "title_revisions_parent_same_title_fk" FOREIGN KEY ("title_id","parent_revision_id") REFERENCES "public"."title_revisions"("title_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "titles" ADD CONSTRAINT "titles_active_revision_id_title_revisions_id_fk" FOREIGN KEY ("active_revision_id") REFERENCES "public"."title_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_dispatch_job_id_jobs_id_fk" FOREIGN KEY ("dispatch_job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "title_revisions_title_created_idx" ON "title_revisions" USING btree ("title_id","created_at");--> statement-breakpoint
CREATE INDEX "title_revisions_state_created_idx" ON "title_revisions" USING btree ("state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "title_revisions_one_active_per_title" ON "title_revisions" USING btree ("title_id") WHERE "title_revisions"."state" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "titles_slug_unique" ON "titles" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "titles_visibility_created_idx" ON "titles" USING btree ("visibility","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_occurred_idx" ON "audit_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_resource_idx" ON "audit_events" USING btree ("resource_type","resource_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_type","actor_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_correlation_idx" ON "audit_events" USING btree ("correlation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_deduplication_key_unique" ON "jobs" USING btree ("deduplication_key");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("status","run_at","locked_at","created_at");--> statement-breakpoint
CREATE INDEX "jobs_failed_updated_idx" ON "jobs" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_messages_dispatch_job_unique" ON "outbox_messages" USING btree ("dispatch_job_id");--> statement-breakpoint
CREATE INDEX "outbox_messages_status_created_idx" ON "outbox_messages" USING btree ("status","created_at");