CREATE TYPE "public"."reader_comic_mode" AS ENUM('page', 'guided');--> statement-breakpoint
CREATE TYPE "public"."reader_location_format" AS ENUM('prose', 'comic');--> statement-breakpoint
CREATE TYPE "public"."reader_migration_progress" AS ENUM('migrated', 'reset', 'absent');--> statement-breakpoint
CREATE TYPE "public"."reader_paper" AS ENUM('white', 'sepia', 'dim');--> statement-breakpoint
CREATE TYPE "public"."reader_typeface" AS ENUM('serif', 'sans', 'georgia');--> statement-breakpoint
CREATE TABLE "entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title_id" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlements_user_title_unique" UNIQUE("user_id","title_id"),
	CONSTRAINT "entitlements_revocation_after_grant" CHECK ("entitlements"."revoked_at" is null or "entitlements"."revoked_at" >= "entitlements"."granted_at")
);
--> statement-breakpoint
CREATE TABLE "reader_bookmarks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"format" "reader_location_format" NOT NULL,
	"block_id" uuid,
	"prose_offset" integer,
	"page_id" uuid,
	"panel_ordinal" integer,
	"migrated_from_bookmark_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reader_bookmarks_location_shape" CHECK ((
        "reader_bookmarks"."format" = 'prose' and
        "reader_bookmarks"."block_id" is not null and
        "reader_bookmarks"."prose_offset" is not null and "reader_bookmarks"."prose_offset" >= 0 and
        "reader_bookmarks"."page_id" is null and "reader_bookmarks"."panel_ordinal" is null
      ) or (
        "reader_bookmarks"."format" = 'comic' and
        "reader_bookmarks"."block_id" is null and "reader_bookmarks"."prose_offset" is null and
        "reader_bookmarks"."page_id" is not null and
        ("reader_bookmarks"."panel_ordinal" is null or "reader_bookmarks"."panel_ordinal" >= 0)
      ))
);
--> statement-breakpoint
CREATE TABLE "reader_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"font_size" integer DEFAULT 18 NOT NULL,
	"typeface" "reader_typeface" DEFAULT 'serif' NOT NULL,
	"paper" "reader_paper" DEFAULT 'white' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reader_preferences_font_size_bounds" CHECK ("reader_preferences"."font_size" between 14 and 24),
	CONSTRAINT "reader_preferences_version_positive" CHECK ("reader_preferences"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "reader_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"format" "reader_location_format" NOT NULL,
	"block_id" uuid,
	"prose_offset" integer,
	"page_id" uuid,
	"panel_ordinal" integer,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reader_progress_user_title_revision_unique" UNIQUE("user_id","title_id","revision_id"),
	CONSTRAINT "reader_progress_location_shape" CHECK ((
        "reader_progress"."format" = 'prose' and
        "reader_progress"."block_id" is not null and
        "reader_progress"."prose_offset" is not null and "reader_progress"."prose_offset" >= 0 and
        "reader_progress"."page_id" is null and "reader_progress"."panel_ordinal" is null
      ) or (
        "reader_progress"."format" = 'comic' and
        "reader_progress"."block_id" is null and "reader_progress"."prose_offset" is null and
        "reader_progress"."page_id" is not null and
        ("reader_progress"."panel_ordinal" is null or "reader_progress"."panel_ordinal" >= 0)
      )),
	CONSTRAINT "reader_progress_version_positive" CHECK ("reader_progress"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "reader_revision_migrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title_id" uuid NOT NULL,
	"source_revision_id" uuid NOT NULL,
	"target_revision_id" uuid NOT NULL,
	"progress_result" "reader_migration_progress" NOT NULL,
	"panel_position_simplified" boolean DEFAULT false NOT NULL,
	"migrated_bookmark_count" integer DEFAULT 0 NOT NULL,
	"unmatched_bookmark_count" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notice_acknowledged_at" timestamp with time zone,
	CONSTRAINT "reader_revision_migrations_source_target_unique" UNIQUE("user_id","title_id","source_revision_id","target_revision_id"),
	CONSTRAINT "reader_revision_migrations_target_unique" UNIQUE("user_id","title_id","target_revision_id"),
	CONSTRAINT "reader_revision_migrations_distinct_revisions" CHECK ("reader_revision_migrations"."source_revision_id" <> "reader_revision_migrations"."target_revision_id"),
	CONSTRAINT "reader_revision_migrations_counts_nonnegative" CHECK ("reader_revision_migrations"."migrated_bookmark_count" >= 0 and "reader_revision_migrations"."unmatched_bookmark_count" >= 0),
	CONSTRAINT "reader_revision_migrations_panel_simplified_shape" CHECK (not "reader_revision_migrations"."panel_position_simplified" or "reader_revision_migrations"."progress_result" = 'migrated'),
	CONSTRAINT "reader_revision_migrations_acknowledged_after_completion" CHECK ("reader_revision_migrations"."notice_acknowledged_at" is null or "reader_revision_migrations"."notice_acknowledged_at" >= "reader_revision_migrations"."completed_at")
);
--> statement-breakpoint
CREATE TABLE "reader_title_preferences" (
	"user_id" uuid NOT NULL,
	"title_id" uuid NOT NULL,
	"comic_mode" "reader_comic_mode" DEFAULT 'page' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reader_title_preferences_user_title_pk" PRIMARY KEY("user_id","title_id"),
	CONSTRAINT "reader_title_preferences_version_positive" CHECK ("reader_title_preferences"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "comic_pages" ADD COLUMN "semantic_fingerprint_sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "comic_pages" ADD COLUMN "semantic_fingerprint_version" integer;--> statement-breakpoint
ALTER TABLE "prose_blocks" ADD COLUMN "semantic_fingerprint_sha256" varchar(64);--> statement-breakpoint
ALTER TABLE "prose_blocks" ADD COLUMN "semantic_fingerprint_version" integer;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_bookmarks" ADD CONSTRAINT "reader_bookmarks_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_bookmarks" ADD CONSTRAINT "reader_bookmarks_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_bookmarks" ADD CONSTRAINT "reader_bookmarks_revision_id_title_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."title_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_bookmarks" ADD CONSTRAINT "reader_bookmarks_revision_same_title_fk" FOREIGN KEY ("title_id","revision_id") REFERENCES "public"."title_revisions"("title_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_bookmarks" ADD CONSTRAINT "reader_bookmarks_block_same_revision_fk" FOREIGN KEY ("revision_id","block_id") REFERENCES "public"."prose_blocks"("revision_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_bookmarks" ADD CONSTRAINT "reader_bookmarks_page_same_revision_fk" FOREIGN KEY ("revision_id","page_id") REFERENCES "public"."comic_pages"("revision_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_bookmarks" ADD CONSTRAINT "reader_bookmarks_migrated_from_fk" FOREIGN KEY ("migrated_from_bookmark_id") REFERENCES "public"."reader_bookmarks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_preferences" ADD CONSTRAINT "reader_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_progress" ADD CONSTRAINT "reader_progress_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_progress" ADD CONSTRAINT "reader_progress_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_progress" ADD CONSTRAINT "reader_progress_revision_id_title_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."title_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_progress" ADD CONSTRAINT "reader_progress_revision_same_title_fk" FOREIGN KEY ("title_id","revision_id") REFERENCES "public"."title_revisions"("title_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_progress" ADD CONSTRAINT "reader_progress_block_same_revision_fk" FOREIGN KEY ("revision_id","block_id") REFERENCES "public"."prose_blocks"("revision_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_progress" ADD CONSTRAINT "reader_progress_page_same_revision_fk" FOREIGN KEY ("revision_id","page_id") REFERENCES "public"."comic_pages"("revision_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_revision_migrations" ADD CONSTRAINT "reader_revision_migrations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_revision_migrations" ADD CONSTRAINT "reader_revision_migrations_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_revision_migrations" ADD CONSTRAINT "reader_revision_migrations_source_revision_id_title_revisions_id_fk" FOREIGN KEY ("source_revision_id") REFERENCES "public"."title_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_revision_migrations" ADD CONSTRAINT "reader_revision_migrations_target_revision_id_title_revisions_id_fk" FOREIGN KEY ("target_revision_id") REFERENCES "public"."title_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_revision_migrations" ADD CONSTRAINT "reader_revision_migrations_source_same_title_fk" FOREIGN KEY ("title_id","source_revision_id") REFERENCES "public"."title_revisions"("title_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_revision_migrations" ADD CONSTRAINT "reader_revision_migrations_target_same_title_fk" FOREIGN KEY ("title_id","target_revision_id") REFERENCES "public"."title_revisions"("title_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_title_preferences" ADD CONSTRAINT "reader_title_preferences_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reader_title_preferences" ADD CONSTRAINT "reader_title_preferences_title_id_titles_id_fk" FOREIGN KEY ("title_id") REFERENCES "public"."titles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entitlements_user_title_idx" ON "entitlements" USING btree ("user_id","title_id");--> statement-breakpoint
CREATE INDEX "entitlements_active_user_idx" ON "entitlements" USING btree ("user_id","title_id") WHERE "entitlements"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "reader_bookmarks_user_title_revision_idx" ON "reader_bookmarks" USING btree ("user_id","title_id","revision_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reader_bookmarks_prose_location_unique" ON "reader_bookmarks" USING btree ("user_id","title_id","revision_id","block_id","prose_offset") WHERE "reader_bookmarks"."format" = 'prose';--> statement-breakpoint
CREATE UNIQUE INDEX "reader_bookmarks_comic_location_unique" ON "reader_bookmarks" USING btree ("user_id","title_id","revision_id","page_id",coalesce("panel_ordinal", -1)) WHERE "reader_bookmarks"."format" = 'comic';--> statement-breakpoint
CREATE INDEX "reader_progress_user_title_idx" ON "reader_progress" USING btree ("user_id","title_id","updated_at");--> statement-breakpoint
CREATE INDEX "reader_revision_migrations_user_title_idx" ON "reader_revision_migrations" USING btree ("user_id","title_id","completed_at");--> statement-breakpoint
CREATE INDEX "comic_pages_semantic_fingerprint_idx" ON "comic_pages" USING btree ("revision_id","semantic_fingerprint_version","semantic_fingerprint_sha256");--> statement-breakpoint
CREATE INDEX "prose_blocks_semantic_fingerprint_idx" ON "prose_blocks" USING btree ("revision_id","semantic_fingerprint_version","semantic_fingerprint_sha256");--> statement-breakpoint
ALTER TABLE "comic_pages" ADD CONSTRAINT "comic_pages_semantic_fingerprint_pair" CHECK (("comic_pages"."semantic_fingerprint_sha256" is null) = ("comic_pages"."semantic_fingerprint_version" is null));--> statement-breakpoint
ALTER TABLE "comic_pages" ADD CONSTRAINT "comic_pages_semantic_fingerprint_shape" CHECK ("comic_pages"."semantic_fingerprint_sha256" is null or "comic_pages"."semantic_fingerprint_sha256" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "comic_pages" ADD CONSTRAINT "comic_pages_semantic_fingerprint_version_positive" CHECK ("comic_pages"."semantic_fingerprint_version" is null or "comic_pages"."semantic_fingerprint_version" > 0);--> statement-breakpoint
ALTER TABLE "prose_blocks" ADD CONSTRAINT "prose_blocks_semantic_fingerprint_pair" CHECK (("prose_blocks"."semantic_fingerprint_sha256" is null) = ("prose_blocks"."semantic_fingerprint_version" is null));--> statement-breakpoint
ALTER TABLE "prose_blocks" ADD CONSTRAINT "prose_blocks_semantic_fingerprint_shape" CHECK ("prose_blocks"."semantic_fingerprint_sha256" is null or "prose_blocks"."semantic_fingerprint_sha256" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "prose_blocks" ADD CONSTRAINT "prose_blocks_semantic_fingerprint_version_positive" CHECK ("prose_blocks"."semantic_fingerprint_version" is null or "prose_blocks"."semantic_fingerprint_version" > 0);