DO $migration$
DECLARE
  cleanup_role_oid oid;
BEGIN
  IF pg_catalog.to_regprocedure(
    'public.storage_cleanup_referenced_keys(text[])'
  ) IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42723',
      MESSAGE = 'storage cleanup authority routine already exists';
  END IF;

  SELECT role_row.oid INTO cleanup_role_oid
  FROM pg_catalog.pg_roles role_row
  WHERE role_row.rolname = 'pale_orbit_storage_cleanup';

  IF cleanup_role_oid IS NOT NULL AND (EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles role_row
    WHERE role_row.oid = cleanup_role_oid
      AND (
        role_row.rolcanlogin OR role_row.rolsuper OR role_row.rolcreatedb OR
        role_row.rolcreaterole OR NOT role_row.rolinherit OR role_row.rolreplication OR
        role_row.rolbypassrls OR role_row.rolconnlimit <> -1 OR
        role_row.rolvaliduntil IS NOT NULL OR role_row.rolconfig IS NOT NULL
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members membership
    WHERE membership.roleid = cleanup_role_oid OR membership.member = cleanup_role_oid
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_shdepend dependency
    WHERE dependency.refclassid = 'pg_catalog.pg_authid'::pg_catalog.regclass
      AND dependency.refobjid = cleanup_role_oid
      AND dependency.deptype IN ('a', 'o')
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_db_role_setting setting_row
    WHERE setting_row.setrole = cleanup_role_oid
  )) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'preexisting storage cleanup role has authority';
  END IF;
  IF cleanup_role_oid IS NULL THEN
    CREATE ROLE "pale_orbit_storage_cleanup" WITH NOLOGIN NOSUPERUSER NOCREATEDB
      NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1;
  END IF;
END;
$migration$;--> statement-breakpoint
DO $connect$
BEGIN
  EXECUTE pg_catalog.format(
    'GRANT CONNECT ON DATABASE %I TO "pale_orbit_storage_cleanup"',
    pg_catalog.current_database()
  );
END;
$connect$;--> statement-breakpoint
CREATE INDEX "title_revisions_staging_storage_key_idx"
ON "public"."title_revisions" USING btree ("staging_storage_key")
WHERE "title_revisions"."staging_storage_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "title_revisions_original_storage_key_idx"
ON "public"."title_revisions" USING btree ("original_storage_key")
WHERE "title_revisions"."original_storage_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "titles_cover_storage_key_idx"
ON "public"."titles" USING btree ("cover_storage_key")
WHERE "titles"."cover_storage_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "jobs_active_ingest_revision_identity_idx"
ON "public"."jobs" USING btree
  (("payload" ->> 'revisionId'), ("payload" ->> 'generation'))
WHERE "jobs"."type" = 'catalog.ingest_revision'
  AND "jobs"."status" IN ('pending', 'running');--> statement-breakpoint
CREATE FUNCTION "public"."storage_cleanup_referenced_keys"(p_candidate_keys text[])
RETURNS TABLE (
  referenced_storage_key text
)
LANGUAGE plpgsql
STABLE
ROWS 500
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $function$
DECLARE
  candidate_count integer;
  nonnull_count integer;
  distinct_count integer;
