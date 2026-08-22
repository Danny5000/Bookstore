DO $plan6bii_reporting_correction_preflight$
DECLARE
  database_oid oid;
  database_owner oid;
  database_owner_name name;
  expected_web_login text;
  expected_worker_login text;
  expected_storage_cleanup_login text;
BEGIN
  SELECT database_row.oid, database_row.datdba,
    pg_catalog.pg_get_userbyid(database_row.datdba)
  INTO database_oid, database_owner, database_owner_name
  FROM pg_catalog.pg_database database_row
  WHERE database_row.datname = pg_catalog.current_database();

  IF database_owner IS NULL OR current_user IS DISTINCT FROM database_owner_name OR
    pg_catalog.current_setting('session_replication_role') IS DISTINCT FROM 'origin' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 6B-II reporting-correction migration requires canonical owner authority';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc routine
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = routine.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND routine.proname = 'resolve_financial_issue_after_reporting_correction_command'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 6B-II reporting-correction authority name is already occupied';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_namespace namespace_row
    WHERE namespace_row.nspname = 'public'
      AND namespace_row.nspowner IN (
        database_owner, 'pg_database_owner'::pg_catalog.regrole
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(ARRAY[
      'public.user_roles', 'public.jobs', 'public.audit_events',
      'public.financial_admin_commands', 'public.financial_admin_job_claims',
      'public.financial_reconciliation_issues', 'public.refunds', 'public.payments',
      'public.order_items', 'public.refund_allocation_components',
      'public.refund_reporting_correction_sets',
      'public.refund_reporting_correction_items',
      'public.financial_projection_versions', 'public.financial_allocation_sets',
      'public.financial_item_allocations'
    ]::text[]) prerequisite(relation_name)
    LEFT JOIN pg_catalog.pg_class relation_row
      ON relation_row.oid = pg_catalog.to_regclass(prerequisite.relation_name)
    WHERE relation_row.oid IS NULL OR relation_row.relowner <> database_owner
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(ARRAY[
      'public.financial_admin_command_status', 'public.financial_admin_command_kind',
      'public.financial_issue_state', 'public.financial_issue_impact',
      'public.refund_correction_kind', 'public.refund_correction_domain',
      'public.financial_allocation_source_kind', 'public.financial_allocation_basis',
      'public.financial_allocation_scope', 'public.financial_component',
      'public.commerce_refund_status'
    ]::text[]) prerequisite(type_name)
    LEFT JOIN pg_catalog.pg_type type_row
      ON type_row.oid = pg_catalog.to_regtype(prerequisite.type_name)
    WHERE type_row.oid IS NULL OR type_row.typowner <> database_owner
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 6B-II reporting-correction prerequisite owner is not canonical';
  END IF;

  expected_web_login := pg_catalog.current_setting(
    'pale_orbit.migration_expected_web_login', true
  );
  expected_worker_login := pg_catalog.current_setting(
    'pale_orbit.migration_expected_worker_login', true
  );
  expected_storage_cleanup_login := pg_catalog.current_setting(
    'pale_orbit.migration_expected_storage_cleanup_login', true
  );

  IF expected_web_login IS NULL OR expected_worker_login IS NULL OR
    expected_storage_cleanup_login IS NULL OR
    expected_web_login !~ '^[a-z][a-z0-9_]{0,62}$' OR
    expected_worker_login !~ '^[a-z][a-z0-9_]{0,62}$' OR
    expected_storage_cleanup_login !~ '^[a-z][a-z0-9_]{0,62}$' OR
    pg_catalog.left(expected_web_login, 3) = 'pg_' OR
    pg_catalog.left(expected_worker_login, 3) = 'pg_' OR
    pg_catalog.left(expected_storage_cleanup_login, 3) = 'pg_' OR
    expected_web_login = ANY(ARRAY[
      'pale_orbit_runtime', 'pale_orbit_financial_worker',
      'pale_orbit_storage_cleanup'
    ]::text[]) OR expected_worker_login = ANY(ARRAY[
      'pale_orbit_runtime', 'pale_orbit_financial_worker',
      'pale_orbit_storage_cleanup'
    ]::text[]) OR expected_storage_cleanup_login = ANY(ARRAY[
      'pale_orbit_runtime', 'pale_orbit_financial_worker',
      'pale_orbit_storage_cleanup'
    ]::text[]) OR expected_web_login = database_owner_name::text OR
    expected_worker_login = database_owner_name::text OR
    expected_storage_cleanup_login = database_owner_name::text OR
    expected_web_login = expected_worker_login OR
    expected_web_login = expected_storage_cleanup_login OR
    expected_worker_login = expected_storage_cleanup_login THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 6B-II reporting-correction migration login identity is not canonical';
  END IF;

  IF EXISTS (
    WITH attested_login_expectations(login_name, group_name) AS (
      VALUES
        (expected_web_login::text, 'pale_orbit_runtime'::text),
        (expected_worker_login::text, 'pale_orbit_financial_worker'::text),
        (expected_storage_cleanup_login::text, 'pale_orbit_storage_cleanup'::text)
    ), attested_login_catalog AS (
      SELECT expectation.login_name, expectation.group_name,
        role_row.oid AS role_oid, role_row.rolcanlogin, role_row.rolsuper,
        role_row.rolcreatedb, role_row.rolcreaterole, role_row.rolinherit,
        role_row.rolreplication, role_row.rolbypassrls,
        role_row.rolconnlimit, role_row.rolvaliduntil, role_row.rolconfig
      FROM attested_login_expectations expectation
      LEFT JOIN pg_catalog.pg_roles role_row
        ON role_row.rolname = expectation.login_name
    ), present_attested_logins AS (
      SELECT * FROM attested_login_catalog WHERE role_oid IS NOT NULL
    ), absent_attested_logins AS (
      SELECT * FROM attested_login_catalog WHERE role_oid IS NULL
    ), invalid_present_attested_logins AS (
      SELECT login_row.login_name
      FROM present_attested_logins login_row
      WHERE NOT login_row.rolcanlogin OR login_row.rolsuper OR
        login_row.rolcreatedb OR login_row.rolcreaterole OR
        NOT login_row.rolinherit OR login_row.rolreplication OR
        login_row.rolbypassrls OR login_row.rolconnlimit <> -1 OR
        login_row.rolvaliduntil IS DISTINCT FROM 'infinity'::timestamptz OR
        login_row.rolconfig IS NOT NULL OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_db_role_setting setting_row
          WHERE setting_row.setrole = login_row.role_oid
        )
    ), invalid_absent_attested_logins AS (
      SELECT login_row.login_name
      FROM absent_attested_logins login_row
      WHERE EXISTS (
        SELECT 1
        FROM pg_catalog.pg_auth_members membership
        JOIN pg_catalog.pg_roles member_role ON member_role.oid = membership.member
        WHERE member_role.rolname = login_row.login_name
      )
    ), expected_fixed_groups(group_name) AS (
      VALUES ('pale_orbit_runtime'::text),
        ('pale_orbit_financial_worker'::text),
        ('pale_orbit_storage_cleanup'::text)
    ), invalid_fixed_groups AS (
      SELECT expected_group.group_name
      FROM expected_fixed_groups expected_group
      LEFT JOIN pg_catalog.pg_roles role_row
        ON role_row.rolname = expected_group.group_name
      WHERE role_row.oid IS NULL OR role_row.rolcanlogin OR role_row.rolsuper OR
        role_row.rolcreatedb OR role_row.rolcreaterole OR
        NOT role_row.rolinherit OR role_row.rolreplication OR
        role_row.rolbypassrls OR role_row.rolconnlimit <> -1 OR
        role_row.rolvaliduntil IS NOT NULL OR role_row.rolconfig IS NOT NULL OR
        EXISTS (
          SELECT 1 FROM pg_catalog.pg_db_role_setting setting_row
          WHERE setting_row.setrole = role_row.oid
        )
    ), relevant_role_names(role_name) AS (
      SELECT login_name FROM attested_login_expectations
      UNION SELECT group_name FROM expected_fixed_groups
      UNION SELECT database_owner_name::text
    ), actual_relevant_memberships AS (
      SELECT member_role.rolname::text AS member_name,
        granted_role.rolname::text AS granted_name,
        membership.admin_option, membership.inherit_option, membership.set_option
      FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles member_role ON member_role.oid = membership.member
      JOIN pg_catalog.pg_roles granted_role ON granted_role.oid = membership.roleid
      WHERE member_role.rolname IN (SELECT role_name FROM relevant_role_names)
        OR granted_role.rolname IN (SELECT role_name FROM relevant_role_names)
    ), expected_relevant_memberships(
      member_name, granted_name, admin_option, inherit_option, set_option
    ) AS (
      SELECT expected_membership.*
      FROM (VALUES
        (expected_web_login::text,'pale_orbit_runtime'::text,false,true,false),
        (expected_worker_login::text,'pale_orbit_financial_worker'::text,false,true,false),
        (expected_storage_cleanup_login::text,'pale_orbit_storage_cleanup'::text,false,true,false),
        ('pale_orbit_financial_worker','pale_orbit_runtime',false,true,false)
      ) expected_membership(
        member_name, granted_name, admin_option, inherit_option, set_option
      )
      WHERE expected_membership.member_name = 'pale_orbit_financial_worker' OR EXISTS (
        SELECT 1 FROM present_attested_logins present_login
        WHERE present_login.login_name = expected_membership.member_name
      )
    ), relevant_membership_delta AS (
      (SELECT * FROM actual_relevant_memberships
       EXCEPT SELECT * FROM expected_relevant_memberships)
      UNION ALL
      (SELECT * FROM expected_relevant_memberships
       EXCEPT SELECT * FROM actual_relevant_memberships)
    ), unsafe_attestation_setting_default AS (
      SELECT 1
      FROM pg_catalog.pg_db_role_setting setting_row
      CROSS JOIN LATERAL pg_catalog.unnest(setting_row.setconfig) configured_setting(value)
      WHERE ((setting_row.setrole = database_owner AND
          setting_row.setdatabase IN (0::oid, database_oid)) OR
        (setting_row.setrole = 0 AND
          setting_row.setdatabase IN (0::oid, database_oid)))
        AND pg_catalog.split_part(configured_setting.value, '=', 1) = ANY(ARRAY[
          'pale_orbit.migration_expected_web_login',
          'pale_orbit.migration_expected_worker_login',
          'pale_orbit.migration_expected_storage_cleanup_login'
        ]::text[])
    )
    SELECT 1 FROM invalid_present_attested_logins
    UNION ALL SELECT 1 FROM invalid_absent_attested_logins
    UNION ALL SELECT 1 FROM invalid_fixed_groups
    UNION ALL SELECT 1 FROM relevant_membership_delta
    UNION ALL SELECT 1 FROM unsafe_attestation_setting_default
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 6B-II reporting-correction migration login identity is not canonical';
  END IF;

  IF EXISTS (
    WITH expected_routine(signature, role_name, security_definer, configuration) AS (
      VALUES
        ('public.submit_financial_admin_command(uuid,text,text,text,text,jsonb)'::text,
          'pale_orbit_runtime'::text, true, ARRAY['search_path=pg_catalog']::text[]),
        ('public.financial_admin_command_status(uuid,uuid)',
          'pale_orbit_runtime', true, ARRAY['search_path=pg_catalog']::text[]),
        ('public.append_financial_issue_view_audit(uuid,uuid,text,text,text)',
          'pale_orbit_runtime', true, ARRAY['search_path=pg_catalog']::text[]),
        ('public.append_financial_refund_review_view_audit(uuid,uuid,text,text,text)',
          'pale_orbit_runtime', true, ARRAY['search_path=pg_catalog']::text[]),
        ('public.append_financial_payout_view_audit(uuid,uuid,text,text,text)',
          'pale_orbit_runtime', true, ARRAY['search_path=pg_catalog']::text[]),
        ('public.append_financial_sales_export_audit(uuid,text,text,integer,integer,integer,text,text)',
          'pale_orbit_runtime', true, ARRAY['search_path=pg_catalog']::text[]),
        ('public.resolve_financial_issue_after_admin_command(uuid,uuid)',
          'pale_orbit_financial_worker', true, ARRAY['search_path=pg_catalog']::text[]),
        ('public.transition_administrative_recovery_grant_after_admin_command(uuid)',
          'pale_orbit_financial_worker', true, ARRAY['search_path=pg_catalog']::text[]),
        ('public.plan6bii_assert_financial_admin_job_lease(uuid)',
          NULL::text, true, ARRAY['search_path=pg_catalog']::text[]),
        ('public.plan6b_validate_issue_transition()',
          NULL::text, false, NULL::text[])
    ), resolved_routine AS (
      SELECT expected.*, pg_catalog.to_regprocedure(expected.signature)::oid AS routine_oid
      FROM expected_routine expected
    ), invalid_shape AS (
      SELECT resolved.signature
      FROM resolved_routine resolved
      LEFT JOIN pg_catalog.pg_proc routine ON routine.oid = resolved.routine_oid
      WHERE routine.oid IS NULL OR routine.proowner <> database_owner OR
        routine.prosecdef IS DISTINCT FROM resolved.security_definer OR
        routine.proconfig IS DISTINCT FROM resolved.configuration
    ), actual_acl AS (
      SELECT resolved.signature, privilege.grantee, privilege.grantor,
        privilege.privilege_type::text, privilege.is_grantable
      FROM resolved_routine resolved
      JOIN pg_catalog.pg_proc routine ON routine.oid = resolved.routine_oid
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
        routine.proacl, pg_catalog.acldefault('f', routine.proowner)
      )) privilege
    ), expected_acl(signature, grantee, grantor, privilege_type, is_grantable) AS (
      SELECT resolved.signature, database_owner, database_owner, 'EXECUTE', false
      FROM resolved_routine resolved
      UNION ALL
      SELECT resolved.signature, role_row.oid, database_owner, 'EXECUTE', false
      FROM resolved_routine resolved
      JOIN pg_catalog.pg_roles role_row ON role_row.rolname = resolved.role_name
      WHERE resolved.role_name IS NOT NULL
    ), acl_delta AS (
      (SELECT * FROM actual_acl EXCEPT ALL SELECT * FROM expected_acl)
      UNION ALL
      (SELECT * FROM expected_acl EXCEPT ALL SELECT * FROM actual_acl)
    )
    SELECT 1 FROM invalid_shape
    UNION ALL SELECT 1 FROM acl_delta
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger trigger_row
    WHERE trigger_row.tgrelid =
        'public.financial_reconciliation_issues'::pg_catalog.regclass
      AND trigger_row.tgname = 'financial_reconciliation_issues_narrow_update'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgfoid =
        'public.plan6b_validate_issue_transition()'::pg_catalog.regprocedure
      AND (trigger_row.tgtype::integer & 1) = 1
      AND (trigger_row.tgtype::integer & 2) = 2
      AND (trigger_row.tgtype::integer & 16) = 16
      AND (trigger_row.tgtype::integer & 8) = 8
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 6B-II reporting-correction prerequisite authority is not canonical';
  END IF;
