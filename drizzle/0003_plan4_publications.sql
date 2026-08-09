CREATE TYPE "public"."prose_block_kind" AS ENUM('heading', 'paragraph', 'quote', 'list', 'image', 'break');--> statement-breakpoint
CREATE TYPE "public"."reading_direction" AS ENUM('ltr', 'rtl');--> statement-breakpoint
CREATE TYPE "public"."revision_presentation_state" AS ENUM('draft', 'published', 'superseded');--> statement-breakpoint
CREATE TABLE "comic_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"source_path" text NOT NULL,
	"storage_key" text NOT NULL,
	"media_type" text NOT NULL,
	"checksum_sha256" varchar(64) NOT NULL,
	"byte_size" bigint NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comic_pages_revision_id_id_unique" UNIQUE("revision_id","id"),
	CONSTRAINT "comic_pages_revision_ordinal_unique" UNIQUE("revision_id","ordinal"),
	CONSTRAINT "comic_pages_ordinal_positive" CHECK ("comic_pages"."ordinal" > 0),
	CONSTRAINT "comic_pages_byte_size_positive" CHECK ("comic_pages"."byte_size" > 0),
	CONSTRAINT "comic_pages_dimensions_positive" CHECK ("comic_pages"."width" > 0 and "comic_pages"."height" > 0),
	CONSTRAINT "comic_pages_checksum_shape" CHECK ("comic_pages"."checksum_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "comic_panel_regions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"presentation_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL,
	"width" double precision NOT NULL,
	"height" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comic_panel_regions_presentation_page_ordinal_unique" UNIQUE("revision_id","presentation_id","page_id","ordinal"),
	CONSTRAINT "comic_panel_regions_ordinal_nonnegative" CHECK ("comic_panel_regions"."ordinal" >= 0),
	CONSTRAINT "comic_panel_regions_bounds" CHECK ("comic_panel_regions"."x" >= 0 and "comic_panel_regions"."y" >= 0 and
        "comic_panel_regions"."width" > 0 and "comic_panel_regions"."height" > 0 and
        "comic_panel_regions"."x" + "comic_panel_regions"."width" <= 1 and "comic_panel_regions"."y" + "comic_panel_regions"."height" <= 1)
);
--> statement-breakpoint
CREATE TABLE "prose_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"kind" "prose_block_kind" NOT NULL,
	"content" jsonb NOT NULL,
	"image_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prose_blocks_revision_id_id_unique" UNIQUE("revision_id","id"),
	CONSTRAINT "prose_blocks_section_ordinal_unique" UNIQUE("revision_id","section_id","ordinal"),
	CONSTRAINT "prose_blocks_ordinal_nonnegative" CHECK ("prose_blocks"."ordinal" >= 0),
	CONSTRAINT "prose_blocks_image_kind_shape" CHECK (("prose_blocks"."kind" = 'image') = ("prose_blocks"."image_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "prose_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"media_type" text NOT NULL,
	"checksum_sha256" varchar(64) NOT NULL,
	"byte_size" bigint NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"alt_text" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prose_images_revision_id_id_unique" UNIQUE("revision_id","id"),
	CONSTRAINT "prose_images_byte_size_positive" CHECK ("prose_images"."byte_size" > 0),
	CONSTRAINT "prose_images_dimensions_positive" CHECK ("prose_images"."width" > 0 and "prose_images"."height" > 0),
	CONSTRAINT "prose_images_checksum_shape" CHECK ("prose_images"."checksum_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "prose_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"label" text,
	"source_reference" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prose_sections_revision_id_id_unique" UNIQUE("revision_id","id"),
	CONSTRAINT "prose_sections_revision_ordinal_unique" UNIQUE("revision_id","ordinal"),
	CONSTRAINT "prose_sections_ordinal_nonnegative" CHECK ("prose_sections"."ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "revision_cover_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"source_description" text NOT NULL,
	"media_type" text NOT NULL,
	"checksum_sha256" varchar(64) NOT NULL,
	"byte_size" bigint NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "revision_cover_suggestions_byte_size_positive" CHECK ("revision_cover_suggestions"."byte_size" > 0),
	CONSTRAINT "revision_cover_suggestions_dimensions_positive" CHECK ("revision_cover_suggestions"."width" > 0 and "revision_cover_suggestions"."height" > 0),
	CONSTRAINT "revision_cover_suggestions_checksum_shape" CHECK ("revision_cover_suggestions"."checksum_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "revision_ingestion_warnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"code" text NOT NULL,
	"safe_message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "revision_ingestion_warnings_revision_ordinal_unique" UNIQUE("revision_id","ordinal"),
	CONSTRAINT "revision_ingestion_warnings_ordinal_nonnegative" CHECK ("revision_ingestion_warnings"."ordinal" >= 0)
);
--> statement-breakpoint
CREATE TABLE "revision_presentations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"state" "revision_presentation_state" DEFAULT 'draft' NOT NULL,
	"reading_direction" "reading_direction" DEFAULT 'ltr' NOT NULL,
	"guided_view_enabled" boolean DEFAULT false NOT NULL,
	"preview_prose_section_id" uuid,
	"preview_prose_block_id" uuid,
	"preview_comic_page_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "revision_presentations_revision_id_id_unique" UNIQUE("revision_id","id"),
	CONSTRAINT "revision_presentations_preview_shape" CHECK ((
        "revision_presentations"."state" = 'draft' and
        "revision_presentations"."preview_prose_section_id" is null and
        "revision_presentations"."preview_prose_block_id" is null and
        "revision_presentations"."preview_comic_page_id" is null
      ) or (
        "revision_presentations"."preview_prose_section_id" is not null and
        "revision_presentations"."preview_prose_block_id" is not null and
        "revision_presentations"."preview_comic_page_id" is null
      ) or (
        "revision_presentations"."preview_prose_section_id" is null and
        "revision_presentations"."preview_prose_block_id" is null and
        "revision_presentations"."preview_comic_page_id" is not null
      ))
);
--> statement-breakpoint
ALTER TABLE "titles" DROP CONSTRAINT "titles_active_revision_id_title_revisions_id_fk";
--> statement-breakpoint
ALTER TABLE "title_revisions" ADD COLUMN "staging_storage_key" text;--> statement-breakpoint
ALTER TABLE "title_revisions" ADD COLUMN "staging_checksum_sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "title_revisions" ADD COLUMN "staging_byte_size" bigint;--> statement-breakpoint
ALTER TABLE "title_revisions" ADD COLUMN "upload_filename" text;--> statement-breakpoint
ALTER TABLE "title_revisions" ADD COLUMN "upload_mime_type" text;--> statement-breakpoint
ALTER TABLE "title_revisions" ADD COLUMN "ingestion_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "title_revisions" ADD COLUMN "derivation_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "cover_storage_key" text;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "cover_media_type" text;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "cover_checksum_sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "cover_byte_size" bigint;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "cover_width" integer;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "cover_height" integer;--> statement-breakpoint
ALTER TABLE "titles" ADD COLUMN "cover_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "request_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "comic_pages" ADD CONSTRAINT "comic_pages_revision_id_title_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."title_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comic_panel_regions" ADD CONSTRAINT "comic_panel_regions_revision_id_title_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."title_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comic_panel_regions" ADD CONSTRAINT "comic_panel_regions_presentation_same_revision_fk" FOREIGN KEY ("revision_id","presentation_id") REFERENCES "public"."revision_presentations"("revision_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comic_panel_regions" ADD CONSTRAINT "comic_panel_regions_page_same_revision_fk" FOREIGN KEY ("revision_id","page_id") REFERENCES "public"."comic_pages"("revision_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prose_blocks" ADD CONSTRAINT "prose_blocks_revision_id_title_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."title_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prose_blocks" ADD CONSTRAINT "prose_blocks_section_same_revision_fk" FOREIGN KEY ("revision_id","section_id") REFERENCES "public"."prose_sections"("revision_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prose_blocks" ADD CONSTRAINT "prose_blocks_image_same_revision_fk" FOREIGN KEY ("revision_id","image_id") REFERENCES "public"."prose_images"("revision_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prose_images" ADD CONSTRAINT "prose_images_revision_id_title_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."title_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prose_sections" ADD CONSTRAINT "prose_sections_revision_id_title_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."title_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_cover_suggestions" ADD CONSTRAINT "revision_cover_suggestions_revision_id_title_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."title_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_ingestion_warnings" ADD CONSTRAINT "revision_ingestion_warnings_revision_id_title_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."title_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_presentations" ADD CONSTRAINT "revision_presentations_revision_id_title_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."title_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_presentations" ADD CONSTRAINT "revision_presentations_section_same_revision_fk" FOREIGN KEY ("revision_id","preview_prose_section_id") REFERENCES "public"."prose_sections"("revision_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_presentations" ADD CONSTRAINT "revision_presentations_block_same_revision_fk" FOREIGN KEY ("revision_id","preview_prose_block_id") REFERENCES "public"."prose_blocks"("revision_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_presentations" ADD CONSTRAINT "revision_presentations_page_same_revision_fk" FOREIGN KEY ("revision_id","preview_comic_page_id") REFERENCES "public"."comic_pages"("revision_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "comic_pages_storage_key_unique" ON "comic_pages" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "comic_pages_revision_idx" ON "comic_pages" USING btree ("revision_id","ordinal");--> statement-breakpoint
CREATE INDEX "comic_panel_regions_presentation_page_idx" ON "comic_panel_regions" USING btree ("presentation_id","page_id","ordinal");--> statement-breakpoint
CREATE INDEX "prose_blocks_revision_section_idx" ON "prose_blocks" USING btree ("revision_id","section_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "prose_images_storage_key_unique" ON "prose_images" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "prose_images_revision_idx" ON "prose_images" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "prose_sections_revision_idx" ON "prose_sections" USING btree ("revision_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "revision_cover_suggestions_revision_unique" ON "revision_cover_suggestions" USING btree ("revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "revision_cover_suggestions_storage_key_unique" ON "revision_cover_suggestions" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "revision_ingestion_warnings_revision_idx" ON "revision_ingestion_warnings" USING btree ("revision_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "revision_presentations_one_draft_per_revision" ON "revision_presentations" USING btree ("revision_id") WHERE "revision_presentations"."state" = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "revision_presentations_one_published_per_revision" ON "revision_presentations" USING btree ("revision_id") WHERE "revision_presentations"."state" = 'published';--> statement-breakpoint
CREATE INDEX "revision_presentations_revision_state_idx" ON "revision_presentations" USING btree ("revision_id","state");--> statement-breakpoint
ALTER TABLE "titles" ADD CONSTRAINT "titles_active_revision_same_title_fk" FOREIGN KEY ("id","active_revision_id") REFERENCES "public"."title_revisions"("title_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_action_occurred_idx" ON "audit_events" USING btree ("action","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_outcome_occurred_idx" ON "audit_events" USING btree ("outcome","occurred_at");--> statement-breakpoint
ALTER TABLE "title_revisions" ADD CONSTRAINT "title_revisions_staging_byte_size_positive" CHECK ("title_revisions"."staging_byte_size" is null or "title_revisions"."staging_byte_size" > 0);--> statement-breakpoint
ALTER TABLE "title_revisions" ADD CONSTRAINT "title_revisions_staging_checksum_shape" CHECK ("title_revisions"."staging_checksum_sha256" is null or "title_revisions"."staging_checksum_sha256" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "title_revisions" ADD CONSTRAINT "title_revisions_ingestion_generation_nonnegative" CHECK ("title_revisions"."ingestion_generation" >= 0);--> statement-breakpoint
ALTER TABLE "title_revisions" ADD CONSTRAINT "title_revisions_derivation_version_positive" CHECK ("title_revisions"."derivation_version" > 0);--> statement-breakpoint
ALTER TABLE "titles" ADD CONSTRAINT "titles_cover_complete" CHECK ((
        "titles"."cover_storage_key" is null and
        "titles"."cover_media_type" is null and
        "titles"."cover_checksum_sha256" is null and
        "titles"."cover_byte_size" is null and
        "titles"."cover_width" is null and
        "titles"."cover_height" is null and
        "titles"."cover_updated_at" is null
      ) or (
        "titles"."cover_storage_key" is not null and
        "titles"."cover_media_type" is not null and
        "titles"."cover_checksum_sha256" is not null and
        "titles"."cover_byte_size" > 0 and
        "titles"."cover_width" > 0 and
        "titles"."cover_height" > 0 and
        "titles"."cover_updated_at" is not null
      ));--> statement-breakpoint
ALTER TABLE "titles" ADD CONSTRAINT "titles_cover_checksum_shape" CHECK ("titles"."cover_checksum_sha256" is null or "titles"."cover_checksum_sha256" ~ '^[0-9a-f]{64}$');
