\set ON_ERROR_STOP on
\set QUIET on

begin;
set transaction read only;
set local search_path = pg_catalog, public, drizzle;

copy (
  with storage_references(
    storage_class, reference_kind, storage_key, checksum_sha256, byte_size
  ) as (
    select 'covers'::text, 'title_cover'::text,
      referenced_title.cover_storage_key::text,
      referenced_title.cover_checksum_sha256::text,
      referenced_title.cover_byte_size::bigint
    from public.titles referenced_title
    where referenced_title.cover_storage_key is not null
    union all
    select 'staging'::text, 'revision_staging'::text,
      referenced_revision.staging_storage_key::text,
      referenced_revision.staging_checksum_sha256::text,
      referenced_revision.staging_byte_size::bigint
    from public.title_revisions referenced_revision
    where referenced_revision.staging_storage_key is not null
      and (
        referenced_revision.state in ('uploaded', 'processing')
        or exists (
          select 1
          from public.jobs active_job
          where active_job.type = 'catalog.ingest_revision'
            and active_job.status in ('pending', 'running')
            and active_job.payload ->> 'revisionId' = referenced_revision.id::text
            and active_job.payload ->> 'generation' = referenced_revision.ingestion_generation::text
        )
      )
    union all
    select 'publication'::text, 'revision_original'::text,
      referenced_revision.original_storage_key::text,
      referenced_revision.original_checksum_sha256::text,
      referenced_revision.original_byte_size::bigint
    from public.title_revisions referenced_revision
    where referenced_revision.original_storage_key is not null
    union all
    select 'publication'::text, 'prose_image'::text,
      referenced_prose_image.storage_key::text,
      referenced_prose_image.checksum_sha256::text,
      referenced_prose_image.byte_size::bigint
    from public.prose_images referenced_prose_image
    union all
    select 'publication'::text, 'comic_page'::text,
      referenced_comic_page.storage_key::text,
      referenced_comic_page.checksum_sha256::text,
      referenced_comic_page.byte_size::bigint
    from public.comic_pages referenced_comic_page
    union all
    select 'publication'::text, 'revision_cover_suggestion'::text,
      referenced_suggestion.storage_key::text,
      referenced_suggestion.checksum_sha256::text,
      referenced_suggestion.byte_size::bigint
    from public.revision_cover_suggestions referenced_suggestion
  )
  select storage_class, reference_kind, storage_key, checksum_sha256, byte_size
  from storage_references
  order by storage_class collate "C", reference_kind collate "C",
    storage_key collate "C", checksum_sha256 collate "C", byte_size
) to stdout with (format csv, header true);

rollback;