END;
$plan6bii_reporting_correction_preflight$;--> statement-breakpoint

CREATE FUNCTION "public"."resolve_financial_issue_after_reporting_correction_command"(uuid,uuid)
RETURNS SETOF "public"."financial_reconciliation_issues"
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $reporting_correction_issue_resolution$
DECLARE
  requested_command_id uuid := $1;
  requested_issue_id uuid := $2;
  command_job_id uuid;
  locked_command_id uuid;
  locked_actor_user_id uuid;
  locked_correlation_id text;
  locked_command_status "public"."financial_admin_command_status";
  command_row "public"."financial_admin_commands"%ROWTYPE;
  issue_row "public"."financial_reconciliation_issues"%ROWTYPE;
  resolved_issue "public"."financial_reconciliation_issues"%ROWTYPE;
  correction_row "public"."refund_reporting_correction_sets"%ROWTYPE;
  command_refund_id uuid;
  command_next_version integer;
  command_base_set_id uuid;
  command_source_fingerprint text;
  correction_is_compatible boolean := false;
  allowlisted_issue boolean := false;
BEGIN
  IF NOT pg_catalog.pg_has_role(
    session_user, 'pale_orbit_financial_worker', 'MEMBER'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'reporting-correction issue transition is not permitted';
  END IF;
  IF requested_command_id IS NULL OR requested_issue_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid reporting-correction issue transition';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('pale-orbit:user-roles:admin')
  );
  SELECT command.job_id INTO command_job_id
  FROM "public"."financial_admin_commands" command
  WHERE command.id = requested_command_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(
    'pale-orbit:plan6bii-financial-admin-job-lease:' || command_job_id::text, 0
  ));
  SELECT command.id, command.actor_user_id, command.correlation_id, command.status
  INTO locked_command_id, locked_actor_user_id,
    locked_correlation_id, locked_command_status
  FROM "public"."financial_admin_commands" command
  WHERE command.id = requested_command_id
    AND command.job_id = command_job_id
    AND command.kind = 'refund_reporting_correction_create'
    AND command.status = 'pending'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "public"."user_roles" role_row
    WHERE role_row.user_id = locked_actor_user_id AND role_row.role = 'admin'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'financial administrator capability is not current';
  END IF;
  PERFORM "public"."plan6bii_assert_financial_admin_job_lease"(command_job_id);
  SELECT * INTO command_row
  FROM "public"."financial_admin_commands" command
  WHERE command.id = locked_command_id
    AND command.job_id = command_job_id
    AND command.kind = 'refund_reporting_correction_create'
    AND command.actor_user_id = locked_actor_user_id
    AND command.correlation_id = locked_correlation_id
    AND command.status = locked_command_status;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'invalid reporting-correction issue command';
  END IF;

  IF NOT ((
    pg_catalog.jsonb_typeof(command_row.private_input) = 'object' AND
    command_row.private_input ?& ARRAY[
      'kind','refundId','reason','expectedNextCorrectionVersion',
      'expectedBaseAllocationSetId','expectedSourceFingerprint','items',
      'previewFingerprint','confirmation'
    ]::text[] AND
    command_row.private_input - 'kind' - 'refundId' - 'reason' -
      'expectedNextCorrectionVersion' - 'expectedBaseAllocationSetId' -
      'expectedSourceFingerprint' - 'items' - 'previewFingerprint' -
      'confirmation' = '{}'::jsonb AND
    pg_catalog.jsonb_typeof(command_row.private_input -> 'kind') = 'string' AND
    command_row.private_input ->> 'kind' = 'refund_reporting_correction_create' AND
    pg_catalog.jsonb_typeof(command_row.private_input -> 'refundId') = 'string' AND
    CASE WHEN pg_catalog.pg_input_is_valid(
        command_row.private_input ->> 'refundId', 'uuid'
      ) THEN (command_row.private_input ->> 'refundId')::uuid::text =
        command_row.private_input ->> 'refundId' ELSE false END AND
    pg_catalog.jsonb_typeof(command_row.private_input -> 'reason') = 'string' AND
    command_row.private_input ->> 'reason' = 'allocation_attribution_correction' AND
    pg_catalog.jsonb_typeof(
      command_row.private_input -> 'expectedNextCorrectionVersion'
    ) = 'number' AND
    CASE WHEN pg_catalog.pg_input_is_valid(
        command_row.private_input ->> 'expectedNextCorrectionVersion', 'integer'
      ) THEN (command_row.private_input ->> 'expectedNextCorrectionVersion')::integer
        BETWEEN 1 AND 2147483647 ELSE false END AND
    pg_catalog.jsonb_typeof(
      command_row.private_input -> 'expectedBaseAllocationSetId'
    ) = 'string' AND
    CASE WHEN pg_catalog.pg_input_is_valid(
        command_row.private_input ->> 'expectedBaseAllocationSetId', 'uuid'
      ) THEN (command_row.private_input ->> 'expectedBaseAllocationSetId')::uuid::text =
        command_row.private_input ->> 'expectedBaseAllocationSetId' ELSE false END AND
    pg_catalog.jsonb_typeof(
      command_row.private_input -> 'expectedSourceFingerprint'
    ) = 'string' AND
    command_row.private_input ->> 'expectedSourceFingerprint' ~ '^[a-f0-9]{64}$' AND
    pg_catalog.jsonb_typeof(command_row.private_input -> 'previewFingerprint') = 'string' AND
    command_row.private_input ->> 'previewFingerprint' ~ '^[a-f0-9]{64}$' AND
    pg_catalog.jsonb_typeof(command_row.private_input -> 'confirmation') = 'string' AND
    command_row.private_input ->> 'confirmation' = 'create_reporting_correction' AND
    CASE WHEN pg_catalog.jsonb_typeof(command_row.private_input -> 'items') = 'array'
      THEN (
        pg_catalog.jsonb_array_length(command_row.private_input -> 'items') BETWEEN 1 AND 25 AND
        NOT EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements(command_row.private_input -> 'items') item(value)
          WHERE NOT ((CASE WHEN pg_catalog.jsonb_typeof(item.value) = 'object' THEN (
            item.value ?& ARRAY['orderItemId','totalPresentmentMinor']::text[] AND
            item.value - 'orderItemId' - 'totalPresentmentMinor' = '{}'::jsonb AND
            pg_catalog.jsonb_typeof(item.value -> 'orderItemId') = 'string' AND
            CASE WHEN pg_catalog.pg_input_is_valid(item.value ->> 'orderItemId', 'uuid')
              THEN (item.value ->> 'orderItemId')::uuid::text =
                item.value ->> 'orderItemId' ELSE false END AND
            pg_catalog.jsonb_typeof(item.value -> 'totalPresentmentMinor') = 'number' AND
            CASE WHEN pg_catalog.pg_input_is_valid(
                item.value ->> 'totalPresentmentMinor', 'integer'
              ) THEN (item.value ->> 'totalPresentmentMinor')::integer
                BETWEEN 0 AND 99999999 ELSE false END
          ) ELSE false END) IS TRUE)
        ) AND (
          SELECT pg_catalog.count(*) =
            pg_catalog.count(DISTINCT item.value ->> 'orderItemId')
          FROM pg_catalog.jsonb_array_elements(command_row.private_input -> 'items') item(value)
        )
      ) ELSE false END
  ) IS TRUE) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'invalid reporting-correction issue command';
  END IF;

  command_refund_id := (command_row.private_input ->> 'refundId')::uuid;
  command_next_version :=
    (command_row.private_input ->> 'expectedNextCorrectionVersion')::integer;
  command_base_set_id :=
    (command_row.private_input ->> 'expectedBaseAllocationSetId')::uuid;
  command_source_fingerprint := command_row.private_input ->> 'expectedSourceFingerprint';

  SELECT correction.* INTO correction_row
  FROM "public"."refund_reporting_correction_sets" correction
  WHERE correction.refund_id = command_refund_id
    AND correction.correction_version = command_next_version
    AND correction.kind = 'allocation_attribution_correction'
    AND correction.base_allocation_set_id = command_base_set_id
    AND correction.source_fingerprint_sha256 = command_source_fingerprint
    AND correction.approved_by_admin_id = command_row.actor_user_id
    AND correction.created_by_admin_id = command_row.actor_user_id
    AND correction.correlation_id = command_row.correlation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'reporting correction does not match its administrator command';
  END IF;

  WITH RECURSIVE active_projection_version AS (
    SELECT projection.classifier_version, projection.allocation_algorithm_version
    FROM "public"."financial_projection_versions" projection
    WHERE projection.singleton = true
      AND projection.pending_classifier_version IS NULL
      AND projection.pending_allocation_algorithm_version IS NULL
      AND projection.pending_replay_id IS NULL
      AND projection.pending_scan_run_id IS NULL
  ), eligible_allocation_sets AS (
    SELECT allocation_set.*
    FROM "public"."financial_allocation_sets" allocation_set
    CROSS JOIN active_projection_version projection
    WHERE allocation_set.classifier_version = projection.classifier_version
      AND allocation_set.algorithm_version = projection.allocation_algorithm_version
  ), eligible_base_tips_unranked AS (
    SELECT allocation_set.*
    FROM eligible_allocation_sets allocation_set
    WHERE NOT EXISTS (
      SELECT 1 FROM eligible_allocation_sets successor
      WHERE successor.supersedes_set_id = allocation_set.id
    )
  ), eligible_base_tips AS (
    SELECT tip.*,
      pg_catalog.count(*) OVER (
        PARTITION BY tip.balance_transaction_id, tip.basis
      ) AS tip_count
    FROM eligible_base_tips_unranked tip
  ), refund_presentment_components AS (
    SELECT allocation.refund_id, allocation.order_item_id,
      allocation.currency, component.component, component.amount_minor
    FROM "public"."refund_allocation_components" allocation
    CROSS JOIN LATERAL (VALUES
      ('refund_subtotal'::"public"."financial_component", allocation.subtotal_minor),
      ('refund_tax'::"public"."financial_component", allocation.tax_minor)
    ) component(component, amount_minor)
  ), correction_tip_candidates AS (
    SELECT correction.*
    FROM "public"."refund_reporting_correction_sets" correction
    WHERE EXISTS (
      SELECT 1 FROM eligible_allocation_sets anchor
      WHERE anchor.id = correction.base_allocation_set_id
    ) AND NOT EXISTS (
      SELECT 1
      FROM "public"."refund_reporting_correction_sets" successor
      JOIN eligible_allocation_sets successor_anchor
        ON successor_anchor.id = successor.base_allocation_set_id
      WHERE successor.predecessor_correction_set_id = correction.id
    )
  ), correction_prevalidation AS (
    SELECT correction.*,
      correction_refund.payment_id AS refund_payment_id,
      correction_refund.currency AS refund_currency,
      correction_payment.order_id AS refund_order_id,
      CASE WHEN EXISTS (
        SELECT 1 FROM "public"."refund_reporting_correction_items" correction_item
        WHERE correction_item.correction_set_id = correction.id
      ) AND correction_refund.status = 'succeeded' AND
        correction_refund.currency = correction_payment.currency AND
        anchor.id IS NOT NULL AND anchor.tip_count = 1 AND
        anchor.basis = 'gross_amount'::"public"."financial_allocation_basis" AND
        anchor.source_kind = 'refund'::"public"."financial_allocation_source_kind" AND
        anchor.source_internal_id = correction.refund_id AND
        anchor.source_fingerprint_sha256 = correction.source_fingerprint_sha256
      THEN 0 ELSE 1 END::bigint AS invalid_refund_context_count,
      (
        SELECT pg_catalog.count(*)
        FROM "public"."refund_reporting_correction_items" correction_item
        LEFT JOIN eligible_base_tips item_source
          ON item_source.id = correction_item.source_allocation_set_id
        WHERE correction_item.correction_set_id = correction.id
          AND correction_item.domain = 'settlement'
          AND (item_source.id IS NULL OR item_source.tip_count <> 1 OR
            item_source.source_kind <> 'refund'::"public"."financial_allocation_source_kind" OR
            item_source.source_internal_id <> correction.refund_id OR
            item_source.source_fingerprint_sha256 <> correction.source_fingerprint_sha256 OR
            correction_item.currency <> item_source.currency OR
            (item_source.basis =
              'gross_amount'::"public"."financial_allocation_basis" AND
              correction_item.component NOT IN (
                'refund_subtotal'::"public"."financial_component",
                'refund_tax'::"public"."financial_component"
              )) OR
            (item_source.basis = 'fee'::"public"."financial_allocation_basis" AND
              correction_item.component <>
                'refund_fee'::"public"."financial_component") OR
            item_source.basis NOT IN (
              'gross_amount'::"public"."financial_allocation_basis",
              'fee'::"public"."financial_allocation_basis"
            ))
      ) AS invalid_settlement_source_count,
      (
        SELECT pg_catalog.count(*)
        FROM (
          SELECT correction_item.domain,
            correction_item.source_allocation_set_id, correction_item.currency
          FROM "public"."refund_reporting_correction_items" correction_item
          WHERE correction_item.correction_set_id = correction.id
          GROUP BY correction_item.domain,
            correction_item.source_allocation_set_id, correction_item.currency
          HAVING pg_catalog.sum(correction_item.delta_minor::bigint) <> 0
        ) invalid_delta_group
      ) AS invalid_delta_group_count,
      (
        SELECT pg_catalog.count(*)
        FROM "public"."refund_reporting_correction_items" correction_item
        LEFT JOIN eligible_base_tips item_source
          ON item_source.id = correction_item.source_allocation_set_id
        WHERE correction_item.correction_set_id = correction.id AND (
          NOT EXISTS (
            SELECT 1 FROM "public"."order_items" order_item
            WHERE order_item.id = correction_item.order_item_id
              AND order_item.order_id = correction_payment.order_id
              AND (correction_item.domain <> 'presentment' OR
                order_item.currency = correction_item.currency)
          ) OR (correction_item.domain = 'presentment' AND
            correction_item.currency <> correction_refund.currency) OR
          correction_item.stable_tie_break_key IS DISTINCT FROM CASE
            WHEN correction_item.domain = 'presentment' THEN
              'presentment:' || correction_item.order_item_id::text || ':' ||
                correction_item.component::text
            WHEN item_source.basis = 'gross_amount' THEN
              'settlement:gross:' || correction_item.order_item_id::text || ':' ||
                correction_item.component::text
            WHEN item_source.basis = 'fee' THEN
              'settlement:fee:' || correction_item.order_item_id::text || ':' ||
                correction_item.component::text
            ELSE NULL
          END
        )
      ) AS invalid_order_item_or_tie_count,
      (
        SELECT pg_catalog.count(*)
        FROM "public"."refund_reporting_correction_items" correction_item
        LEFT JOIN "public"."financial_item_allocations" base_item
          ON base_item.allocation_set_id = correction_item.source_allocation_set_id
         AND base_item.order_item_id = correction_item.order_item_id
         AND base_item.component = correction_item.component
        WHERE correction_item.correction_set_id = correction.id
          AND correction_item.domain = 'settlement' AND (
            correction_item.approved_absolute_minor::bigint <>
              COALESCE(base_item.effect_minor, 0)::bigint +
                correction_item.delta_minor::bigint OR
            (base_item.id IS NOT NULL AND base_item.currency <> correction_item.currency) OR
            (base_item.id IS NULL AND correction_item.approved_absolute_minor = 0)
          )
      ) AS invalid_settlement_arithmetic_count,
      (
        SELECT pg_catalog.count(*)
        FROM "public"."financial_item_allocations" base_item
        WHERE base_item.effect_minor <> 0 AND EXISTS (
          SELECT 1
          FROM "public"."refund_reporting_correction_items" source_item
          WHERE source_item.correction_set_id = correction.id
            AND source_item.domain = 'settlement'
            AND source_item.source_allocation_set_id = base_item.allocation_set_id
        ) AND NOT EXISTS (
          SELECT 1
          FROM "public"."refund_reporting_correction_items" correction_item
          WHERE correction_item.correction_set_id = correction.id
            AND correction_item.domain = 'settlement'
            AND correction_item.source_allocation_set_id = base_item.allocation_set_id
            AND correction_item.order_item_id = base_item.order_item_id
            AND correction_item.component = base_item.component
            AND correction_item.currency = base_item.currency
        )
      ) AS missing_settlement_base_count,
      (
        SELECT pg_catalog.count(*)
        FROM "public"."refund_reporting_correction_items" correction_item
        LEFT JOIN refund_presentment_components base_component
          ON base_component.refund_id = correction.refund_id
         AND base_component.order_item_id = correction_item.order_item_id
         AND base_component.component = correction_item.component
        WHERE correction_item.correction_set_id = correction.id
          AND correction_item.domain = 'presentment' AND (
            correction_item.approved_absolute_minor < 0 OR
            correction_item.approved_absolute_minor::bigint <>
              COALESCE(base_component.amount_minor, 0)::bigint +
                correction_item.delta_minor::bigint OR
            (base_component.refund_id IS NOT NULL AND
              base_component.currency <> correction_item.currency) OR
            (base_component.refund_id IS NULL AND
              correction_item.approved_absolute_minor = 0)
          )
      ) AS invalid_presentment_arithmetic_count,
      (
        SELECT pg_catalog.count(*)
        FROM refund_presentment_components base_component
        WHERE base_component.refund_id = correction.refund_id
          AND base_component.amount_minor <> 0 AND EXISTS (
            SELECT 1
            FROM "public"."refund_reporting_correction_items" presentment_item
            WHERE presentment_item.correction_set_id = correction.id
              AND presentment_item.domain = 'presentment'
          ) AND NOT EXISTS (
            SELECT 1
            FROM "public"."refund_reporting_correction_items" correction_item
            WHERE correction_item.correction_set_id = correction.id
              AND correction_item.domain = 'presentment'
              AND correction_item.order_item_id = base_component.order_item_id
              AND correction_item.component = base_component.component
              AND correction_item.currency = base_component.currency
          )
      ) AS missing_presentment_base_count
    FROM correction_tip_candidates correction
    JOIN "public"."refunds" correction_refund
      ON correction_refund.id = correction.refund_id
    JOIN "public"."payments" correction_payment
      ON correction_payment.id = correction_refund.payment_id
    LEFT JOIN eligible_base_tips anchor ON anchor.id = correction.base_allocation_set_id
  ), prevalidated_correction_tips AS (
    SELECT correction.*,
      (correction.invalid_refund_context_count +
       correction.invalid_settlement_source_count +
       correction.invalid_delta_group_count +
       correction.invalid_order_item_or_tie_count +
       correction.invalid_settlement_arithmetic_count +
       correction.missing_settlement_base_count +
       correction.invalid_presentment_arithmetic_count +
       correction.missing_presentment_base_count)::bigint AS invalid_noncapacity_count
    FROM correction_prevalidation correction
  ), effective_presentment_components AS (
    SELECT effective_refund.payment_id, base_component.refund_id,
      base_component.order_item_id, base_component.component,
      base_component.currency, base_component.amount_minor::bigint AS effect_minor
    FROM refund_presentment_components base_component
    JOIN "public"."refunds" effective_refund
      ON effective_refund.id = base_component.refund_id
    WHERE effective_refund.status = 'succeeded' AND NOT EXISTS (
      SELECT 1 FROM prevalidated_correction_tips correction
      WHERE correction.refund_id = base_component.refund_id
        AND correction.invalid_noncapacity_count = 0 AND EXISTS (
          SELECT 1
          FROM "public"."refund_reporting_correction_items" correction_item
          WHERE correction_item.correction_set_id = correction.id
            AND correction_item.domain = 'presentment'
        )
    )
    UNION ALL
    SELECT correction.refund_payment_id, correction.refund_id,
      correction_item.order_item_id, correction_item.component,
      correction_item.currency,
      correction_item.approved_absolute_minor::bigint AS effect_minor
    FROM prevalidated_correction_tips correction
    JOIN "public"."refund_reporting_correction_items" correction_item
      ON correction_item.correction_set_id = correction.id
     AND correction_item.domain = 'presentment'
    WHERE correction.invalid_noncapacity_count = 0
  ), presentment_capacity_status AS (
    SELECT effect.payment_id, effect.order_item_id, effect.component,
      effect.currency, pg_catalog.sum(effect.effect_minor)::bigint AS cumulative_effect_minor,
      CASE effect.component
        WHEN 'refund_subtotal'::"public"."financial_component"
          THEN order_item.unit_subtotal_minor
        WHEN 'refund_tax'::"public"."financial_component"
          THEN COALESCE(order_item.tax_minor, 0)
        ELSE 0
      END::bigint AS capacity_minor
    FROM effective_presentment_components effect
    JOIN "public"."order_items" order_item ON order_item.id = effect.order_item_id
    GROUP BY effect.payment_id, effect.order_item_id, effect.component,
      effect.currency, order_item.unit_subtotal_minor, order_item.tax_minor
  ), current_correction_tips AS (
    SELECT correction.*,
      (correction.invalid_noncapacity_count + (
        SELECT pg_catalog.count(*)
        FROM "public"."refund_reporting_correction_items" correction_item
        LEFT JOIN presentment_capacity_status capacity
          ON capacity.payment_id = correction.refund_payment_id
         AND capacity.order_item_id = correction_item.order_item_id
         AND capacity.component = correction_item.component
         AND capacity.currency = correction_item.currency
        WHERE correction_item.correction_set_id = correction.id
          AND correction_item.domain = 'presentment' AND (
            capacity.order_item_id IS NULL OR capacity.cumulative_effect_minor < 0 OR
            capacity.cumulative_effect_minor > capacity.capacity_minor
          )
      ))::bigint AS invalid_correction_count
    FROM prevalidated_correction_tips correction
  ), command_items AS (
    SELECT (item.value ->> 'orderItemId')::uuid AS order_item_id,
      (item.value ->> 'totalPresentmentMinor')::integer AS total_presentment_minor
    FROM pg_catalog.jsonb_array_elements(command_row.private_input -> 'items') item(value)
  ), raw_chain AS (
    SELECT correction.id, correction.predecessor_correction_set_id,
      correction.correction_version
    FROM "public"."refund_reporting_correction_sets" correction
    WHERE correction.id = correction_row.id
    UNION ALL
    SELECT predecessor.id, predecessor.predecessor_correction_set_id,
      predecessor.correction_version
    FROM "public"."refund_reporting_correction_sets" predecessor
    JOIN raw_chain successor ON predecessor.id = successor.predecessor_correction_set_id
  )
  SELECT (
    current_tip.id = correction_row.id AND current_tip.invalid_correction_count = 0 AND
    (SELECT pg_catalog.count(*) FROM active_projection_version) = 1 AND
    (SELECT pg_catalog.count(*) FROM raw_chain) = command_next_version AND
    (SELECT pg_catalog.count(*)
      FROM "public"."refund_reporting_correction_sets" correction
      WHERE correction.refund_id = command_refund_id) = command_next_version AND
    (SELECT pg_catalog.min(correction_version) FROM raw_chain) = 1 AND
    (SELECT pg_catalog.max(correction_version) FROM raw_chain) = command_next_version AND
    NOT EXISTS (
      SELECT 1 FROM raw_chain chain
      WHERE (chain.correction_version = 1) IS DISTINCT FROM
        (chain.predecessor_correction_set_id IS NULL)
    ) AND NOT EXISTS (
      SELECT 1 FROM "public"."refund_reporting_correction_sets" successor
      WHERE successor.predecessor_correction_set_id = correction_row.id
    ) AND (
      (command_next_version = 1 AND correction_row.predecessor_correction_set_id IS NULL) OR
      EXISTS (
        SELECT 1 FROM "public"."refund_reporting_correction_sets" predecessor
        WHERE predecessor.id = correction_row.predecessor_correction_set_id
          AND predecessor.refund_id = command_refund_id
          AND predecessor.correction_version = command_next_version - 1
      )
    ) AND
    (SELECT pg_catalog.count(*) FROM command_items) = (
      SELECT pg_catalog.count(*) FROM "public"."order_items" order_item
      JOIN "public"."payments" payment ON payment.order_id = order_item.order_id
      JOIN "public"."refunds" refund ON refund.payment_id = payment.id
      WHERE refund.id = command_refund_id
    ) AND NOT EXISTS (
      SELECT 1 FROM command_items requested
      LEFT JOIN "public"."order_items" order_item ON order_item.id = requested.order_item_id
      LEFT JOIN "public"."payments" payment ON payment.order_id = order_item.order_id
      LEFT JOIN "public"."refunds" refund
        ON refund.payment_id = payment.id AND refund.id = command_refund_id
      WHERE refund.id IS NULL OR requested.total_presentment_minor IS DISTINCT FROM (
        SELECT COALESCE(
          pg_catalog.sum(correction_item.approved_absolute_minor), 0
        )::integer
        FROM "public"."refund_reporting_correction_items" correction_item
        WHERE correction_item.correction_set_id = correction_row.id
          AND correction_item.domain = 'presentment'
          AND correction_item.order_item_id = requested.order_item_id
      )
    ) AND (SELECT pg_catalog.sum(total_presentment_minor) FROM command_items) = (
      SELECT refund.amount_minor FROM "public"."refunds" refund
      WHERE refund.id = command_refund_id AND refund.status = 'succeeded'
    )
  ) IS TRUE INTO correction_is_compatible
  FROM current_correction_tips current_tip
  WHERE current_tip.id = correction_row.id;

  IF correction_is_compatible IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'reporting correction compatibility proof failed';
  END IF;

  SELECT * INTO issue_row
  FROM "public"."financial_reconciliation_issues" issue
  WHERE issue.id = requested_issue_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'financial issue is outside the reporting-correction command scope';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(
    'pale-orbit:financial:issue:' || issue_row.resource_type || ':' ||
      issue_row.resource_id::text || ':' || issue_row.safe_code
  ));
  SELECT * INTO issue_row
  FROM "public"."financial_reconciliation_issues" issue
  WHERE issue.id = requested_issue_id
  FOR UPDATE;
  WITH RECURSIVE current_selected_set_lineage(id) AS (
    SELECT selected_set.id
    FROM "public"."financial_allocation_sets" selected_set
    WHERE issue_row.resource_type = 'allocation_set'
      AND selected_set.id = issue_row.resource_id
      AND selected_set.source_kind = 'refund'
      AND selected_set.source_internal_id = command_refund_id
    UNION ALL
    SELECT successor.id
    FROM "public"."financial_allocation_sets" successor
    JOIN current_selected_set_lineage predecessor
      ON successor.supersedes_set_id = predecessor.id
    WHERE successor.source_kind = 'refund'
      AND successor.source_internal_id = command_refund_id
  ), current_refund_sets AS MATERIALIZED (
    SELECT allocation_set.id
    FROM "public"."financial_allocation_sets" allocation_set
    JOIN "public"."financial_projection_versions" projection_version
      ON projection_version.singleton = true
     AND projection_version.pending_classifier_version IS NULL
     AND projection_version.pending_allocation_algorithm_version IS NULL
     AND projection_version.pending_replay_id IS NULL
     AND projection_version.pending_scan_run_id IS NULL
     AND allocation_set.classifier_version = projection_version.classifier_version
     AND allocation_set.algorithm_version =
       projection_version.allocation_algorithm_version
    WHERE allocation_set.source_kind = 'refund'
      AND allocation_set.source_internal_id = command_refund_id
      AND NOT EXISTS (
        SELECT 1 FROM "public"."financial_allocation_sets" successor
        WHERE successor.supersedes_set_id = allocation_set.id
      )
  )
  SELECT (
    issue_row.state = 'open' AND issue_row.safe_code IN (
      'allocation_fork', 'allocation_incomplete', 'allocation_mismatch',
      'classification_fork', 'correction_rebase_required', 'currency_mismatch',
      'immutable_mismatch', 'missing_source', 'source_linkage_mismatch'
    ) AND (
      (issue_row.resource_type = 'refund' AND
        issue_row.resource_id = command_refund_id) OR
      (issue_row.resource_type = 'allocation_set' AND EXISTS (
        SELECT 1 FROM current_selected_set_lineage lineage
        JOIN current_refund_sets current_set ON current_set.id = lineage.id
      ))
    )
  ) IS TRUE INTO allowlisted_issue;
  IF allowlisted_issue IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'financial issue is outside the reporting-correction command scope';
  END IF;

  PERFORM pg_catalog.set_config(
    'pale_orbit.plan6bii_financial_admin_issue_resolution_command_id',
    command_row.id::text, true
  );
  PERFORM pg_catalog.set_config(
    'pale_orbit.plan6bii_financial_admin_issue_resolution_issue_id',
    issue_row.id::text, true
  );
  PERFORM pg_catalog.set_config(
    'pale_orbit.plan6bii_financial_admin_issue_resolution_actor_id',
    command_row.actor_user_id::text, true
  );
  UPDATE "public"."financial_reconciliation_issues"
  SET state = 'resolved', resolved_by_admin_id = command_row.actor_user_id,
    resolved_at = pg_catalog.clock_timestamp()
  WHERE id = issue_row.id AND state = 'open'
  RETURNING * INTO resolved_issue;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  INSERT INTO "public"."audit_events" (
    actor_type, actor_id, action, outcome, resource_type, resource_id,
    correlation_id, after
  ) VALUES (
    'user'::"public"."audit_actor_type", command_row.actor_user_id::text,
    'financial.issue.resolved', 'succeeded'::"public"."audit_outcome",
    'financial_issue', resolved_issue.id::text, command_row.correlation_id,
    pg_catalog.jsonb_build_object(
      'resourceType', resolved_issue.resource_type,
      'resourceId', resolved_issue.resource_id,
      'safeCode', resolved_issue.safe_code,
      'impact', resolved_issue.impact,
      'state', resolved_issue.state,
      'occurrenceCount', resolved_issue.occurrence_count,
      'commandId', command_row.id
    )
  );
  RETURN NEXT resolved_issue;
  RETURN;