BEGIN
  IF NOT pg_catalog.pg_has_role(
    session_user, 'pale_orbit_storage_cleanup', 'MEMBER'
  ) OR pg_catalog.pg_has_role(
    session_user, 'pale_orbit_runtime', 'MEMBER'
  ) OR pg_catalog.pg_has_role(
    session_user, 'pale_orbit_financial_worker', 'MEMBER'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'storage cleanup reference authority is reserved';
  END IF;
  IF p_candidate_keys IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'storage cleanup candidate array is required';
  END IF;
  candidate_count := pg_catalog.cardinality(p_candidate_keys);
  IF candidate_count > 500 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'storage cleanup candidate batch is too large';
  END IF;
  IF candidate_count = 0 THEN
    RETURN;
  END IF;
  IF pg_catalog.array_ndims(p_candidate_keys) <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'storage cleanup candidate array must be one-dimensional';
  END IF;

  SELECT
    pg_catalog.count(candidate_key),
    pg_catalog.count(DISTINCT candidate_key)
  INTO nonnull_count, distinct_count
  FROM pg_catalog.unnest(p_candidate_keys) candidate(candidate_key);
  IF nonnull_count <> candidate_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'storage cleanup candidates may not contain nulls';
  END IF;
  IF distinct_count <> candidate_count THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'storage cleanup candidates may not contain duplicates';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(p_candidate_keys) candidate(candidate_key)
    WHERE candidate.candidate_key ~ '[[:cntrl:]]'
      OR pg_catalog.char_length(candidate.candidate_key) > 500
      OR NOT (
        candidate.candidate_key ~
          '^staging/uploads/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR candidate.candidate_key ~
          '^health/probes/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR candidate.candidate_key ~
          '^titles/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/covers/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]webp$'
        OR candidate.candidate_key ~
          '^titles/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/revisions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/derived/v1/(prose-images|comic-pages|cover-suggestions)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]webp$'
        OR candidate.candidate_key ~
          '^titles/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/revisions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/derived/v1/generations/(0|[1-9][0-9]{0,9})/(prose-images|comic-pages|cover-suggestions)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.]webp$'
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(p_candidate_keys) candidate(candidate_key)
    WHERE candidate.candidate_key LIKE '%/derived/v1/generations/%'
      AND (
        (pg_catalog.regexp_match(
          candidate.candidate_key,
          '/generations/([0-9]+)/'
        ))[1]::numeric > 2147483647
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'storage cleanup candidate key is not canonical';
  END IF;

  RETURN QUERY
  WITH parsed_candidates AS (
    SELECT
      candidate.candidate_key,
      CASE
        WHEN candidate.candidate_key LIKE 'health/probes/%' THEN 'health-probe'
        WHEN candidate.candidate_key LIKE 'staging/uploads/%' THEN 'staging'
        WHEN candidate.candidate_key LIKE 'titles/%/covers/%' THEN 'title-cover'
        ELSE 'derived'
      END AS candidate_class,
      CASE
        WHEN candidate.candidate_key LIKE 'titles/%/revisions/%/derived/%'
          THEN pg_catalog.split_part(candidate.candidate_key, '/', 2)::uuid
        ELSE NULL
      END AS title_id,
      CASE
        WHEN candidate.candidate_key LIKE 'titles/%/revisions/%/derived/%'
          THEN pg_catalog.split_part(candidate.candidate_key, '/', 4)::uuid
        ELSE NULL
      END AS revision_id,
      CASE
        WHEN candidate.candidate_key LIKE '%/derived/v1/generations/%'
          THEN pg_catalog.split_part(candidate.candidate_key, '/', 8)::integer
        ELSE NULL
      END AS generation
    FROM pg_catalog.unnest(p_candidate_keys) candidate(candidate_key)
  )
  SELECT parsed.candidate_key
  FROM parsed_candidates parsed
  WHERE parsed.candidate_class <> 'health-probe'
    AND (
      EXISTS (
      SELECT 1
      FROM "public"."titles" referenced_title
      WHERE referenced_title.cover_storage_key = parsed.candidate_key
    )
    OR EXISTS (
      SELECT 1
      FROM "public"."title_revisions" referenced_revision
      WHERE referenced_revision.original_storage_key = parsed.candidate_key
    )
    OR EXISTS (
      SELECT 1
      FROM "public"."prose_images" referenced_prose_image
      WHERE referenced_prose_image.storage_key = parsed.candidate_key
    )
    OR EXISTS (
      SELECT 1
      FROM "public"."comic_pages" referenced_comic_page
      WHERE referenced_comic_page.storage_key = parsed.candidate_key
    )
    OR EXISTS (
      SELECT 1
      FROM "public"."revision_cover_suggestions" referenced_suggestion
      WHERE referenced_suggestion.storage_key = parsed.candidate_key
    )
    OR (
      parsed.candidate_class = 'staging'
      AND EXISTS (
        SELECT 1
        FROM "public"."title_revisions" referenced_revision
        WHERE referenced_revision.staging_storage_key = parsed.candidate_key
          AND (
            referenced_revision.state IN ('uploaded', 'processing')
            OR EXISTS (
              SELECT 1
              FROM "public"."jobs" active_job
              WHERE active_job.type = 'catalog.ingest_revision'
                AND active_job.status IN ('pending', 'running')
                AND active_job.payload ->> 'revisionId' = referenced_revision.id::text
                AND active_job.payload ->> 'generation' =
                  referenced_revision.ingestion_generation::text
            )
          )
      )
    )
    OR (
      parsed.candidate_class = 'derived'
      AND parsed.generation IS NULL
      AND EXISTS (
        SELECT 1
        FROM "public"."title_revisions" referenced_revision
        WHERE referenced_revision.id = parsed.revision_id
          AND referenced_revision.title_id = parsed.title_id
          AND (
            referenced_revision.state IN ('uploaded', 'processing')
            OR EXISTS (
              SELECT 1
              FROM "public"."jobs" active_job
              WHERE active_job.type = 'catalog.ingest_revision'
                AND active_job.status IN ('pending', 'running')
                AND active_job.payload ->> 'revisionId' = referenced_revision.id::text
            )
          )
      )
    )
    OR (
      parsed.candidate_class = 'derived'
      AND parsed.generation IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM "public"."title_revisions" referenced_revision
        WHERE referenced_revision.id = parsed.revision_id
          AND referenced_revision.title_id = parsed.title_id
          AND (
            (
              referenced_revision.state IN ('uploaded', 'processing')
              AND referenced_revision.ingestion_generation = parsed.generation
            )
            OR EXISTS (
              SELECT 1
              FROM "public"."jobs" active_job
              WHERE active_job.type = 'catalog.ingest_revision'
                AND active_job.status IN ('pending', 'running')
                AND active_job.payload ->> 'revisionId' = referenced_revision.id::text
                AND active_job.payload ->> 'generation' = parsed.generation::text
            )
          )
      )
    )
    )
  ORDER BY parsed.candidate_key;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."storage_cleanup_referenced_keys"(text[]) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."storage_cleanup_referenced_keys"(text[])
FROM "pale_orbit_runtime", "pale_orbit_financial_worker";--> statement-breakpoint
REVOKE ALL ON SCHEMA "public" FROM "pale_orbit_storage_cleanup";--> statement-breakpoint
GRANT USAGE ON SCHEMA "public" TO "pale_orbit_storage_cleanup";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."storage_cleanup_referenced_keys"(text[])
TO "pale_orbit_storage_cleanup";--> statement-breakpoint
DO $postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_database database_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(database_row.datacl) acl
    JOIN pg_catalog.pg_roles grantee_role ON grantee_role.oid = acl.grantee
    WHERE database_row.datname = pg_catalog.current_database()
      AND grantee_role.rolname = 'pale_orbit_storage_cleanup'
      AND acl.privilege_type = 'CONNECT'
      AND NOT acl.is_grantable
  ) OR NOT pg_catalog.has_schema_privilege(
    'pale_orbit_storage_cleanup', 'public', 'USAGE'
  ) OR pg_catalog.has_schema_privilege(
    'pale_orbit_storage_cleanup', 'public', 'CREATE'
  ) OR pg_catalog.has_database_privilege(
    'pale_orbit_storage_cleanup', pg_catalog.current_database(), 'CREATE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace namespace_row
    WHERE namespace_row.nspname !~ '^pg_'
      AND namespace_row.nspname NOT IN ('information_schema', 'public')
      AND (
        pg_catalog.has_schema_privilege(
          'pale_orbit_storage_cleanup', namespace_row.oid, 'USAGE'
        ) OR pg_catalog.has_schema_privilege(
          'pale_orbit_storage_cleanup', namespace_row.oid, 'CREATE'
        )
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation_row
    JOIN pg_catalog.pg_namespace namespace_row
      ON namespace_row.oid = relation_row.relnamespace
    CROSS JOIN pg_catalog.unnest(ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'
    ]::text[]) privilege(privilege_name)
    WHERE namespace_row.nspname = 'public'
      AND relation_row.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND pg_catalog.has_table_privilege(
        'pale_orbit_storage_cleanup', relation_row.oid, privilege.privilege_name
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation_row
    JOIN pg_catalog.pg_namespace namespace_row
      ON namespace_row.oid = relation_row.relnamespace
    CROSS JOIN pg_catalog.unnest(
      ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']::text[]
    ) privilege(privilege_name)
    WHERE namespace_row.nspname = 'public'
      AND relation_row.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND pg_catalog.has_any_column_privilege(
        'pale_orbit_storage_cleanup', relation_row.oid, privilege.privilege_name
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class sequence_row
    JOIN pg_catalog.pg_namespace namespace_row
      ON namespace_row.oid = sequence_row.relnamespace
    CROSS JOIN pg_catalog.unnest(ARRAY['SELECT', 'USAGE', 'UPDATE']::text[])
      privilege(privilege_name)
    WHERE namespace_row.nspname = 'public' AND sequence_row.relkind = 'S'
      AND pg_catalog.has_sequence_privilege(
        'pale_orbit_storage_cleanup', sequence_row.oid, privilege.privilege_name
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc routine
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = routine.pronamespace
    WHERE namespace_row.nspname !~ '^pg_'
      AND namespace_row.nspname <> 'information_schema'
      AND routine.oid <> pg_catalog.to_regprocedure(
        'public.storage_cleanup_referenced_keys(text[])'
      )
      AND pg_catalog.has_function_privilege(
        'pale_orbit_storage_cleanup', routine.oid, 'EXECUTE'
      )
  ) OR NOT pg_catalog.has_function_privilege(
    'pale_orbit_storage_cleanup',
    'public.storage_cleanup_referenced_keys(text[])',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'storage cleanup role inherited unsafe authority';
  END IF;
END;
$postflight$;
