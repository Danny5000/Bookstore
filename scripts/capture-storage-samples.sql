\set ON_ERROR_STOP on
\set QUIET on

begin;
set transaction read only;
set local search_path = pg_catalog, public, drizzle;

copy (
  with cover_samples as (
    select 'cover'::text as sample_kind,
      cover_storage_key::text as storage_key,
      cover_checksum_sha256::text as checksum_sha256
    from titles
    where cover_storage_key is not null
    order by updated_at desc, id
    limit 5
  ), revision_original_samples as (
    select 'revision_original'::text as sample_kind,
      original_storage_key::text as storage_key,
      original_checksum_sha256::text as checksum_sha256
    from title_revisions
    where original_storage_key is not null
    order by created_at desc, id
    limit 5
  ), prose_image_samples as (
    select 'prose_image'::text as sample_kind,
      storage_key::text,
      checksum_sha256::text
    from prose_images
    order by created_at desc, id
    limit 5
  ), comic_page_samples as (
    select 'comic_page'::text as sample_kind,
      storage_key::text,
      checksum_sha256::text
    from comic_pages
    order by created_at desc, id
    limit 5
  ), revision_cover_suggestion_samples as (
    select 'revision_cover_suggestion'::text as sample_kind,
      storage_key::text,
      checksum_sha256::text
    from revision_cover_suggestions
    order by created_at desc, id
    limit 5
  )
  select sample_kind, storage_key, checksum_sha256
  from (
    select * from cover_samples
    union all
    select * from revision_original_samples
    union all
    select * from prose_image_samples
    union all
    select * from comic_page_samples
    union all
    select * from revision_cover_suggestion_samples
  ) samples
  order by sample_kind collate "C", storage_key collate "C", checksum_sha256 collate "C"
) to stdout with (format csv, header true);

rollback;