END;
$reporting_correction_issue_resolution$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "public"."resolve_financial_issue_after_reporting_correction_command"(uuid,uuid) FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."resolve_financial_issue_after_reporting_correction_command"(uuid,uuid) TO "pale_orbit_financial_worker";--> statement-breakpoint

DO $plan6bii_reporting_correction_postflight$
DECLARE
  database_owner oid;
  expected_web_login text;
  expected_worker_login text;
  expected_storage_cleanup_login text;
  routine_oid oid;
BEGIN
  SELECT database_row.datdba INTO database_owner
  FROM pg_catalog.pg_database database_row
  WHERE database_row.datname = pg_catalog.current_database();
  expected_web_login := pg_catalog.current_setting(
    'pale_orbit.migration_expected_web_login', true
  );
  expected_worker_login := pg_catalog.current_setting(
    'pale_orbit.migration_expected_worker_login', true
  );
  expected_storage_cleanup_login := pg_catalog.current_setting(
    'pale_orbit.migration_expected_storage_cleanup_login', true
  );
  routine_oid := pg_catalog.to_regprocedure(
    'public.resolve_financial_issue_after_reporting_correction_command(uuid,uuid)'
  )::oid;

  IF routine_oid IS NULL OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc routine
    WHERE routine.oid = routine_oid AND (
      routine.proowner <> database_owner OR NOT routine.prosecdef OR
      routine.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[] OR
      routine.prokind <> 'f' OR routine.provolatile <> 'v'
    )
  ) OR EXISTS (
    WITH actual_acl AS (
      SELECT privilege.grantee, privilege.grantor,
        privilege.privilege_type::text, privilege.is_grantable
      FROM pg_catalog.pg_proc routine
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
        routine.proacl, pg_catalog.acldefault('f', routine.proowner)
      )) privilege
      WHERE routine.oid = routine_oid
    ), expected_acl(grantee, grantor, privilege_type, is_grantable) AS (
      VALUES
        (database_owner, database_owner, 'EXECUTE'::text, false),
        ('pale_orbit_financial_worker'::pg_catalog.regrole::oid,
          database_owner, 'EXECUTE'::text, false)
    ), acl_delta AS (
      (SELECT * FROM actual_acl EXCEPT ALL SELECT * FROM expected_acl)
      UNION ALL
      (SELECT * FROM expected_acl EXCEPT ALL SELECT * FROM actual_acl)
    )
    SELECT 1 FROM acl_delta
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 6B-II reporting-correction routine authority postflight failed';
  END IF;
END;
$plan6bii_reporting_correction_postflight$;
