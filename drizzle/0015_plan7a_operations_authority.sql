DO $plan7a_operations_authority_preflight$
DECLARE
  database_oid oid;
  database_owner oid;
  database_owner_name name;
  expected_web_login text;
  expected_worker_login text;
  expected_storage_cleanup_login text;
  actual_job_guard_sha256 text;
  actual_audit_guard_sha256 text;
  transition_oid oid;
  actual_definition_sha256 text;
  actual_predecessor_acl_sha256 text;
  actual_predecessor_storage_sha256 text;
BEGIN
  SELECT database_row.oid, database_row.datdba,
    pg_catalog.pg_get_userbyid(database_row.datdba)
  INTO database_oid, database_owner, database_owner_name
  FROM pg_catalog.pg_database database_row
  WHERE database_row.datname = pg_catalog.current_database();

  IF database_owner IS NULL OR current_user IS DISTINCT FROM database_owner_name OR
    pg_catalog.current_setting('session_replication_role') IS DISTINCT FROM 'origin' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 7A operations authority requires canonical owner authority';
  END IF;

  IF pg_catalog.current_schema() IS DISTINCT FROM 'public' OR
    pg_catalog.current_schemas(false) IS DISTINCT FROM ARRAY['public']::name[] THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 7A operations authority search path is not canonical';
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
      MESSAGE = 'Plan 7A operations authority login identity is not canonical';
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
      MESSAGE = 'Plan 7A operations authority role membership is not canonical';
  END IF;

  IF EXISTS (
    WITH protected_principal(role_oid) AS (
      SELECT role_row.oid
      FROM pg_catalog.pg_roles role_row
      WHERE role_row.rolname IN (
        'pale_orbit_runtime', 'pale_orbit_financial_worker',
        'pale_orbit_storage_cleanup', expected_web_login,
        expected_worker_login, expected_storage_cleanup_login
      )
    ), unsafe_session_replication_default AS (
      SELECT 1
      FROM pg_catalog.pg_db_role_setting setting_row
      CROSS JOIN LATERAL pg_catalog.unnest(setting_row.setconfig) configured_setting(value)
      WHERE setting_row.setrole IN (0::oid, database_owner) AND
        setting_row.setdatabase IN (0::oid, database_oid) AND
        pg_catalog.split_part(configured_setting.value, '=', 1) =
          'session_replication_role' AND
        pg_catalog.split_part(configured_setting.value, '=', 2) IS DISTINCT FROM 'origin'
    ), unsafe_operations_setting_default AS (
      SELECT 1
      FROM pg_catalog.pg_db_role_setting setting_row
      CROSS JOIN LATERAL pg_catalog.unnest(setting_row.setconfig) configured_setting(value)
      WHERE (setting_row.setrole = 0 OR setting_row.setrole = database_owner OR
          setting_row.setrole IN (SELECT role_oid FROM protected_principal)) AND
        pg_catalog.split_part(configured_setting.value, '=', 1) = ANY(ARRAY[
          'pale_orbit.plan7a_operations_command_insert_id',
          'pale_orbit.plan7a_operations_command_transition_id',
          'pale_orbit.plan7a_operations_job_transition_id',
          'pale_orbit.plan7a_operations_job_capability'
        ]::text[])
    ), unsafe_parameter_acl AS (
      SELECT 1
      FROM pg_catalog.pg_parameter_acl parameter_acl
      CROSS JOIN LATERAL pg_catalog.aclexplode(parameter_acl.paracl) privilege
      WHERE privilege.grantee = 0 OR privilege.grantee IN (
        SELECT role_oid FROM protected_principal
      )
    ), actual_default_acl_identity(role_oid, namespace_oid, object_type) AS (
      SELECT default_acl.defaclrole, default_acl.defaclnamespace,
        default_acl.defaclobjtype
      FROM pg_catalog.pg_default_acl default_acl
    ), expected_default_acl_identity(role_oid, namespace_oid, object_type) AS (
      VALUES
        (database_owner, 0::oid, 'f'::"char"),
        (database_owner, 'public'::pg_catalog.regnamespace::oid, 'S'::"char"),
        (database_owner, 'public'::pg_catalog.regnamespace::oid, 'r'::"char")
    ), default_acl_identity_delta AS (
      (SELECT * FROM actual_default_acl_identity
       EXCEPT ALL SELECT * FROM expected_default_acl_identity)
      UNION ALL
      (SELECT * FROM expected_default_acl_identity
       EXCEPT ALL SELECT * FROM actual_default_acl_identity)
    ), actual_default_acl_privilege(
      role_oid, namespace_oid, object_type, grantee, grantor,
      privilege_type, is_grantable
    ) AS (
      SELECT default_acl.defaclrole, default_acl.defaclnamespace,
        default_acl.defaclobjtype, privilege.grantee, privilege.grantor,
        privilege.privilege_type::text, privilege.is_grantable
      FROM pg_catalog.pg_default_acl default_acl
      CROSS JOIN LATERAL pg_catalog.aclexplode(default_acl.defaclacl) privilege
    ), expected_default_acl_privilege(
      role_oid, namespace_oid, object_type, grantee, grantor,
      privilege_type, is_grantable
    ) AS (
      VALUES
        (database_owner, 0::oid, 'f'::"char", database_owner, database_owner,
          'EXECUTE'::text, false),
        (database_owner, 'public'::pg_catalog.regnamespace::oid, 'S'::"char",
          'pale_orbit_runtime'::pg_catalog.regrole::oid, database_owner,
          'SELECT'::text, false),
        (database_owner, 'public'::pg_catalog.regnamespace::oid, 'S'::"char",
          'pale_orbit_runtime'::pg_catalog.regrole::oid, database_owner,
          'UPDATE'::text, false),
        (database_owner, 'public'::pg_catalog.regnamespace::oid, 'S'::"char",
          'pale_orbit_runtime'::pg_catalog.regrole::oid, database_owner,
          'USAGE'::text, false),
        (database_owner, 'public'::pg_catalog.regnamespace::oid, 'r'::"char",
          'pale_orbit_runtime'::pg_catalog.regrole::oid, database_owner,
          'SELECT'::text, false)
    ), default_acl_privilege_delta AS (
      (SELECT * FROM actual_default_acl_privilege
       EXCEPT ALL SELECT * FROM expected_default_acl_privilege)
      UNION ALL
      (SELECT * FROM expected_default_acl_privilege
       EXCEPT ALL SELECT * FROM actual_default_acl_privilege)
    )
    SELECT 1 FROM unsafe_session_replication_default
    UNION ALL SELECT 1 FROM unsafe_operations_setting_default
    UNION ALL SELECT 1 FROM unsafe_parameter_acl
    UNION ALL SELECT 1 FROM default_acl_identity_delta
    UNION ALL SELECT 1 FROM default_acl_privilege_delta
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 7A operations authority settings are not canonical';
  END IF;

  IF EXISTS (
    WITH expected_routine(routine_name, signature, definition_sha256) AS (
      VALUES
        ('resolve_financial_issue_after_worker_recompute'::text,
          'public.resolve_financial_issue_after_worker_recompute(uuid,text)'::text,
          '7a9238d3e448d2b528b252276c55f9b69131e335b8f68865597e85b6afde765e'::text),
        ('resolve_financial_issue_after_admin_command'::text,
          'public.resolve_financial_issue_after_admin_command(uuid,uuid)'::text,
          '87085fe791b4f54ef2f3b950a7163f1bdaa144922e1c681df1d2d683737f90c4'::text),
        ('resolve_financial_issue_after_reporting_correction_command'::text,
          'public.resolve_financial_issue_after_reporting_correction_command(uuid,uuid)'::text,
          'c6e086b30db8e85c5bc38107ceab36f4b41ad5c5a152e75b5e862c607c3a60e8'::text)
    ), resolved_routine AS (
      SELECT expected.signature, expected.definition_sha256,
        pg_catalog.to_regprocedure(expected.signature)::oid AS routine_oid
      FROM expected_routine expected
    ), invalid_shape AS (
      SELECT resolved.signature
      FROM resolved_routine resolved
      LEFT JOIN pg_catalog.pg_proc routine ON routine.oid = resolved.routine_oid
      LEFT JOIN pg_catalog.pg_language language_row ON language_row.oid = routine.prolang
      WHERE routine.oid IS NULL OR routine.proowner <> database_owner OR
        routine.prokind <> 'f' OR routine.provolatile <> 'v' OR
        routine.proparallel <> 'u' OR NOT routine.prosecdef OR
        routine.proleakproof OR routine.proisstrict OR
        routine.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[] OR
        language_row.lanname IS DISTINCT FROM 'plpgsql' OR
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          pg_catalog.replace(pg_catalog.replace(
            pg_catalog.pg_get_functiondef(routine.oid), E'\r\n', E'\n'
          ), E'\r', E'\n'), 'UTF8'
        )), 'hex') IS DISTINCT FROM resolved.definition_sha256
    ), invalid_overload_inventory AS (
      SELECT expected.routine_name
      FROM expected_routine expected
      LEFT JOIN pg_catalog.pg_namespace namespace_row
        ON namespace_row.nspname = 'public'
      LEFT JOIN pg_catalog.pg_proc routine
        ON routine.pronamespace = namespace_row.oid
       AND routine.proname = expected.routine_name
      GROUP BY expected.routine_name
      HAVING pg_catalog.count(routine.oid) <> 1
    ), actual_acl AS (
      SELECT resolved.signature, privilege.grantee, privilege.grantor,
        privilege.privilege_type::text, privilege.is_grantable
      FROM resolved_routine resolved
      JOIN pg_catalog.pg_proc routine ON routine.oid = resolved.routine_oid
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
        routine.proacl, pg_catalog.acldefault('f', routine.proowner)
      )) privilege
    ), expected_acl(signature, grantee, grantor, privilege_type, is_grantable) AS (
      SELECT resolved.signature, database_owner, database_owner, 'EXECUTE'::text, false
      FROM resolved_routine resolved
      UNION ALL
      SELECT resolved.signature,
        'pale_orbit_financial_worker'::pg_catalog.regrole::oid,
        database_owner, 'EXECUTE'::text, false
      FROM resolved_routine resolved
    ), acl_delta AS (
      (SELECT * FROM actual_acl EXCEPT ALL SELECT * FROM expected_acl)
      UNION ALL
      (SELECT * FROM expected_acl EXCEPT ALL SELECT * FROM actual_acl)
    )
    SELECT 1 FROM invalid_shape
    UNION ALL SELECT 1 FROM invalid_overload_inventory
    UNION ALL SELECT 1 FROM acl_delta
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 6B-II issue-transition repair resolver authority is not canonical';
  END IF;

  transition_oid := pg_catalog.to_regprocedure(
    'public.plan6b_validate_issue_transition()'
  )::oid;

  IF transition_oid IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc routine
    JOIN pg_catalog.pg_language language_row ON language_row.oid = routine.prolang
    WHERE routine.oid = transition_oid
      AND routine.proowner = database_owner
      AND routine.prokind = 'f'
      AND routine.provolatile = 'v'
      AND routine.proparallel = 'u'
      AND NOT routine.prosecdef
      AND NOT routine.proleakproof
      AND NOT routine.proisstrict
      AND NOT routine.proretset
      AND routine.proconfig IS NULL
      AND routine.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
      AND routine.pronargs = 0
      AND routine.pronargdefaults = 0
      AND language_row.lanname = 'plpgsql'
  ) OR EXISTS (
    WITH actual_acl AS (
      SELECT privilege.grantee, privilege.grantor,
        privilege.privilege_type::text, privilege.is_grantable
      FROM pg_catalog.pg_proc routine
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
        routine.proacl, pg_catalog.acldefault('f', routine.proowner)
      )) privilege
      WHERE routine.oid = transition_oid
    ), expected_acl(grantee, grantor, privilege_type, is_grantable) AS (
      VALUES (database_owner, database_owner, 'EXECUTE'::text, false)
    ), acl_delta AS (
      (SELECT * FROM actual_acl EXCEPT ALL SELECT * FROM expected_acl)
      UNION ALL
      (SELECT * FROM expected_acl EXCEPT ALL SELECT * FROM actual_acl)
    )
    SELECT 1 FROM acl_delta
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(ARRAY[
      'public.jobs',
      'public.audit_events',
      'public.financial_admin_commands',
      'public.financial_allocation_sets',
      'public.financial_reconciliation_issues'
    ]::text[]) prerequisite(relation_name)
    LEFT JOIN pg_catalog.pg_class relation_row
      ON relation_row.oid = pg_catalog.to_regclass(prerequisite.relation_name)
    LEFT JOIN pg_catalog.pg_namespace namespace_row
      ON namespace_row.oid = relation_row.relnamespace
    WHERE relation_row.oid IS NULL OR relation_row.relowner <> database_owner OR
      relation_row.relkind <> 'r' OR relation_row.relpersistence <> 'p' OR
      relation_row.relispartition OR relation_row.relrowsecurity OR
      relation_row.relforcerowsecurity OR
      namespace_row.nspname IS DISTINCT FROM 'public' OR
      namespace_row.nspowner NOT IN (
        database_owner, 'pg_database_owner'::pg_catalog.regrole
      )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc routine
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = routine.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND routine.proname = 'plan6b_validate_issue_transition'
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger trigger_row
    WHERE trigger_row.tgrelid =
        'public.financial_reconciliation_issues'::pg_catalog.regclass
      AND trigger_row.tgname = 'financial_reconciliation_issues_narrow_update'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgfoid = transition_oid
      AND trigger_row.tgtype = 27::smallint
      AND trigger_row.tgnargs = 0
      AND pg_catalog.encode(trigger_row.tgargs, 'hex') = ''
      AND trigger_row.tgattr::text = ''
      AND trigger_row.tgqual IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger trigger_row
    WHERE trigger_row.tgfoid = transition_oid
      AND NOT trigger_row.tgisinternal
      AND (
        trigger_row.tgrelid IS DISTINCT FROM
          'public.financial_reconciliation_issues'::pg_catalog.regclass OR
        trigger_row.tgname IS DISTINCT FROM
          'financial_reconciliation_issues_narrow_update'
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 6B-II issue-transition repair prerequisite authority is not canonical';
  END IF;

  LOCK TABLE "public"."jobs" IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE "public"."audit_events" IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE "public"."financial_admin_commands" IN EXCLUSIVE MODE;
  LOCK TABLE "public"."financial_allocation_sets",
    "public"."financial_reconciliation_issues" IN SHARE ROW EXCLUSIVE MODE;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(ARRAY[
      'public.financial_admin_commands',
      'public.financial_allocation_sets',
      'public.financial_reconciliation_issues',
      'public.audit_events'
    ]::text[]) prerequisite(relation_name)
    LEFT JOIN pg_catalog.pg_class relation_row
      ON relation_row.oid = pg_catalog.to_regclass(prerequisite.relation_name)
    LEFT JOIN pg_catalog.pg_namespace namespace_row
      ON namespace_row.oid = relation_row.relnamespace
    WHERE relation_row.oid IS NULL OR relation_row.relowner <> database_owner OR
      relation_row.relkind <> 'r' OR relation_row.relpersistence <> 'p' OR
      relation_row.relispartition OR relation_row.relrowsecurity OR
      relation_row.relforcerowsecurity OR
      namespace_row.nspname IS DISTINCT FROM 'public' OR
      namespace_row.nspowner NOT IN (
        database_owner, 'pg_database_owner'::pg_catalog.regrole
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 6B-II issue-transition repair locked relation is not canonical';
  END IF;

  IF EXISTS (
    WITH expected_routine(
      routine_name, signature, expected_config, expected_security_definer,
      definition_sha256
    ) AS (
      VALUES
        ('plan6b_guard_audit_insert'::text,
          'public.plan6b_guard_audit_insert()'::text,
          ARRAY['search_path=pg_catalog']::text[],
          false,
          'f0373a347c369035f1c8b68d6eb4238a33612b0fa6e82e2ecfaa0ebf10e0696b'::text),
        ('reject_audit_event_mutation'::text,
          'public.reject_audit_event_mutation()'::text, NULL::text[],
          false,
          'bab4c3832060ba371da911deb57c88258a8be93141301552889b03bb9c313634'::text),
        ('plan6b_validate_issue_insert'::text,
          'public.plan6b_validate_issue_insert()'::text, NULL::text[],
          false,
          'f3691d9c661abe6ec369f784e99395a05dc10247f704dd282445457b8346fb96'::text),
        ('plan6bii_guard_financial_admin_command_update'::text,
          'public.plan6bii_guard_financial_admin_command_update()'::text,
          ARRAY['search_path=pg_catalog']::text[], true,
          '1b4835de9ab460e0e55a6a82a42cc5646131bf3c78f59ed37c91e1f2160b1588'::text),
        ('plan6bii_guard_financial_admin_command_delete'::text,
          'public.plan6bii_guard_financial_admin_command_delete()'::text,
          ARRAY['search_path=pg_catalog']::text[], true,
          '26d19d45231662b9ec352269be5a1db7f61e832876eecffc3fbce50eb5ab23b6'::text)
    ), resolved_routine AS (
      SELECT expected.*, pg_catalog.to_regprocedure(expected.signature)::oid AS routine_oid
      FROM expected_routine expected
    ), invalid_shape AS (
      SELECT resolved.signature
      FROM resolved_routine resolved
      LEFT JOIN pg_catalog.pg_proc routine ON routine.oid = resolved.routine_oid
      LEFT JOIN pg_catalog.pg_language language_row ON language_row.oid = routine.prolang
      WHERE routine.oid IS NULL OR routine.proowner <> database_owner OR
        routine.prokind <> 'f' OR routine.provolatile <> 'v' OR
        routine.proparallel <> 'u' OR
        routine.prosecdef IS DISTINCT FROM resolved.expected_security_definer OR
        routine.proleakproof OR routine.proisstrict OR routine.proretset OR
        routine.proconfig IS DISTINCT FROM resolved.expected_config OR
        routine.prorettype IS DISTINCT FROM 'pg_catalog.trigger'::pg_catalog.regtype OR
        routine.pronargs <> 0 OR routine.pronargdefaults <> 0 OR
        language_row.lanname IS DISTINCT FROM 'plpgsql' OR
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          pg_catalog.replace(pg_catalog.replace(
            pg_catalog.pg_get_functiondef(routine.oid), E'\r\n', E'\n'
          ), E'\r', E'\n'), 'UTF8'
        )), 'hex') IS DISTINCT FROM resolved.definition_sha256
    ), invalid_overload_inventory AS (
      SELECT expected.routine_name
      FROM expected_routine expected
      LEFT JOIN pg_catalog.pg_namespace namespace_row
        ON namespace_row.nspname = 'public'
      LEFT JOIN pg_catalog.pg_proc routine
        ON routine.pronamespace = namespace_row.oid
       AND routine.proname = expected.routine_name
      GROUP BY expected.routine_name
      HAVING pg_catalog.count(routine.oid) <> 1
    ), actual_acl AS (
      SELECT resolved.signature, privilege.grantee, privilege.grantor,
        privilege.privilege_type::text, privilege.is_grantable
      FROM resolved_routine resolved
      JOIN pg_catalog.pg_proc routine ON routine.oid = resolved.routine_oid
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
        routine.proacl, pg_catalog.acldefault('f', routine.proowner)
      )) privilege
    ), expected_acl(signature, grantee, grantor, privilege_type, is_grantable) AS (
      SELECT resolved.signature, database_owner, database_owner, 'EXECUTE'::text, false
      FROM resolved_routine resolved
    ), acl_delta AS (
      (SELECT * FROM actual_acl EXCEPT ALL SELECT * FROM expected_acl)
      UNION ALL
      (SELECT * FROM expected_acl EXCEPT ALL SELECT * FROM actual_acl)
    )
    SELECT 1 FROM invalid_shape
    UNION ALL SELECT 1 FROM invalid_overload_inventory
    UNION ALL SELECT 1 FROM acl_delta
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 6B-II issue-transition repair guard authority is not canonical';
  END IF;

  IF EXISTS (
    WITH expected_trigger_inventory(
      trigger_name, relation_oid, routine_oid, enabled_mode, trigger_type,
      argument_count, argument_bytes, updated_columns, has_no_qualifier
    ) AS (
      VALUES
        ('audit_events_plan6b_web_insert_guard'::name,
          'public.audit_events'::pg_catalog.regclass::oid,
          'public.plan6b_guard_audit_insert()'::pg_catalog.regprocedure::oid,
          'O'::"char", 7::smallint, 0::smallint, ''::text, ''::text, true),
        ('audit_events_reject_update'::name,
          'public.audit_events'::pg_catalog.regclass::oid,
          'public.reject_audit_event_mutation()'::pg_catalog.regprocedure::oid,
          'O'::"char", 19::smallint, 0::smallint, ''::text, ''::text, true),
        ('audit_events_reject_delete'::name,
          'public.audit_events'::pg_catalog.regclass::oid,
          'public.reject_audit_event_mutation()'::pg_catalog.regprocedure::oid,
          'O'::"char", 11::smallint, 0::smallint, ''::text, ''::text, true),
        ('financial_reconciliation_issues_validate_insert'::name,
          'public.financial_reconciliation_issues'::pg_catalog.regclass::oid,
          'public.plan6b_validate_issue_insert()'::pg_catalog.regprocedure::oid,
          'O'::"char", 7::smallint, 0::smallint, ''::text, ''::text, true),
        ('financial_reconciliation_issues_narrow_update'::name,
          'public.financial_reconciliation_issues'::pg_catalog.regclass::oid,
          'public.plan6b_validate_issue_transition()'::pg_catalog.regprocedure::oid,
          'O'::"char", 27::smallint, 0::smallint, ''::text, ''::text, true),
        ('financial_admin_commands_plan6bii_update_guard'::name,
          'public.financial_admin_commands'::pg_catalog.regclass::oid,
          'public.plan6bii_guard_financial_admin_command_update()'::pg_catalog.regprocedure::oid,
          'O'::"char", 19::smallint, 0::smallint, ''::text, ''::text, true),
        ('financial_admin_commands_plan6bii_delete_guard'::name,
          'public.financial_admin_commands'::pg_catalog.regclass::oid,
          'public.plan6bii_guard_financial_admin_command_delete()'::pg_catalog.regprocedure::oid,
          'O'::"char", 11::smallint, 0::smallint, ''::text, ''::text, true)
    ), actual_trigger_inventory AS (
      SELECT trigger_row.tgname, trigger_row.tgrelid, trigger_row.tgfoid,
        trigger_row.tgenabled, trigger_row.tgtype, trigger_row.tgnargs,
        pg_catalog.encode(trigger_row.tgargs, 'hex'), trigger_row.tgattr::text,
        trigger_row.tgqual IS NULL
      FROM pg_catalog.pg_trigger trigger_row
      WHERE trigger_row.tgrelid IN (
        'public.financial_admin_commands'::pg_catalog.regclass,
        'public.audit_events'::pg_catalog.regclass,
        'public.financial_reconciliation_issues'::pg_catalog.regclass
      ) AND NOT trigger_row.tgisinternal
    ), trigger_inventory_delta AS (
      (SELECT * FROM actual_trigger_inventory EXCEPT ALL
       SELECT * FROM expected_trigger_inventory)
      UNION ALL
      (SELECT * FROM expected_trigger_inventory EXCEPT ALL
       SELECT * FROM actual_trigger_inventory)
    )
    SELECT 1 FROM trigger_inventory_delta
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite rule_row
    WHERE rule_row.ev_class IN (
      'public.financial_admin_commands'::pg_catalog.regclass,
      'public.financial_allocation_sets'::pg_catalog.regclass,
      'public.audit_events'::pg_catalog.regclass,
      'public.financial_reconciliation_issues'::pg_catalog.regclass
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits inheritance_row
    WHERE inheritance_row.inhparent IN (
      'public.financial_admin_commands'::pg_catalog.regclass,
      'public.financial_allocation_sets'::pg_catalog.regclass,
      'public.audit_events'::pg_catalog.regclass,
      'public.financial_reconciliation_issues'::pg_catalog.regclass
    ) OR inheritance_row.inhrelid IN (
      'public.financial_admin_commands'::pg_catalog.regclass,
      'public.financial_allocation_sets'::pg_catalog.regclass,
      'public.audit_events'::pg_catalog.regclass,
      'public.financial_reconciliation_issues'::pg_catalog.regclass
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 6B-II issue-transition repair trigger authority is not canonical';
  END IF;

  SELECT pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.replace(pg_catalog.replace(
        pg_catalog.pg_get_functiondef(transition_oid), E'\r\n', E'\n'
      ), E'\r', E'\n'), 'UTF8'
    )), 'hex'
  ) INTO actual_definition_sha256;

  IF actual_definition_sha256 IS DISTINCT FROM
    'a921aec3b466cdcdc47b6583065d171179d816159d25ec634c57521a7e0f2c81' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 6B-II issue-transition repair predecessor definition is not canonical';
  END IF;


  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(ARRAY[
      'public.user', 'public.user_roles', 'public.jobs', 'public.audit_events'
    ]::text[]) prerequisite(relation_name)
    LEFT JOIN pg_catalog.pg_class relation_row
      ON relation_row.oid = pg_catalog.to_regclass(prerequisite.relation_name)
    LEFT JOIN pg_catalog.pg_namespace namespace_row
      ON namespace_row.oid = relation_row.relnamespace
    WHERE relation_row.oid IS NULL OR relation_row.relowner <> database_owner OR
      relation_row.relkind <> 'r' OR relation_row.relpersistence <> 'p' OR
      relation_row.relispartition OR relation_row.relrowsecurity OR
      relation_row.relforcerowsecurity OR namespace_row.nspname IS DISTINCT FROM 'public' OR
      namespace_row.nspowner NOT IN (
        database_owner, 'pg_database_owner'::pg_catalog.regrole
      )
  ) OR EXISTS (
    WITH expected_jobs_trigger(
      trigger_name, routine_oid, enabled_mode, trigger_type,
      argument_count, argument_bytes, updated_columns, has_no_qualifier
    ) AS (
      VALUES
        ('jobs_plan6b_web_insert_guard'::name,
          'public.plan6b_guard_job_insert()'::pg_catalog.regprocedure::oid,
          'O'::"char", 7::smallint, 0::smallint, ''::text, ''::text, true),
        ('jobs_plan6bii_financial_admin_lease_guard'::name,
          'public.plan6bii_guard_financial_admin_job_lease()'::pg_catalog.regprocedure::oid,
          'O'::"char", 19::smallint, 0::smallint, ''::text, ''::text, true),
        ('jobs_plan6bii_financial_admin_terminal_sync'::name,
          'public.plan6bii_sync_failed_financial_admin_command()'::pg_catalog.regprocedure::oid,
          'O'::"char", 19::smallint, 0::smallint, ''::text, ''::text, true)
    ), actual_jobs_trigger AS (
      SELECT trigger_row.tgname, trigger_row.tgfoid, trigger_row.tgenabled,
        trigger_row.tgtype, trigger_row.tgnargs,
        pg_catalog.encode(trigger_row.tgargs, 'hex'), trigger_row.tgattr::text,
        trigger_row.tgqual IS NULL
      FROM pg_catalog.pg_trigger trigger_row
      WHERE trigger_row.tgrelid = 'public.jobs'::pg_catalog.regclass
        AND NOT trigger_row.tgisinternal
    ), jobs_trigger_delta AS (
      (SELECT * FROM actual_jobs_trigger EXCEPT ALL SELECT * FROM expected_jobs_trigger)
      UNION ALL
      (SELECT * FROM expected_jobs_trigger EXCEPT ALL SELECT * FROM actual_jobs_trigger)
    )
    SELECT 1 FROM jobs_trigger_delta
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger trigger_row
    WHERE trigger_row.tgrelid IN (
      'public.jobs'::pg_catalog.regclass,
      'public.audit_events'::pg_catalog.regclass
    ) AND NOT trigger_row.tgisinternal AND trigger_row.tgenabled <> 'O'
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_rewrite rule_row
    WHERE rule_row.ev_class IN (
      'public.jobs'::pg_catalog.regclass, 'public.audit_events'::pg_catalog.regclass
    )
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_inherits inheritance_row
    WHERE inheritance_row.inhparent IN (
      'public.jobs'::pg_catalog.regclass, 'public.audit_events'::pg_catalog.regclass
    ) OR inheritance_row.inhrelid IN (
      'public.jobs'::pg_catalog.regclass, 'public.audit_events'::pg_catalog.regclass
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 7A operations authority relation baseline is not canonical';
  END IF;

  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.string_agg(storage_descriptor.descriptor, E'\n'
      ORDER BY storage_descriptor.descriptor), 'UTF8'
  )), 'hex') INTO actual_predecessor_storage_sha256
  FROM (
    SELECT 'relation:' || relation_row.relname || ':' ||
      relation_row.relkind::text || ':' || relation_row.relpersistence::text || ':' ||
      CASE relation_row.relowner WHEN database_owner THEN '<owner>'
        ELSE pg_catalog.pg_get_userbyid(relation_row.relowner) END || ':' ||
      relation_row.relrowsecurity::text || ':' || relation_row.relforcerowsecurity::text ||
      ':' || relation_row.relreplident::text || ':' || relation_row.relispartition::text ||
      ':' || relation_row.relhasrules::text || ':' || relation_row.relhastriggers::text ||
      ':' || relation_row.relchecks::text AS descriptor
    FROM pg_catalog.pg_class relation_row
    JOIN pg_catalog.pg_namespace namespace_row
      ON namespace_row.oid = relation_row.relnamespace
    WHERE namespace_row.nspname = 'public'
      AND relation_row.relname IN ('jobs', 'audit_events')
    UNION ALL
    SELECT 'column:' || relation_row.relname || ':' || attribute_row.attnum::text || ':' ||
      attribute_row.attname || ':' || type_namespace.nspname || '.' || type_row.typname ||
      ':' || pg_catalog.format_type(attribute_row.atttypid, attribute_row.atttypmod) ||
      ':' || attribute_row.attnotnull::text || ':' || attribute_row.attidentity::text ||
      ':' || attribute_row.attgenerated::text || ':' || coalesce(
        collation_namespace.nspname || '.' || collation_row.collname, ''
      ) || ':' || coalesce(
        pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid), ''
      )
    FROM pg_catalog.pg_attribute attribute_row
    JOIN pg_catalog.pg_class relation_row ON relation_row.oid = attribute_row.attrelid
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
    JOIN pg_catalog.pg_type type_row ON type_row.oid = attribute_row.atttypid
    JOIN pg_catalog.pg_namespace type_namespace ON type_namespace.oid = type_row.typnamespace
    LEFT JOIN pg_catalog.pg_attrdef default_row
      ON default_row.adrelid = attribute_row.attrelid
     AND default_row.adnum = attribute_row.attnum
    LEFT JOIN pg_catalog.pg_collation collation_row
      ON collation_row.oid = attribute_row.attcollation
    LEFT JOIN pg_catalog.pg_namespace collation_namespace
      ON collation_namespace.oid = collation_row.collnamespace
    WHERE namespace_row.nspname = 'public'
      AND relation_row.relname IN ('jobs', 'audit_events')
      AND attribute_row.attnum > 0 AND NOT attribute_row.attisdropped
    UNION ALL
    SELECT 'constraint:' || relation_row.relname || ':' || constraint_row.conname || ':' ||
      constraint_row.contype::text || ':' || constraint_row.convalidated::text || ':' ||
      constraint_row.condeferrable::text || ':' || constraint_row.condeferred::text || ':' ||
      constraint_row.connoinherit::text || ':' ||
      pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
    FROM pg_catalog.pg_constraint constraint_row
    JOIN pg_catalog.pg_class relation_row ON relation_row.oid = constraint_row.conrelid
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
    WHERE namespace_row.nspname = 'public'
      AND relation_row.relname IN ('jobs', 'audit_events')
    UNION ALL
    SELECT 'index:' || table_relation.relname || ':' || index_namespace.nspname || '.' ||
      index_relation.relname || ':' ||
      CASE index_relation.relowner WHEN database_owner THEN '<owner>'
        ELSE pg_catalog.pg_get_userbyid(index_relation.relowner) END || ':' ||
      index_row.indisunique::text || ':' || index_row.indisprimary::text || ':' ||
      index_row.indisexclusion::text || ':' || index_row.indimmediate::text || ':' ||
      index_row.indisclustered::text || ':' || index_row.indisvalid::text || ':' ||
      index_row.indisready::text || ':' || index_row.indislive::text || ':' ||
      index_row.indisreplident::text || ':' ||
      pg_catalog.pg_get_indexdef(index_relation.oid)
    FROM pg_catalog.pg_index index_row
    JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_row.indexrelid
    JOIN pg_catalog.pg_namespace index_namespace
      ON index_namespace.oid = index_relation.relnamespace
    JOIN pg_catalog.pg_class table_relation ON table_relation.oid = index_row.indrelid
    JOIN pg_catalog.pg_namespace table_namespace
      ON table_namespace.oid = table_relation.relnamespace
    WHERE table_namespace.nspname = 'public'
      AND table_relation.relname IN ('jobs', 'audit_events')
  ) storage_descriptor;

  IF actual_predecessor_storage_sha256 IS DISTINCT FROM
    '5dfb4b04a8259b1f11cbe91aacb668c62993fd1e32e319c9f8287f78b60e43c8' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 7A predecessor storage inventory is not canonical';
  END IF;

  IF pg_catalog.to_regprocedure('public.plan6b_guard_job_insert()') IS NULL OR
    pg_catalog.to_regprocedure('public.plan6b_guard_audit_insert()') IS NULL OR
    (SELECT pg_catalog.count(*)
     FROM pg_catalog.pg_proc routine
     JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = routine.pronamespace
     WHERE namespace_row.nspname = 'public' AND routine.proname =
       'plan6b_guard_job_insert') <> 1 OR
    (SELECT pg_catalog.count(*)
     FROM pg_catalog.pg_proc routine
     JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = routine.pronamespace
     WHERE namespace_row.nspname = 'public' AND routine.proname =
       'plan6b_guard_audit_insert') <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 7A operations authority predecessor guards are not canonical';
  END IF;

  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.replace(pg_catalog.replace(
      pg_catalog.pg_get_functiondef(
        'public.plan6b_guard_job_insert()'::pg_catalog.regprocedure
      ), E'\r\n', E'\n'
    ), E'\r', E'\n'), 'UTF8'
  )), 'hex') INTO actual_job_guard_sha256;
  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.replace(pg_catalog.replace(
      pg_catalog.pg_get_functiondef(
        'public.plan6b_guard_audit_insert()'::pg_catalog.regprocedure
      ), E'\r\n', E'\n'
    ), E'\r', E'\n'), 'UTF8'
  )), 'hex') INTO actual_audit_guard_sha256;
  IF actual_job_guard_sha256 IS DISTINCT FROM
      'eff9a86953f50ac0aaabbfef58b3431aeefe27a92193ce94a19fa4aeac84d9c2' OR
    actual_audit_guard_sha256 IS DISTINCT FROM
      'f0373a347c369035f1c8b68d6eb4238a33612b0fa6e82e2ecfaa0ebf10e0696b' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 7A operations authority predecessor guard definition is not canonical';
  END IF;

  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.string_agg(acl_descriptor.descriptor, E'\n'
      ORDER BY acl_descriptor.descriptor), 'UTF8'
  )), 'hex') INTO actual_predecessor_acl_sha256
  FROM (
    SELECT 'database:' || privilege.privilege_type || ':' ||
      CASE privilege.grantee WHEN 0 THEN '<public>'
        WHEN database_owner THEN '<owner>'
        ELSE pg_catalog.pg_get_userbyid(privilege.grantee) END || ':' ||
      CASE privilege.grantor WHEN database_owner THEN '<owner>'
        ELSE pg_catalog.pg_get_userbyid(privilege.grantor) END || ':' ||
      privilege.is_grantable::text AS descriptor
    FROM pg_catalog.pg_database database_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
      database_row.datacl, pg_catalog.acldefault('d', database_row.datdba)
    )) privilege
    WHERE database_row.datname = pg_catalog.current_database()
    UNION ALL
    SELECT 'schema:public:' || privilege.privilege_type || ':' ||
      CASE privilege.grantee WHEN 0 THEN '<public>'
        WHEN database_owner THEN '<owner>'
        ELSE pg_catalog.pg_get_userbyid(privilege.grantee) END || ':' ||
      CASE privilege.grantor WHEN database_owner THEN '<owner>'
        ELSE pg_catalog.pg_get_userbyid(privilege.grantor) END || ':' ||
      privilege.is_grantable::text
    FROM pg_catalog.pg_namespace namespace_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
      namespace_row.nspacl, pg_catalog.acldefault('n', namespace_row.nspowner)
    )) privilege
    WHERE namespace_row.nspname = 'public'
    UNION ALL
    SELECT 'relation:' || relation_row.relkind::text || ':' || relation_row.relname ||
      ':' || privilege.privilege_type || ':' ||
      CASE privilege.grantee WHEN 0 THEN '<public>'
        WHEN database_owner THEN '<owner>'
        ELSE pg_catalog.pg_get_userbyid(privilege.grantee) END || ':' ||
      CASE privilege.grantor WHEN database_owner THEN '<owner>'
        ELSE pg_catalog.pg_get_userbyid(privilege.grantor) END || ':' ||
      privilege.is_grantable::text
    FROM pg_catalog.pg_class relation_row
    JOIN pg_catalog.pg_namespace namespace_row
      ON namespace_row.oid = relation_row.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
      relation_row.relacl, pg_catalog.acldefault(
        (CASE WHEN relation_row.relkind = 'S' THEN 'S' ELSE 'r' END)::"char",
        relation_row.relowner
      )
    )) privilege
    WHERE namespace_row.nspname = 'public'
      AND relation_row.relkind IN ('r','p','v','m','S','f')
      AND relation_row.relname NOT IN (
        'operations_job_retry_commands', 'operations_job_retry_claims'
      )
    UNION ALL
    SELECT 'column:' || relation_row.relname || ':' || attribute_row.attname || ':' ||
      privilege.privilege_type || ':' ||
      CASE privilege.grantee WHEN 0 THEN '<public>'
        WHEN database_owner THEN '<owner>'
        ELSE pg_catalog.pg_get_userbyid(privilege.grantee) END || ':' ||
      CASE privilege.grantor WHEN database_owner THEN '<owner>'
        ELSE pg_catalog.pg_get_userbyid(privilege.grantor) END || ':' ||
      privilege.is_grantable::text
    FROM pg_catalog.pg_attribute attribute_row
    JOIN pg_catalog.pg_class relation_row ON relation_row.oid = attribute_row.attrelid
    JOIN pg_catalog.pg_namespace namespace_row
      ON namespace_row.oid = relation_row.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute_row.attacl) privilege
    WHERE namespace_row.nspname = 'public'
      AND relation_row.relname NOT IN (
        'operations_job_retry_commands', 'operations_job_retry_claims'
      ) AND attribute_row.attnum > 0 AND NOT attribute_row.attisdropped
      AND attribute_row.attacl IS NOT NULL
    UNION ALL
    SELECT 'type:' || type_row.typname || ':' || privilege.privilege_type || ':' ||
      CASE privilege.grantee WHEN 0 THEN '<public>'
        WHEN database_owner THEN '<owner>'
        ELSE pg_catalog.pg_get_userbyid(privilege.grantee) END || ':' ||
      CASE privilege.grantor WHEN database_owner THEN '<owner>'
        ELSE pg_catalog.pg_get_userbyid(privilege.grantor) END || ':' ||
      privilege.is_grantable::text
    FROM pg_catalog.pg_type type_row
    JOIN pg_catalog.pg_namespace namespace_row
      ON namespace_row.oid = type_row.typnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
      type_row.typacl, pg_catalog.acldefault('T', type_row.typowner)
    )) privilege
    WHERE namespace_row.nspname = 'public' AND type_row.typtype IN ('d','e')
      AND type_row.typname NOT LIKE 'operations_job_retry_%'
    UNION ALL
    SELECT 'routine:' || routine.proname || '(' ||
      pg_catalog.pg_get_function_identity_arguments(routine.oid) || '):' ||
      privilege.privilege_type || ':' ||
      CASE privilege.grantee WHEN 0 THEN '<public>'
        WHEN database_owner THEN '<owner>'
        ELSE pg_catalog.pg_get_userbyid(privilege.grantee) END || ':' ||
      CASE privilege.grantor WHEN database_owner THEN '<owner>'
        ELSE pg_catalog.pg_get_userbyid(privilege.grantor) END || ':' ||
      privilege.is_grantable::text
    FROM pg_catalog.pg_proc routine
    JOIN pg_catalog.pg_namespace namespace_row
      ON namespace_row.oid = routine.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
      routine.proacl, pg_catalog.acldefault('f', routine.proowner)
    )) privilege
    WHERE namespace_row.nspname = 'public' AND routine.proname NOT IN (
      'plan7a_operations_job_catalog', 'plan7a_operations_safe_failure_code',
      'plan7a_operations_assert_job_capability',
      'plan7a_operations_guard_command_update',
      'plan7a_operations_guard_command_delete',
      'plan7a_operations_guard_job_transition', 'list_operational_jobs',
      'submit_job_retry_command', 'get_owned_job_retry_command',
      'plan7a_operations_claim_job', 'plan7a_operations_renew_job_claim',
      'plan7a_operations_relinquish_job', 'plan7a_operations_complete_job',
      'plan7a_operations_fail_job', 'plan7a_operations_exhaust_job',
      'plan7a_operations_lock_job_retry_command',
      'plan7a_operations_transition_job_retry_command'
    )
  ) acl_descriptor;

  IF actual_predecessor_acl_sha256 IS DISTINCT FROM
    '9d22545961747a6434b6eee47093c6c82c512483a6e36a5a49af0c0f41684e7a' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 7A predecessor ACL inventory is not canonical';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc routine
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = routine.pronamespace
    WHERE routine.proname = ANY(ARRAY[
      'plan7a_operations_job_catalog', 'plan7a_operations_safe_failure_code',
      'list_operational_jobs', 'submit_job_retry_command',
      'get_owned_job_retry_command', 'plan7a_operations_claim_job',
      'plan7a_operations_renew_job_claim', 'plan7a_operations_relinquish_job',
      'plan7a_operations_complete_job', 'plan7a_operations_fail_job',
      'plan7a_operations_exhaust_job', 'plan7a_operations_lock_job_retry_command',
      'plan7a_operations_transition_job_retry_command',
      'plan7a_operations_assert_job_capability',
      'plan7a_operations_guard_command_update',
      'plan7a_operations_guard_command_delete',
      'plan7a_operations_guard_job_transition'
    ]::text[])
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_class relation_row
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
    WHERE relation_row.relname IN (
      'operations_job_retry_commands', 'operations_job_retry_claims',
      'plan7a_operations_retry_claims_pkey',
      'plan7a_operations_retry_commands_pkey',
      'plan7a_operations_retry_claims_command_unique',
      'plan7a_operations_retry_commands_actor_idempotency_unique',
      'plan7a_operations_retry_commands_status_created_idx',
      'plan7a_operations_retry_commands_target_created_idx'
    )
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_type type_row
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = type_row.typnamespace
    WHERE type_row.typname IN (
      'operations_job_retry_command_status', 'operations_job_retry_result_code',
      'operations_job_retry_reason_code', 'operations_job_retry_claim_state',
      '_operations_job_retry_command_status', '_operations_job_retry_result_code',
      '_operations_job_retry_reason_code', '_operations_job_retry_claim_state',
      'operations_job_retry_commands', '_operations_job_retry_commands',
      'operations_job_retry_claims', '_operations_job_retry_claims'
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 7A operations authority object namespace is not canonical';
  END IF;

  IF EXISTS (
    WITH canonical_resolution_audit AS (
      SELECT audit.id AS audit_id, issue.id AS issue_id
      FROM "public"."audit_events" audit
      JOIN "public"."financial_reconciliation_issues" issue
        ON issue.id::text = audit.resource_id
       AND issue.state = 'resolved'
      WHERE audit.action = 'financial.issue.resolved'
        AND audit.outcome = 'succeeded'
        AND audit.resource_type = 'financial_issue'
        AND audit.correlation_id IS NOT NULL
        AND pg_catalog.char_length(audit.correlation_id) BETWEEN 1 AND 100
        AND audit.before IS NULL
        AND audit.request_metadata IS NULL
        AND (
          (issue.resolved_by_admin_id IS NULL
            AND audit.actor_type = 'system'
            AND (
              audit.actor_id = 'financial-worker'
              OR (audit.actor_id = 'commerce-worker' AND (
                issue.resource_type = 'dispute'
                OR (issue.resource_type = 'allocation_set' AND issue.safe_code IN (
                  'allocation_mismatch', 'classification_fork', 'correction_rebase_required',
                  'currency_mismatch', 'immutable_mismatch', 'source_linkage_mismatch',
                  'unsupported_category'
                ))
              ))
            )
            AND audit.after = pg_catalog.jsonb_build_object(
              'resourceType', issue.resource_type,
              'resourceId', issue.resource_id,
              'safeCode', issue.safe_code,
              'impact', issue.impact,
              'state', issue.state,
              'occurrenceCount', issue.occurrence_count
            ))
          OR (issue.resolved_by_admin_id IS NOT NULL
            AND audit.actor_type = 'user'
            AND audit.actor_id = issue.resolved_by_admin_id::text
            AND (
              audit.after = pg_catalog.jsonb_build_object(
                'resourceType', issue.resource_type,
                'resourceId', issue.resource_id,
                'safeCode', issue.safe_code,
                'impact', issue.impact,
                'state', issue.state,
                'occurrenceCount', issue.occurrence_count
              ) OR CASE WHEN
                audit.after - 'commandId' = pg_catalog.jsonb_build_object(
                  'resourceType', issue.resource_type,
                  'resourceId', issue.resource_id,
                  'safeCode', issue.safe_code,
                  'impact', issue.impact,
                  'state', issue.state,
                  'occurrenceCount', issue.occurrence_count
                ) AND pg_catalog.jsonb_typeof(audit.after -> 'commandId') = 'string'
                  AND pg_catalog.pg_input_is_valid(audit.after ->> 'commandId', 'uuid')
              THEN EXISTS (
                SELECT 1
                FROM "public"."financial_admin_commands" command
                WHERE command.id::text = audit.after ->> 'commandId'
                  AND command.actor_user_id = issue.resolved_by_admin_id
                  AND command.correlation_id = audit.correlation_id
                  AND command.status = 'succeeded'
                  AND issue.safe_code IN (
                    'allocation_fork',
                    'allocation_incomplete',
                    'allocation_mismatch',
                    'classification_fork',
                    'correction_rebase_required',
                    'currency_mismatch',
                    'immutable_mismatch',
                    'missing_source',
                    'source_linkage_mismatch'
                  )
                  AND command.kind IN (
                    'refund_allocation_finalize',
                    'refund_reporting_correction_create'
                  )
                  AND (
                    (command.kind = 'refund_allocation_finalize'
                      AND command.safe_result_code = 'allocation_finalized')
                    OR (command.kind = 'refund_reporting_correction_create'
                      AND command.safe_result_code = 'correction_created')
                  )
                  AND pg_catalog.jsonb_typeof(
                    command.safe_result -> 'refundId'
                  ) = 'string'
                  AND (
                    (issue.resource_type = 'refund' AND issue.resource_id::text =
                      command.safe_result ->> 'refundId')
                    OR (issue.resource_type = 'allocation_set' AND EXISTS (
                      SELECT 1
                      FROM "public"."financial_allocation_sets" allocation_set
                      WHERE allocation_set.id = issue.resource_id
                        AND allocation_set.source_kind = 'refund'
                        AND allocation_set.source_internal_id::text =
                          command.safe_result ->> 'refundId'
                    ))
                  )
              ) ELSE false END
            ))
        )
    ), invalid_resolved_issue AS (
      SELECT issue.id
      FROM "public"."financial_reconciliation_issues" issue
      LEFT JOIN canonical_resolution_audit audit ON audit.issue_id = issue.id
      WHERE issue.state = 'resolved'
      GROUP BY issue.id
      HAVING pg_catalog.count(audit.audit_id) <> 1
    ), invalid_resolution_audit AS (
      SELECT audit.id
      FROM "public"."audit_events" audit
      LEFT JOIN canonical_resolution_audit canonical ON canonical.audit_id = audit.id
      WHERE audit.action = 'financial.issue.resolved'
        AND canonical.audit_id IS NULL
    )
    SELECT 1 FROM invalid_resolved_issue
    UNION ALL SELECT 1 FROM invalid_resolution_audit
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Plan 6B-II issue-transition repair found invalid resolution audit provenance';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "public"."jobs" job
    WHERE job.type = 'operations.job-retry-command'
      OR job.deduplication_key LIKE 'operations:job-retry-command:%'
  ) OR EXISTS (
    SELECT 1 FROM "public"."audit_events" audit
    WHERE pg_catalog.left(audit.action, 21) = 'operations.job_retry.'
      OR audit.resource_type = 'operations_job_retry_command'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations namespace is not empty';
  END IF;
END;
$plan7a_operations_authority_preflight$;--> statement-breakpoint

CREATE TYPE "public"."operations_job_retry_claim_state" AS ENUM('active', 'invalidated');--> statement-breakpoint
CREATE TYPE "public"."operations_job_retry_command_status" AS ENUM('pending', 'succeeded', 'denied', 'failed');--> statement-breakpoint
CREATE TYPE "public"."operations_job_retry_reason_code" AS ENUM('dependency_recovered', 'configuration_recovered', 'operator_reassessment');--> statement-breakpoint
CREATE TYPE "public"."operations_job_retry_result_code" AS ENUM('rearmed_existing', 'successor_enqueued', 'already_current', 'retry_not_supported', 'retry_policy_not_enabled', 'provider_recovery_not_enabled', 'target_not_failed', 'target_state_changed', 'domain_state_not_retryable', 'source_unavailable', 'actor_not_authorized', 'retry_command_invalid', 'retry_command_exhausted', 'unexpected_failure');--> statement-breakpoint
CREATE TABLE "operations_job_retry_claims" (
	"job_id" uuid NOT NULL,
	"command_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"attempt" integer NOT NULL,
	"lease_owner" varchar(200) NOT NULL,
	"capability_sha256" varchar(64) NOT NULL,
	"lease_duration_ms" integer NOT NULL,
	"state" "operations_job_retry_claim_state" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"renewed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	CONSTRAINT "plan7a_operations_retry_claims_pkey" PRIMARY KEY("job_id"),
	CONSTRAINT "plan7a_operations_retry_claims_generation_positive" CHECK (("operations_job_retry_claims"."generation" between 1 and 2147483647) is true),
	CONSTRAINT "plan7a_operations_retry_claims_attempt_positive" CHECK (("operations_job_retry_claims"."attempt" between 1 and 2147483647) is true),
	CONSTRAINT "plan7a_operations_retry_claims_lease_owner_canonical" CHECK (("operations_job_retry_claims"."lease_owner" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$') is true),
	CONSTRAINT "plan7a_operations_retry_claims_capability_sha256" CHECK (("operations_job_retry_claims"."capability_sha256" ~ '^[a-f0-9]{64}$') is true),
	CONSTRAINT "plan7a_operations_retry_claims_lease_duration_bounded" CHECK (("operations_job_retry_claims"."lease_duration_ms" between 1 and 86400000) is true),
	CONSTRAINT "plan7a_operations_retry_claims_lifecycle_consistent" CHECK ((
        pg_catalog.isfinite("operations_job_retry_claims"."issued_at")
        and pg_catalog.isfinite("operations_job_retry_claims"."expires_at")
        and "operations_job_retry_claims"."expires_at" > "operations_job_retry_claims"."issued_at"
        and ("operations_job_retry_claims"."renewed_at" is null or (
          pg_catalog.isfinite("operations_job_retry_claims"."renewed_at")
          and "operations_job_retry_claims"."renewed_at" >= "operations_job_retry_claims"."issued_at"
          and "operations_job_retry_claims"."expires_at" > "operations_job_retry_claims"."renewed_at"
        ))
        and ((
          "operations_job_retry_claims"."state" = 'active'
          and "operations_job_retry_claims"."invalidated_at" is null
        ) or (
          "operations_job_retry_claims"."state" = 'invalidated'
          and "operations_job_retry_claims"."invalidated_at" is not null
          and pg_catalog.isfinite("operations_job_retry_claims"."invalidated_at")
          and "operations_job_retry_claims"."invalidated_at" >= coalesce(
            "operations_job_retry_claims"."renewed_at", "operations_job_retry_claims"."issued_at"
          )
        ))
      ) is true)
);
--> statement-breakpoint
CREATE TABLE "operations_job_retry_commands" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar(32) DEFAULT 'retry_failed_job' NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"target_job_id" uuid NOT NULL,
	"target_job_kind" varchar(100) NOT NULL,
	"expected_status" varchar(16) NOT NULL,
	"expected_attempts" integer NOT NULL,
	"expected_max_attempts" integer NOT NULL,
	"expected_updated_at" timestamp with time zone NOT NULL,
	"reason_code" "operations_job_retry_reason_code" NOT NULL,
	"correlation_id" varchar(100) NOT NULL,
	"idempotency_key_sha256" varchar(64) NOT NULL,
	"input_fingerprint_sha256" varchar(64) NOT NULL,
	"status" "operations_job_retry_command_status" DEFAULT 'pending' NOT NULL,
	"safe_result_code" "operations_job_retry_result_code",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "plan7a_operations_retry_commands_pkey" PRIMARY KEY("id"),
	CONSTRAINT "plan7a_operations_retry_commands_kind_fixed" CHECK (("operations_job_retry_commands"."kind" = 'retry_failed_job') is true),
	CONSTRAINT "plan7a_operations_retry_commands_target_kind_registered" CHECK (("operations_job_retry_commands"."target_job_kind" in ('outbox.dispatch', 'commerce.claim-email', 'commerce.claim-email-request', 'commerce.stripe-event', 'commerce.financial-source', 'commerce.financial-payout', 'commerce.financial-scan', 'commerce.financial-classification', 'commerce.financial-admin-command', 'catalog.ingest_revision', 'operations.job-retry-command')) is true),
	CONSTRAINT "plan7a_operations_retry_commands_expected_state_consistent" CHECK ((
        "operations_job_retry_commands"."expected_status" = 'failed'
        and "operations_job_retry_commands"."expected_attempts" between 1 and "operations_job_retry_commands"."expected_max_attempts"
        and "operations_job_retry_commands"."expected_max_attempts" between 1 and 2147483647
        and pg_catalog.isfinite("operations_job_retry_commands"."expected_updated_at")
      ) is true),
	CONSTRAINT "plan7a_operations_retry_commands_correlation_canonical" CHECK (("operations_job_retry_commands"."correlation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$') is true),
	CONSTRAINT "plan7a_operations_retry_commands_hashes_sha256" CHECK ((
        "operations_job_retry_commands"."idempotency_key_sha256" ~ '^[a-f0-9]{64}$'
        and "operations_job_retry_commands"."input_fingerprint_sha256" ~ '^[a-f0-9]{64}$'
      ) is true),
	CONSTRAINT "plan7a_operations_retry_commands_lifecycle_consistent" CHECK ((
        pg_catalog.isfinite("operations_job_retry_commands"."created_at")
        and pg_catalog.isfinite("operations_job_retry_commands"."updated_at")
        and "operations_job_retry_commands"."created_at" <= "operations_job_retry_commands"."updated_at"
        and ((
          "operations_job_retry_commands"."status" = 'pending'
          and "operations_job_retry_commands"."safe_result_code" is null
          and "operations_job_retry_commands"."completed_at" is null
        ) or (
          "operations_job_retry_commands"."status" in ('succeeded', 'denied', 'failed')
          and "operations_job_retry_commands"."safe_result_code" is not null
          and "operations_job_retry_commands"."completed_at" is not null
          and pg_catalog.isfinite("operations_job_retry_commands"."completed_at")
          and "operations_job_retry_commands"."completed_at" = "operations_job_retry_commands"."updated_at"
          and (("operations_job_retry_commands"."target_job_kind" = 'outbox.dispatch' and (
      ("operations_job_retry_commands"."status" = 'denied' and
          "operations_job_retry_commands"."safe_result_code" = 'retry_policy_not_enabled')
    )) or ("operations_job_retry_commands"."target_job_kind" = 'commerce.claim-email' and (
      ("operations_job_retry_commands"."status" = 'denied' and
          "operations_job_retry_commands"."safe_result_code" = 'retry_policy_not_enabled')
    )) or ("operations_job_retry_commands"."target_job_kind" = 'commerce.claim-email-request' and (
      ("operations_job_retry_commands"."status" = 'denied' and
          "operations_job_retry_commands"."safe_result_code" = 'retry_policy_not_enabled')
    )) or ("operations_job_retry_commands"."target_job_kind" = 'commerce.stripe-event' and (
      ("operations_job_retry_commands"."status" = 'succeeded' and
          "operations_job_retry_commands"."safe_result_code" = 'rearmed_existing') or ("operations_job_retry_commands"."status" = 'denied' and
          "operations_job_retry_commands"."safe_result_code" = 'target_state_changed') or ("operations_job_retry_commands"."status" = 'denied' and
          "operations_job_retry_commands"."safe_result_code" = 'domain_state_not_retryable') or ("operations_job_retry_commands"."status" = 'denied' and
          "operations_job_retry_commands"."safe_result_code" = 'source_unavailable') or ("operations_job_retry_commands"."status" = 'failed' and
          "operations_job_retry_commands"."safe_result_code" = 'retry_command_invalid')
    )) or ("operations_job_retry_commands"."target_job_kind" = 'commerce.financial-source' and (
      ("operations_job_retry_commands"."status" = 'denied' and
          "operations_job_retry_commands"."safe_result_code" = 'retry_policy_not_enabled')
    )) or ("operations_job_retry_commands"."target_job_kind" = 'commerce.financial-payout' and (
      ("operations_job_retry_commands"."status" = 'denied' and
          "operations_job_retry_commands"."safe_result_code" = 'retry_policy_not_enabled')
    )) or ("operations_job_retry_commands"."target_job_kind" = 'commerce.financial-scan' and (
      ("operations_job_retry_commands"."status" = 'denied' and
          "operations_job_retry_commands"."safe_result_code" = 'retry_policy_not_enabled')
    )) or ("operations_job_retry_commands"."target_job_kind" = 'commerce.financial-classification' and (
      ("operations_job_retry_commands"."status" = 'succeeded' and
          "operations_job_retry_commands"."safe_result_code" = 'rearmed_existing') or ("operations_job_retry_commands"."status" = 'denied' and
          "operations_job_retry_commands"."safe_result_code" = 'target_state_changed') or ("operations_job_retry_commands"."status" = 'denied' and
          "operations_job_retry_commands"."safe_result_code" = 'domain_state_not_retryable') or ("operations_job_retry_commands"."status" = 'denied' and
          "operations_job_retry_commands"."safe_result_code" = 'source_unavailable') or ("operations_job_retry_commands"."status" = 'failed' and
          "operations_job_retry_commands"."safe_result_code" = 'retry_command_invalid')
    )) or ("operations_job_retry_commands"."target_job_kind" = 'commerce.financial-admin-command' and (
      ("operations_job_retry_commands"."status" = 'denied' and
          "operations_job_retry_commands"."safe_result_code" = 'retry_not_supported')
    )) or ("operations_job_retry_commands"."target_job_kind" = 'catalog.ingest_revision' and (
      ("operations_job_retry_commands"."status" = 'denied' and
          "operations_job_retry_commands"."safe_result_code" = 'retry_policy_not_enabled')
    )) or ("operations_job_retry_commands"."target_job_kind" = 'operations.job-retry-command' and (
      ("operations_job_retry_commands"."status" = 'denied' and
          "operations_job_retry_commands"."safe_result_code" = 'retry_not_supported')
    )) or ("operations_job_retry_commands"."status" = 'denied' and "operations_job_retry_commands"."safe_result_code" = 'actor_not_authorized') or ("operations_job_retry_commands"."status" = 'failed' and "operations_job_retry_commands"."safe_result_code" = 'retry_command_invalid') or ("operations_job_retry_commands"."status" = 'failed' and "operations_job_retry_commands"."safe_result_code" = 'retry_command_exhausted') or ("operations_job_retry_commands"."status" = 'failed' and "operations_job_retry_commands"."safe_result_code" = 'unexpected_failure'))
        ))
      ) is true)
);
--> statement-breakpoint
ALTER TABLE "operations_job_retry_claims" ADD CONSTRAINT "plan7a_operations_retry_claims_job_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "operations_job_retry_claims" ADD CONSTRAINT "plan7a_operations_retry_claims_command_fk" FOREIGN KEY ("command_id") REFERENCES "public"."operations_job_retry_commands"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "operations_job_retry_commands" ADD CONSTRAINT "plan7a_operations_retry_commands_actor_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "operations_job_retry_commands" ADD CONSTRAINT "plan7a_operations_retry_commands_target_job_fk" FOREIGN KEY ("target_job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "plan7a_operations_retry_claims_command_unique" ON "operations_job_retry_claims" USING btree ("command_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plan7a_operations_retry_commands_actor_idempotency_unique" ON "operations_job_retry_commands" USING btree ("actor_user_id","idempotency_key_sha256");--> statement-breakpoint
CREATE INDEX "plan7a_operations_retry_commands_status_created_idx" ON "operations_job_retry_commands" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "plan7a_operations_retry_commands_target_created_idx" ON "operations_job_retry_commands" USING btree ("target_job_id","created_at","id");--> statement-breakpoint

CREATE FUNCTION public.plan7a_operations_job_catalog()
RETURNS TABLE (
  kind text,
  label text,
  max_attempts integer,
  automatic_retry_owner text,
  retry_disposition text,
  policy_adapter text,
  policy_availability text,
  provider_verification_required boolean,
  provider_calls_in_plan7a boolean,
  administrator_retry_excluded boolean,
  safe_statuses text[],
  diagnostic_generation text,
  allowed_policy_outcomes text[]
)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $plan7a_operations_job_catalog$
  with plan7a_job_catalog_values (
    catalog_ordinal, kind, label, max_attempts, automatic_retry_owner,
    retry_disposition, policy_adapter, policy_availability,
    provider_verification_required, provider_calls_in_plan7a,
    administrator_retry_excluded, safe_statuses, diagnostic_generation
  ) as (values
    (1, 'outbox.dispatch', 'Outbox dispatch', 8,
      'postgres_job_repository_exponential_backoff', 'rearm_existing',
      'deny_retry_policy_not_enabled', 'disabled', false, false, false,
      array['pending', 'running', 'succeeded', 'failed']::text[], 'none'),
    (2, 'commerce.claim-email', 'Claim email', 8,
      'postgres_job_repository_exponential_backoff', 'enqueue_successor',
      'deny_retry_policy_not_enabled', 'disabled', false, false, false,
      array['pending', 'running', 'succeeded', 'failed']::text[], 'none'),
    (3, 'commerce.claim-email-request', 'Claim email request', 8,
      'postgres_job_repository_exponential_backoff', 'enqueue_successor',
      'deny_retry_policy_not_enabled', 'disabled', false, false, false,
      array['pending', 'running', 'succeeded', 'failed']::text[], 'none'),
    (4, 'commerce.stripe-event', 'Stripe event', 12,
      'postgres_job_repository_exponential_backoff', 'rearm_existing',
      'rearm_pending_stripe_event', 'enabled', false, false, false,
      array['pending', 'running', 'succeeded', 'failed']::text[], 'none'),
    (5, 'commerce.financial-source', 'Financial source', 12,
      'postgres_job_repository_exponential_backoff', 'enqueue_successor',
      'deny_retry_policy_not_enabled', 'disabled', false, false, false,
      array['pending', 'running', 'succeeded', 'failed']::text[], 'none'),
    (6, 'commerce.financial-payout', 'Financial payout', 12,
      'postgres_job_repository_exponential_backoff', 'enqueue_successor',
      'deny_retry_policy_not_enabled', 'disabled', false, false, false,
      array['pending', 'running', 'succeeded', 'failed']::text[], 'none'),
    (7, 'commerce.financial-scan', 'Financial scan', 8,
      'postgres_job_repository_exponential_backoff', 'enqueue_successor',
      'deny_retry_policy_not_enabled', 'disabled', false, false, false,
      array['pending', 'running', 'succeeded', 'failed']::text[], 'none'),
    (8, 'commerce.financial-classification', 'Financial classification', 5,
      'postgres_job_repository_exponential_backoff', 'rearm_existing',
      'rearm_financial_classification', 'enabled', false, false, false,
      array['pending', 'running', 'succeeded', 'failed']::text[], 'none'),
    (9, 'commerce.financial-admin-command', 'Financial administrator command', 8,
      'postgres_job_repository_exponential_backoff', 'never',
      'deny_retry_not_supported', 'excluded', false, false, true,
      array['pending', 'running', 'succeeded', 'failed']::text[], 'none'),
    (10, 'catalog.ingest_revision', 'Revision ingestion', 5,
      'postgres_job_repository_exponential_backoff', 'enqueue_successor',
      'deny_retry_policy_not_enabled', 'disabled', false, false, false,
      array['pending', 'running', 'succeeded', 'failed']::text[], 'payload_generation'),
    (11, 'operations.job-retry-command', 'Operations job retry command', 8,
      'postgres_job_repository_exponential_backoff', 'never',
      'deny_retry_not_supported', 'excluded', false, false, true,
      array['pending', 'running', 'succeeded', 'failed']::text[],
      'operations_lease_generation')),
  plan7a_job_policy_outcome_values (
    policy_ordinal, policy_adapter, outcome_ordinal, status, result_code
  ) as (values
    (1, 'deny_retry_not_supported', 1, 'denied', 'retry_not_supported'),
    (2, 'deny_retry_policy_not_enabled', 1, 'denied', 'retry_policy_not_enabled'),
    (3, 'deny_provider_recovery_not_enabled', 1, 'denied',
      'provider_recovery_not_enabled'),
    (4, 'rearm_pending_stripe_event', 1, 'succeeded', 'rearmed_existing'),
    (4, 'rearm_pending_stripe_event', 2, 'denied', 'target_state_changed'),
    (4, 'rearm_pending_stripe_event', 3, 'denied', 'domain_state_not_retryable'),
    (4, 'rearm_pending_stripe_event', 4, 'denied', 'source_unavailable'),
    (4, 'rearm_pending_stripe_event', 5, 'failed', 'retry_command_invalid'),
    (5, 'rearm_financial_classification', 1, 'succeeded', 'rearmed_existing'),
    (5, 'rearm_financial_classification', 2, 'denied', 'target_state_changed'),
    (5, 'rearm_financial_classification', 3, 'denied',
      'domain_state_not_retryable'),
    (5, 'rearm_financial_classification', 4, 'denied', 'source_unavailable'),
    (5, 'rearm_financial_classification', 5, 'failed', 'retry_command_invalid'))
  select catalog.kind, catalog.label, catalog.max_attempts,
    catalog.automatic_retry_owner, catalog.retry_disposition,
    catalog.policy_adapter, catalog.policy_availability,
    catalog.provider_verification_required, catalog.provider_calls_in_plan7a,
    catalog.administrator_retry_excluded, catalog.safe_statuses,
    catalog.diagnostic_generation, array(
    select outcome.status || '/' || outcome.result_code
    from plan7a_job_policy_outcome_values outcome
    where outcome.policy_adapter = catalog.policy_adapter
    order by outcome.outcome_ordinal
  ) as allowed_policy_outcomes
  from plan7a_job_catalog_values catalog
  order by catalog.catalog_ordinal
$plan7a_operations_job_catalog$;--> statement-breakpoint

SELECT pg_catalog.count(*) FROM public.plan7a_operations_job_catalog();--> statement-breakpoint

CREATE FUNCTION "public"."plan7a_operations_safe_failure_code"(text,text)
RETURNS text
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $plan7a_operations_safe_failure_code$
  SELECT CASE
    WHEN $1 NOT IN (
      'outbox.dispatch', 'commerce.claim-email', 'commerce.claim-email-request',
      'commerce.stripe-event', 'commerce.financial-source',
      'commerce.financial-payout', 'commerce.financial-scan',
      'commerce.financial-classification', 'commerce.financial-admin-command',
      'catalog.ingest_revision', 'operations.job-retry-command'
    ) THEN 'unregistered_job_kind'
    WHEN $2 IS NULL THEN NULL
    ELSE coalesce((
      SELECT failure.code
      FROM (VALUES
      ('outbox.dispatch', 'Outbox job is missing outboxId', 'invalid_job_identity'),
      ('outbox.dispatch', 'Invalid auth email payload', 'invalid_job_identity'),
      ('outbox.dispatch', 'Invalid commerce email payload', 'invalid_job_identity'),
      ('outbox.dispatch', 'Outbox message does not exist', 'source_unavailable'),
      ('commerce.claim-email', 'Invalid commerce claim-email payload',
        'invalid_job_identity'),
      ('commerce.claim-email', 'Commerce claim-email order is not eligible',
        'domain_state_not_retryable'),
      ('commerce.claim-email-request', 'Invalid commerce claim-email payload',
        'invalid_job_identity'),
      ('commerce.claim-email-request', 'Commerce claim-email order is not eligible',
        'domain_state_not_retryable'),
      ('commerce.stripe-event', 'Invalid Stripe event job payload.',
        'invalid_job_identity'),
      ('commerce.stripe-event', 'Stripe event no longer exists.', 'source_unavailable'),
      ('commerce.financial-source', 'Invalid financial source job identity.',
        'invalid_job_identity'),
      ('commerce.financial-source', 'Financial source evidence is invalid.',
        'domain_state_not_retryable'),
      ('commerce.financial-payout', 'Invalid financial payout job identity.',
        'invalid_job_identity'),
      ('commerce.financial-payout', 'Financial payout evidence is invalid.',
        'domain_state_not_retryable'),
      ('commerce.financial-scan', 'Invalid financial scan job identity.',
        'invalid_job_identity'),
      ('commerce.financial-scan', 'Financial scan evidence is invalid.',
        'domain_state_not_retryable'),
      ('commerce.financial-classification',
        'Invalid financial classification job payload.', 'invalid_job_identity'),
      ('commerce.financial-classification',
        'Financial classification evidence is invalid.', 'domain_state_not_retryable'),
      ('commerce.financial-admin-command',
        'Invalid financial administrator command job identity.', 'invalid_job_identity'),
      ('commerce.financial-admin-command',
        'Financial administrator command identity is invalid.', 'invalid_job_identity'),
      ('commerce.financial-admin-command',
        'Financial administrator command is already terminal.',
        'domain_state_not_retryable'),
      ('commerce.financial-admin-command',
        'Financial administrator command was denied.', 'domain_state_not_retryable'),
      ('commerce.financial-admin-command',
        'Financial administrator command conflicted with current state.',
        'domain_state_not_retryable'),
      ('catalog.ingest_revision', 'Invalid revision ingestion payload',
        'invalid_job_identity'),
      ('catalog.ingest_revision', 'Revision ingestion target does not exist',
        'source_unavailable'),
      ('catalog.ingest_revision', 'Revision staging metadata is incomplete',
        'source_unavailable'),
      ('operations.job-retry-command',
        'Invalid operations job retry command identity.', 'invalid_job_identity'),
      ('operations.job-retry-command', 'Operations job retry command exhausted.',
        'retry_command_exhausted')
      ) AS failure(kind, message, code)
      WHERE failure.kind = $1 AND failure.message = $2
    ), 'unexpected_failure')
  END
$plan7a_operations_safe_failure_code$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."plan6b_guard_job_insert"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $plan6bii_job_insert_guard$
DECLARE
  referenced_id uuid;
  referenced_generation integer;
  stripe_provider_event_id text;
  stripe_event_status "public"."stripe_event_status";
  revision_state "public"."revision_state";
  revision_generation integer;
  claim_order "public"."orders"%ROWTYPE;
  command_row "public"."financial_admin_commands"%ROWTYPE;
BEGIN
  IF NEW.type = 'operations.job-retry-command' OR
    NEW.deduplication_key LIKE 'operations:job-retry-command:%' THEN
    IF NEW.type IS DISTINCT FROM 'operations.job-retry-command' OR
      NEW.status IS DISTINCT FROM 'pending' OR NEW.attempts IS DISTINCT FROM 0 OR
      NEW.max_attempts IS DISTINCT FROM 8 OR NEW.locked_at IS NOT NULL OR
      NEW.locked_by IS NOT NULL OR NEW.last_error IS NOT NULL OR
      NEW.rerun_requested_at IS NOT NULL OR NEW.completed_at IS NOT NULL OR
      NEW.run_at IS DISTINCT FROM NEW.created_at OR
      NEW.created_at IS DISTINCT FROM NEW.updated_at OR
      pg_catalog.jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object' OR
      NEW.payload - 'commandId' IS DISTINCT FROM '{}'::jsonb OR
      pg_catalog.jsonb_typeof(NEW.payload -> 'commandId') IS DISTINCT FROM 'string' OR
      NOT pg_catalog.pg_input_is_valid(NEW.payload ->> 'commandId', 'uuid') OR
      (NEW.payload ->> 'commandId')::uuid::text IS DISTINCT FROM
        NEW.payload ->> 'commandId' OR
      NEW.deduplication_key IS DISTINCT FROM
        'operations:job-retry-command:' || (NEW.payload ->> 'commandId') || ':v1' OR
      pg_catalog.current_setting(
        'pale_orbit.plan7a_operations_command_insert_id', true
      ) IS DISTINCT FROM NEW.payload ->> 'commandId' OR
      current_user IS DISTINCT FROM (
        SELECT pg_catalog.pg_get_userbyid(routine.proowner)
        FROM pg_catalog.pg_proc routine
        WHERE routine.oid = pg_catalog.to_regprocedure(
          'public.submit_job_retry_command(uuid,uuid,text,integer,integer,timestamp with time zone,text,text,text,text)'
        )
      ) OR NOT EXISTS (
        SELECT 1
        FROM "public"."operations_job_retry_commands" command
        WHERE command.id = (NEW.payload ->> 'commandId')::uuid
          AND command.status = 'pending'
          AND command.kind = 'retry_failed_job'
      ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'invalid operations job retry command identity';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT (
    pg_catalog.pg_has_role(session_user, 'pale_orbit_runtime', 'MEMBER')
    AND NOT pg_catalog.pg_has_role(session_user, 'pale_orbit_financial_worker', 'MEMBER')
  ) THEN
    RETURN NEW;
  END IF;
  IF NEW.status <> 'pending' OR NEW.attempts <> 0 OR
    NEW.locked_at IS NOT NULL OR NEW.locked_by IS NOT NULL OR
    NEW.last_error IS NOT NULL OR NEW.rerun_requested_at IS NOT NULL OR
    NEW.completed_at IS NOT NULL OR NEW.run_at IS DISTINCT FROM NEW.created_at OR
    NEW.created_at IS DISTINCT FROM NEW.updated_at OR NEW.deduplication_key IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid web job defaults';
  END IF;

  IF NEW.type = 'commerce.stripe-event' THEN
    IF NOT pg_catalog.pg_input_is_valid(NEW.payload ->> 'stripeEventId', 'uuid') THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid Stripe event job identity';
    END IF;
    referenced_id := (NEW.payload ->> 'stripeEventId')::uuid;
    IF NEW.payload IS DISTINCT FROM pg_catalog.jsonb_build_object(
        'stripeEventId', referenced_id
      ) OR NEW.max_attempts <> 12 THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid Stripe event job identity';
    END IF;
    SELECT event.provider_event_id, event.status
    INTO stripe_provider_event_id, stripe_event_status
    FROM "public"."stripe_events" event
    WHERE event.id = referenced_id
    FOR KEY SHARE;
    IF NOT FOUND OR stripe_event_status <> 'pending' OR
      NEW.deduplication_key IS DISTINCT FROM
        'stripe:event:' || stripe_provider_event_id THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid Stripe event job identity';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.type = 'catalog.ingest_revision' THEN
    IF NOT pg_catalog.pg_input_is_valid(NEW.payload ->> 'revisionId', 'uuid') OR
      NOT pg_catalog.pg_input_is_valid(NEW.payload ->> 'generation', 'integer') THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid revision job identity';
    END IF;
    referenced_id := (NEW.payload ->> 'revisionId')::uuid;
    referenced_generation := (NEW.payload ->> 'generation')::integer;
    IF referenced_generation < 0 OR NEW.payload IS DISTINCT FROM pg_catalog.jsonb_build_object(
        'revisionId', referenced_id, 'generation', referenced_generation
      ) OR NEW.max_attempts <> 5 OR NEW.deduplication_key IS DISTINCT FROM
        'catalog.ingest:' || referenced_id::text || ':' || referenced_generation::text THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid revision job identity';
    END IF;
    SELECT revision.state, revision.ingestion_generation
    INTO revision_state, revision_generation
    FROM "public"."title_revisions" revision
    WHERE revision.id = referenced_id
    FOR KEY SHARE;
    IF NOT FOUND OR revision_state <> 'uploaded' OR
      revision_generation IS DISTINCT FROM referenced_generation THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid revision job identity';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.type = 'commerce.claim-email-request' THEN
    IF NOT pg_catalog.pg_input_is_valid(NEW.payload ->> 'orderId', 'uuid') THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid claim request job identity';
    END IF;
    referenced_id := (NEW.payload ->> 'orderId')::uuid;
    IF NEW.payload IS DISTINCT FROM pg_catalog.jsonb_build_object('orderId', referenced_id) OR
      NEW.max_attempts <> 8 OR NEW.deduplication_key !~
        ('^commerce:claim-request:order:' || referenced_id::text ||
          ':window:[0-9]+:v1$') THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid claim request job identity';
    END IF;
    SELECT * INTO claim_order
    FROM "public"."orders" purchase_order
    WHERE purchase_order.id = referenced_id
    FOR KEY SHARE;
    IF NOT FOUND OR claim_order.status <> 'paid' OR
      claim_order.initiating_user_id IS NOT NULL OR claim_order.guest_identity_id IS NULL OR
      claim_order.purchase_email IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid claim request job identity';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.type = 'outbox.dispatch' THEN
    IF NOT pg_catalog.pg_input_is_valid(NEW.payload ->> 'outboxId', 'uuid') THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid outbox job identity';
    END IF;
    referenced_id := (NEW.payload ->> 'outboxId')::uuid;
    IF NEW.payload IS DISTINCT FROM pg_catalog.jsonb_build_object('outboxId', referenced_id) OR
      NEW.max_attempts <> 8 OR NOT (
        NEW.deduplication_key = 'outbox:' || referenced_id::text OR
        NEW.deduplication_key ~ '^outbox-key:[0-9a-f]{64}$'
      ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid outbox job identity';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.type = 'commerce.financial-admin-command' THEN
    IF pg_catalog.jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object' OR
      NOT (NEW.payload ?& ARRAY['commandId']::text[]) OR
      NEW.payload - 'commandId' IS DISTINCT FROM '{}'::jsonb OR
      pg_catalog.jsonb_typeof(NEW.payload -> 'commandId') IS DISTINCT FROM 'string' OR
      NOT pg_catalog.pg_input_is_valid(NEW.payload ->> 'commandId', 'uuid') THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'invalid financial administrator command job identity';
    END IF;
    referenced_id := (NEW.payload ->> 'commandId')::uuid;
    SELECT * INTO command_row
    FROM "public"."financial_admin_commands" command
    WHERE command.id = referenced_id
    FOR KEY SHARE;
    IF NOT FOUND OR command_row.status <> 'pending' OR
      command_row.job_id IS DISTINCT FROM NEW.id OR
      NEW.payload IS DISTINCT FROM pg_catalog.jsonb_build_object('commandId', referenced_id) OR
      NEW.deduplication_key IS DISTINCT FROM
        'commerce:financial-admin-command:' || referenced_id::text || ':v1' OR
      NEW.max_attempts <> 8 THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'invalid financial administrator command job identity';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'web job type is not permitted';
END;
$plan6bii_job_insert_guard$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."plan6b_guard_job_insert"() FROM PUBLIC, "pale_orbit_runtime";

CREATE OR REPLACE FUNCTION "public"."plan6b_guard_audit_insert"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = 'pg_catalog'
AS $plan6bii_audit_insert_guard$
DECLARE
  claim_owner name;
  expected_owner name;
  expected_signature text;
BEGIN
  IF pg_catalog.left(NEW.action, 21) = 'operations.job_retry.' OR
    NEW.resource_type = 'operations_job_retry_command' THEN
    IF NEW.action = 'operations.job_retry.requested' AND
      NEW.outcome = 'denied' AND
      NEW.resource_type = 'operations_job_retry_command' AND
      NEW.resource_id IS NULL AND
      NEW.actor_type = 'user' AND
      NEW.actor_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
      NEW.correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$' AND
      NEW.request_metadata IS NULL AND NEW.before IS NULL AND NEW.after IS NULL AND
      current_user = session_user AND
      pg_catalog.pg_has_role(session_user, 'pale_orbit_runtime', 'MEMBER') AND
      NOT pg_catalog.pg_has_role(
        session_user, 'pale_orbit_financial_worker', 'MEMBER'
      ) AND
      NULLIF(pg_catalog.current_setting(
        'pale_orbit.plan7a_operations_command_insert_id', true
      ), '') IS NULL AND
      NULLIF(pg_catalog.current_setting(
        'pale_orbit.plan7a_operations_command_transition_id', true
      ), '') IS NULL AND
      NULLIF(pg_catalog.current_setting(
        'pale_orbit.plan7a_operations_job_transition_id', true
      ), '') IS NULL AND
      NULLIF(pg_catalog.current_setting(
        'pale_orbit.plan7a_operations_job_capability', true
      ), '') IS NULL THEN
      RETURN NEW;
    END IF;

    IF NEW.action = 'operations.job_retry.requested' AND
      NEW.outcome = 'succeeded' AND
      NEW.resource_type = 'operations_job_retry_command' AND
      NEW.resource_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
      NEW.actor_type = 'user' AND
      NEW.actor_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
      NEW.correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$' AND
      NEW.request_metadata IS NULL AND NEW.before IS NULL AND
      pg_catalog.jsonb_typeof(NEW.after) = 'object' AND
      NEW.after - 'commandId' - 'targetJobId' - 'registeredKind' -
        'reasonCode' = '{}'::jsonb AND
      pg_catalog.current_setting(
        'pale_orbit.plan7a_operations_command_insert_id', true
      ) = NEW.resource_id AND
      current_user = (
        SELECT pg_catalog.pg_get_userbyid(routine.proowner)
        FROM pg_catalog.pg_proc routine
        WHERE routine.oid = pg_catalog.to_regprocedure(
          'public.submit_job_retry_command(uuid,uuid,text,integer,integer,timestamp with time zone,text,text,text,text)'
        )
      ) AND EXISTS (
        SELECT 1
        FROM "public"."operations_job_retry_commands" command
        WHERE command.id::text = NEW.resource_id
          AND command.status = 'pending'
          AND command.actor_user_id::text = NEW.actor_id
          AND command.target_job_id::text = NEW.after ->> 'targetJobId'
          AND command.target_job_kind = NEW.after ->> 'registeredKind'
          AND command.reason_code::text = NEW.after ->> 'reasonCode'
          AND command.correlation_id = NEW.correlation_id
          AND NEW.after ->> 'commandId' = command.id::text
      ) THEN
      RETURN NEW;
    END IF;

    IF NEW.action IN (
        'operations.job_retry.succeeded',
        'operations.job_retry.denied',
        'operations.job_retry.failed'
      ) AND
      NEW.outcome IN ('succeeded', 'denied', 'failed') AND
      NEW.resource_type = 'operations_job_retry_command' AND
      NEW.resource_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
      NEW.actor_type = 'user' AND
      NEW.actor_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
      NEW.correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$' AND
      NEW.request_metadata IS NULL AND NEW.before IS NULL AND
      pg_catalog.jsonb_typeof(NEW.after) = 'object' AND
      NEW.after - 'commandId' - 'targetJobId' - 'registeredKind' -
        'reasonCode' - 'resultCode' = '{}'::jsonb AND
      pg_catalog.current_setting(
        'pale_orbit.plan7a_operations_command_transition_id', true
      ) = NEW.resource_id AND
      current_user IN (
        SELECT pg_catalog.pg_get_userbyid(routine.proowner)
        FROM pg_catalog.pg_proc routine
        WHERE routine.oid IN (
          pg_catalog.to_regprocedure(
            'public.plan7a_operations_transition_job_retry_command(uuid,uuid,text,integer,integer,operations_job_retry_result_code)'
          ),
          pg_catalog.to_regprocedure(
            'public.plan7a_operations_fail_job(uuid,text,integer,integer,text)'
          ),
          pg_catalog.to_regprocedure(
            'public.plan7a_operations_exhaust_job(uuid,text,integer,integer)'
          ),
          pg_catalog.to_regprocedure(
            'public.plan7a_operations_claim_job(uuid,text,integer)'
          )
        )
      ) AND EXISTS (
        SELECT 1
        FROM "public"."operations_job_retry_commands" command
        WHERE command.id::text = NEW.resource_id
          AND command.actor_user_id::text = NEW.actor_id
          AND command.target_job_id::text = NEW.after ->> 'targetJobId'
          AND command.target_job_kind = NEW.after ->> 'registeredKind'
          AND command.reason_code::text = NEW.after ->> 'reasonCode'
          AND command.safe_result_code::text = NEW.after ->> 'resultCode'
          AND command.correlation_id = NEW.correlation_id
          AND NEW.after ->> 'commandId' = command.id::text
          AND (
            (command.status = 'succeeded' AND
              NEW.action = 'operations.job_retry.succeeded' AND
              NEW.outcome = 'succeeded') OR
            (command.status = 'denied' AND
              NEW.action = 'operations.job_retry.denied' AND
              NEW.outcome = 'denied') OR
            (command.status = 'failed' AND
              NEW.action = 'operations.job_retry.failed' AND
              NEW.outcome = 'failed')
          )
      ) THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'operations job retry audit provenance is reserved';
  END IF;

  IF NOT (
    pg_catalog.pg_has_role(session_user, 'pale_orbit_runtime', 'MEMBER')
    AND NOT pg_catalog.pg_has_role(session_user, 'pale_orbit_financial_worker', 'MEMBER')
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.action = 'commerce.guest_claimed' THEN
    SELECT pg_catalog.pg_get_userbyid(routine.proowner)
    INTO claim_owner
    FROM pg_catalog.pg_proc routine
    WHERE routine.oid = pg_catalog.to_regprocedure(
      'public.claim_guest_purchases_after_authorization(text,text)'
    );
    IF current_user = claim_owner
      AND NEW.actor_type = 'user'
      AND NEW.actor_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND NEW.outcome = 'succeeded'
      AND NEW.resource_type = 'guest_identity'
      AND NEW.resource_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND NEW.correlation_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$'
      AND NEW.request_metadata IS NULL
      AND NEW.before IS NULL
      AND pg_catalog.jsonb_typeof(NEW.after) = 'object'
      AND NEW.after - 'claimedOrderCount' - 'claimedTitleCount' = '{}'::jsonb
      AND pg_catalog.jsonb_typeof(NEW.after -> 'claimedOrderCount') = 'number'
      AND pg_catalog.jsonb_typeof(NEW.after -> 'claimedTitleCount') = 'number'
      AND NEW.after ->> 'claimedOrderCount' ~ '^[1-9][0-9]{0,8}$'
      AND NEW.after ->> 'claimedTitleCount' ~ '^[1-9][0-9]{0,8}$'
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'commerce guest claim audit provenance is reserved';
  END IF;

  IF NEW.action IN (
    'financial.issue.view', 'financial.refund_review.view',
    'financial.payout.view', 'financial.sales_export'
  ) THEN
    expected_signature := CASE NEW.action
      WHEN 'financial.issue.view'
        THEN 'public.append_financial_issue_view_audit(uuid,uuid,text,text,text)'
      WHEN 'financial.refund_review.view'
        THEN 'public.append_financial_refund_review_view_audit(uuid,uuid,text,text,text)'
      WHEN 'financial.payout.view'
        THEN 'public.append_financial_payout_view_audit(uuid,uuid,text,text,text)'
      WHEN 'financial.sales_export'
        THEN 'public.append_financial_sales_export_audit(uuid,text,text,integer,integer,integer,text,text)'
    END;
    SELECT pg_catalog.pg_get_userbyid(routine.proowner)
    INTO expected_owner
    FROM pg_catalog.pg_proc routine
    WHERE routine.oid = pg_catalog.to_regprocedure(expected_signature);
    IF current_user IS DISTINCT FROM expected_owner OR
      pg_catalog.current_setting(
        'pale_orbit.plan6bii_financial_read_audit_action', true
      ) IS DISTINCT FROM NEW.action OR
      NEW.actor_type IS DISTINCT FROM 'user' OR
      NEW.actor_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR
      NEW.outcome IS DISTINCT FROM 'succeeded' OR
      NEW.correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$' OR
      NEW.before IS NOT NULL OR NEW.after IS NOT NULL OR
      pg_catalog.jsonb_typeof(NEW.request_metadata) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION USING ERRCODE = '42501',
        MESSAGE = 'financial read audit provenance is reserved';
    END IF;
    IF NEW.action = 'financial.issue.view' AND NOT ((
      NEW.resource_type = 'financial_issue' AND
      NEW.resource_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
      NEW.request_metadata ?& ARRAY['method','route']::text[] AND
      NEW.request_metadata - 'method' - 'route' = '{}'::jsonb AND
      NEW.request_metadata ->> 'method' = 'GET' AND
      NEW.request_metadata ->> 'route' = '/admin/sales/issues/' || NEW.resource_id
    ) IS TRUE) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'financial read audit provenance is reserved';
    ELSIF NEW.action = 'financial.refund_review.view' AND NOT ((
      NEW.resource_type = 'refund' AND
      NEW.resource_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
      NEW.request_metadata ?& ARRAY['method','route']::text[] AND
      NEW.request_metadata - 'method' - 'route' = '{}'::jsonb AND
      NEW.request_metadata ->> 'method' = 'GET' AND
      NEW.request_metadata ->> 'route' = '/admin/sales/refunds/' || NEW.resource_id
    ) IS TRUE) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'financial read audit provenance is reserved';
    ELSIF NEW.action = 'financial.payout.view' AND NOT ((
      NEW.resource_type = 'payout' AND
      NEW.resource_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND
      NEW.request_metadata ?& ARRAY['method','route']::text[] AND
      NEW.request_metadata - 'method' - 'route' = '{}'::jsonb AND
      NEW.request_metadata ->> 'method' = 'GET' AND
      NEW.request_metadata ->> 'route' = '/admin/sales/payouts/' || NEW.resource_id
    ) IS TRUE) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'financial read audit provenance is reserved';
    ELSIF NEW.action = 'financial.sales_export' AND NOT ((
      NEW.resource_type = 'financial_sales_export' AND
      NEW.resource_id ~ '^[a-f0-9]{64}$' AND
      NEW.request_metadata ?& ARRAY[
        'filterFingerprint','rowCount','byteCount','currencyPairCount','method','route'
      ]::text[] AND
      NEW.request_metadata - 'filterFingerprint' - 'rowCount' - 'byteCount' -
        'currencyPairCount' - 'method' - 'route' = '{}'::jsonb AND
      NEW.request_metadata ->> 'filterFingerprint' = NEW.resource_id AND
      pg_catalog.jsonb_typeof(NEW.request_metadata -> 'rowCount') = 'number' AND
      pg_catalog.jsonb_typeof(NEW.request_metadata -> 'byteCount') = 'number' AND
      pg_catalog.jsonb_typeof(NEW.request_metadata -> 'currencyPairCount') = 'number' AND
      CASE WHEN pg_catalog.pg_input_is_valid(NEW.request_metadata ->> 'rowCount', 'integer')
        THEN (NEW.request_metadata ->> 'rowCount')::integer BETWEEN 0 AND 2147483647
        ELSE false END AND
      CASE WHEN pg_catalog.pg_input_is_valid(NEW.request_metadata ->> 'byteCount', 'integer')
        THEN (NEW.request_metadata ->> 'byteCount')::integer BETWEEN 0 AND 2147483647
        ELSE false END AND
      CASE WHEN pg_catalog.pg_input_is_valid(
          NEW.request_metadata ->> 'currencyPairCount', 'integer'
        ) THEN (NEW.request_metadata ->> 'currencyPairCount')::integer
          BETWEEN 0 AND 2147483647 ELSE false END AND
      NEW.request_metadata ->> 'method' = 'GET' AND
      NEW.request_metadata ->> 'route' = '/admin/sales/export.csv'
    ) IS TRUE) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'financial read audit provenance is reserved';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.action LIKE 'financial.%' OR NEW.action IN (
    'commerce.fulfillment_paid',
    'commerce.fulfillment_exception',
    'commerce.refund_reconciled',
    'commerce.dispute_reconciled',
    'catalog.revision.ingest.succeeded',
    'catalog.revision.ingest.failed'
  ) OR NEW.actor_id IN (
    'commerce-worker',
    'financial-worker',
    'publication-ingestion-worker'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'worker audit provenance is reserved';
  END IF;
  RETURN NEW;
END;
$plan6bii_audit_insert_guard$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."plan6b_guard_audit_insert"() FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION "public"."plan7a_operations_assert_job_capability"(
  uuid,uuid,text,integer,integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $plan7a_operations_assert_job_capability$
DECLARE
  supplied_capability text;
  supplied_digest text;
  authority_count integer;
BEGIN
  supplied_capability := pg_catalog.current_setting(
    'pale_orbit.plan7a_operations_job_capability', true
  );
  IF $1 IS NULL OR $2 IS NULL OR $3 IS NULL OR $4 IS NULL OR $5 IS NULL OR
    $3 !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' OR
    $4 NOT BETWEEN 1 AND 2147483647 OR $5 NOT BETWEEN 1 AND 2147483647 OR
    supplied_capability IS NULL OR supplied_capability !~ '^[A-Za-z0-9_-]{43}$' THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  supplied_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    supplied_capability, 'UTF8'
  )), 'hex');
  SELECT pg_catalog.count(*)::integer INTO authority_count
  FROM "public"."operations_job_retry_claims" claim
  JOIN "public"."jobs" job ON job.id = claim.job_id
  JOIN "public"."operations_job_retry_commands" command
    ON command.id = claim.command_id
  WHERE claim.job_id = $1 AND claim.command_id = $2 AND
    claim.lease_owner = $3 AND claim.attempt = $4 AND claim.generation = $5 AND
    claim.capability_sha256 = supplied_digest AND claim.state = 'active' AND
    claim.invalidated_at IS NULL AND claim.expires_at > pg_catalog.clock_timestamp() AND
    job.id = $1 AND job.type = 'operations.job-retry-command' AND
    job.status = 'running' AND job.attempts = $4 AND job.locked_by = $3 AND
    job.locked_at IS NOT NULL AND job.run_at = claim.expires_at AND
    job.payload = pg_catalog.jsonb_build_object('commandId', $2) AND
    job.deduplication_key = 'operations:job-retry-command:' || $2::text || ':v1' AND
    job.max_attempts = 8;
  IF authority_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
END;
$plan7a_operations_assert_job_capability$;--> statement-breakpoint

CREATE FUNCTION "public"."plan7a_operations_guard_command_update"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = 'pg_catalog'
AS $plan7a_operations_guard_command_update$
BEGIN
  IF current_user NOT IN (
      SELECT pg_catalog.pg_get_userbyid(routine.proowner)
      FROM pg_catalog.pg_proc routine
      WHERE routine.oid IN (
        pg_catalog.to_regprocedure(
          'public.plan7a_operations_transition_job_retry_command(uuid,uuid,text,integer,integer,operations_job_retry_result_code)'
        ),
        pg_catalog.to_regprocedure(
          'public.plan7a_operations_fail_job(uuid,text,integer,integer,text)'
        ),
        pg_catalog.to_regprocedure(
          'public.plan7a_operations_exhaust_job(uuid,text,integer,integer)'
        ),
        pg_catalog.to_regprocedure(
          'public.plan7a_operations_claim_job(uuid,text,integer)'
        )
      )
    ) OR pg_catalog.current_setting(
      'pale_orbit.plan7a_operations_command_transition_id', true
    ) IS DISTINCT FROM OLD.id::text OR OLD.status <> 'pending' OR
    NEW.status IS NULL OR NEW.status NOT IN ('succeeded', 'denied', 'failed') OR
    NEW.id IS DISTINCT FROM OLD.id OR NEW.kind IS DISTINCT FROM OLD.kind OR
    NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id OR
    NEW.target_job_id IS DISTINCT FROM OLD.target_job_id OR
    NEW.target_job_kind IS DISTINCT FROM OLD.target_job_kind OR
    NEW.expected_status IS DISTINCT FROM OLD.expected_status OR
    NEW.expected_attempts IS DISTINCT FROM OLD.expected_attempts OR
    NEW.expected_max_attempts IS DISTINCT FROM OLD.expected_max_attempts OR
    NEW.expected_updated_at IS DISTINCT FROM OLD.expected_updated_at OR
    NEW.reason_code IS DISTINCT FROM OLD.reason_code OR
    NEW.correlation_id IS DISTINCT FROM OLD.correlation_id OR
    NEW.idempotency_key_sha256 IS DISTINCT FROM OLD.idempotency_key_sha256 OR
    NEW.input_fingerprint_sha256 IS DISTINCT FROM OLD.input_fingerprint_sha256 OR
    NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.safe_result_code IS NULL OR
    NEW.completed_at IS NULL OR NEW.updated_at IS DISTINCT FROM NEW.completed_at OR
    NEW.updated_at < OLD.updated_at OR NOT pg_catalog.isfinite(NEW.updated_at) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations command authority is not current';
  END IF;
  IF NOT (
    (NEW.status = 'denied' AND NEW.safe_result_code = 'actor_not_authorized') OR
    (NEW.status = 'failed' AND NEW.safe_result_code IN (
      'retry_command_invalid', 'retry_command_exhausted', 'unexpected_failure'
    )) OR EXISTS (
      SELECT 1
      FROM "public"."plan7a_operations_job_catalog"() catalog
      WHERE catalog.kind = NEW.target_job_kind AND
        NEW.status::text || '/' || NEW.safe_result_code::text =
          ANY(catalog.allowed_policy_outcomes)
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations command authority is not current';
  END IF;
  RETURN NEW;
END;
$plan7a_operations_guard_command_update$;--> statement-breakpoint

CREATE FUNCTION "public"."plan7a_operations_guard_command_delete"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = 'pg_catalog'
AS $plan7a_operations_guard_command_delete$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000',
    MESSAGE = 'Plan 7A operations command history is immutable';
END;
$plan7a_operations_guard_command_delete$;--> statement-breakpoint

CREATE FUNCTION "public"."plan7a_operations_guard_job_transition"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = 'pg_catalog'
AS $plan7a_operations_guard_job_transition$
DECLARE
  command_uuid uuid;
  claim_row "public"."operations_job_retry_claims"%ROWTYPE;
  supplied_capability text;
  supplied_digest text;
BEGIN
  IF OLD.type IS DISTINCT FROM 'operations.job-retry-command' AND
    NEW.type IS DISTINCT FROM 'operations.job-retry-command' AND
    coalesce(
      OLD.deduplication_key NOT LIKE 'operations:job-retry-command:%', true
    ) AND coalesce(
      NEW.deduplication_key NOT LIKE 'operations:job-retry-command:%', true
    ) THEN
    RETURN NEW;
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id OR OLD.created_at IS DISTINCT FROM NEW.created_at OR
    OLD.type IS DISTINCT FROM 'operations.job-retry-command' OR
    NEW.type IS DISTINCT FROM 'operations.job-retry-command' OR
    OLD.type IS DISTINCT FROM NEW.type OR OLD.payload IS DISTINCT FROM NEW.payload OR
    OLD.deduplication_key IS DISTINCT FROM NEW.deduplication_key OR
    OLD.max_attempts IS DISTINCT FROM 8 OR NEW.max_attempts IS DISTINCT FROM 8 OR
    pg_catalog.jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object' OR
    NEW.payload - 'commandId' IS DISTINCT FROM '{}'::jsonb OR
    NOT pg_catalog.pg_input_is_valid(NEW.payload ->> 'commandId', 'uuid') THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  command_uuid := (NEW.payload ->> 'commandId')::uuid;
  IF NEW.payload <> pg_catalog.jsonb_build_object('commandId', command_uuid) OR
    NEW.deduplication_key IS DISTINCT FROM
      'operations:job-retry-command:' || command_uuid::text || ':v1' OR
    pg_catalog.current_setting(
      'pale_orbit.plan7a_operations_job_transition_id', true
    ) IS DISTINCT FROM NEW.id::text OR current_user NOT IN (
      SELECT pg_catalog.pg_get_userbyid(routine.proowner)
      FROM pg_catalog.pg_proc routine
      WHERE routine.oid IN (
        pg_catalog.to_regprocedure('public.plan7a_operations_claim_job(uuid,text,integer)'),
        pg_catalog.to_regprocedure(
          'public.plan7a_operations_renew_job_claim(uuid,text,integer,integer)'
        ),
        pg_catalog.to_regprocedure(
          'public.plan7a_operations_relinquish_job(uuid,text,integer,integer,text,integer)'
        ),
        pg_catalog.to_regprocedure(
          'public.plan7a_operations_complete_job(uuid,text,integer,integer)'
        ),
        pg_catalog.to_regprocedure(
          'public.plan7a_operations_fail_job(uuid,text,integer,integer,text)'
        ),
        pg_catalog.to_regprocedure(
          'public.plan7a_operations_exhaust_job(uuid,text,integer,integer)'
        )
      )
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  SELECT * INTO claim_row
  FROM "public"."operations_job_retry_claims" claim
  WHERE claim.job_id = NEW.id AND claim.command_id = command_uuid
    AND claim.state = 'active'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  supplied_capability := pg_catalog.current_setting(
    'pale_orbit.plan7a_operations_job_capability', true
  );
  IF supplied_capability IS NULL OR supplied_capability !~ '^[A-Za-z0-9_-]{43}$' THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  supplied_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    supplied_capability, 'UTF8'
  )), 'hex');
  IF claim_row.capability_sha256 IS DISTINCT FROM supplied_digest OR
    claim_row.generation NOT BETWEEN 1 AND 2147483647 OR
    claim_row.expires_at <= pg_catalog.clock_timestamp() OR
    ((NEW.status = 'running') AND (
      claim_row.lease_owner IS DISTINCT FROM NEW.locked_by OR
      claim_row.attempt IS DISTINCT FROM NEW.attempts
    )) OR ((NEW.status <> 'running') AND (
      claim_row.lease_owner IS DISTINCT FROM OLD.locked_by OR
      claim_row.attempt IS DISTINCT FROM OLD.attempts
    )) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;

  IF OLD.status = 'pending' AND NEW.status = 'running' THEN
    IF NEW.attempts IS DISTINCT FROM OLD.attempts + 1 OR
      NEW.attempts IS DISTINCT FROM claim_row.attempt OR
      NEW.locked_by IS DISTINCT FROM claim_row.lease_owner OR
      NEW.locked_at IS NULL OR NEW.run_at IS DISTINCT FROM claim_row.expires_at OR
      NEW.last_error IS DISTINCT FROM OLD.last_error OR
      NEW.rerun_requested_at IS NOT NULL OR NEW.completed_at IS NOT NULL OR
      NEW.updated_at IS DISTINCT FROM NEW.locked_at THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'Plan 7A operations job authority is not current';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'running' AND NEW.status = 'running' THEN
    IF NEW.attempts IS DISTINCT FROM claim_row.attempt OR
      NEW.locked_by IS DISTINCT FROM claim_row.lease_owner OR
      NEW.locked_at IS NULL OR NEW.run_at IS DISTINCT FROM claim_row.expires_at OR
      NEW.last_error IS DISTINCT FROM OLD.last_error OR
      NEW.rerun_requested_at IS DISTINCT FROM OLD.rerun_requested_at OR
      NEW.completed_at IS NOT NULL OR NEW.updated_at IS DISTINCT FROM NEW.locked_at THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'Plan 7A operations job authority is not current';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'running' AND NEW.status = 'pending' THEN
    IF NEW.attempts IS DISTINCT FROM OLD.attempts OR NEW.locked_at IS NOT NULL OR
      NEW.locked_by IS NOT NULL OR NEW.last_error IS NULL OR NEW.last_error NOT IN (
        'Transient job handler failure', 'Transient job completion failure'
      ) OR NEW.rerun_requested_at IS NOT NULL OR NEW.completed_at IS NOT NULL OR
      NEW.run_at <= NEW.updated_at OR NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'Plan 7A operations job authority is not current';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'running' AND NEW.status IN ('succeeded', 'failed') THEN
    IF NEW.attempts IS DISTINCT FROM OLD.attempts OR NEW.locked_at IS NOT NULL OR
      NEW.locked_by IS NOT NULL OR NEW.run_at IS DISTINCT FROM OLD.run_at OR
      NEW.rerun_requested_at IS NOT NULL OR
      NEW.completed_at IS NULL OR NEW.updated_at IS DISTINCT FROM NEW.completed_at OR
      (NEW.status = 'succeeded' AND NEW.last_error IS NOT NULL) OR
      (NEW.status = 'failed' AND (NEW.last_error IS NULL OR NEW.last_error NOT IN (
        'Invalid operations job retry command identity.',
        'Operations job retry command permanently failed.',
        'Permanent job handler failure',
        'Operations job retry command exhausted.'
      ))) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'Plan 7A operations job authority is not current';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '55000',
    MESSAGE = 'Plan 7A operations job authority is not current';
END;
$plan7a_operations_guard_job_transition$;--> statement-breakpoint

CREATE TRIGGER "plan7a_operations_retry_commands_update_guard"
BEFORE UPDATE ON "public"."operations_job_retry_commands"
FOR EACH ROW EXECUTE FUNCTION "public"."plan7a_operations_guard_command_update"();--> statement-breakpoint
CREATE TRIGGER "plan7a_operations_retry_commands_delete_guard"
BEFORE DELETE ON "public"."operations_job_retry_commands"
FOR EACH ROW EXECUTE FUNCTION "public"."plan7a_operations_guard_command_delete"();--> statement-breakpoint
CREATE TRIGGER "plan7a_operations_jobs_transition_guard"
BEFORE UPDATE ON "public"."jobs"
FOR EACH ROW EXECUTE FUNCTION "public"."plan7a_operations_guard_job_transition"();--> statement-breakpoint

CREATE FUNCTION "public"."list_operational_jobs"(
  uuid,text,text,timestamp with time zone,uuid,integer
)
RETURNS TABLE (
  job_id uuid,
  kind text,
  label text,
  status text,
  attempts integer,
  max_attempts integer,
  run_at text,
  completed_at text,
  created_at text,
  updated_at text,
  retry_disposition text,
  policy_availability text,
  safe_failure_code text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $list_operational_jobs$
DECLARE
  requested_actor uuid := $1;
  requested_status text := $2;
  requested_kind text := $3;
  requested_before_updated_at timestamptz := $4;
  requested_before_id uuid := $5;
  requested_page_size integer := coalesce($6, 50);
BEGIN
  IF NOT (
    pg_catalog.pg_has_role(session_user, 'pale_orbit_runtime', 'MEMBER') AND
    NOT pg_catalog.pg_has_role(session_user, 'pale_orbit_financial_worker', 'MEMBER') AND
    NOT pg_catalog.pg_has_role(session_user, 'pale_orbit_storage_cleanup', 'MEMBER')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'job operations listing is not permitted';
  END IF;
  IF requested_actor IS NULL OR requested_page_size NOT BETWEEN 1 AND 100 OR
    requested_status IS NOT NULL AND requested_status NOT IN (
      'pending', 'running', 'succeeded', 'failed'
    ) OR (requested_before_updated_at IS NULL) <> (requested_before_id IS NULL) OR
    requested_before_updated_at IS NOT NULL AND
      NOT pg_catalog.isfinite(requested_before_updated_at) OR
    requested_kind IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "public"."plan7a_operations_job_catalog"() catalog
      WHERE catalog.kind = requested_kind
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid job operations list request';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('pale-orbit:user-roles:admin')
  );
  IF NOT EXISTS (
    SELECT 1 FROM "public"."user_roles" role_row
    WHERE role_row.user_id = requested_actor AND role_row.role = 'admin'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'job operations capability is not current';
  END IF;

  RETURN QUERY
  WITH catalog AS (
    SELECT * FROM public.plan7a_operations_job_catalog()
  )
  SELECT job.id,
    CASE WHEN definition.kind IS NULL THEN 'unregistered' ELSE job.type END,
    coalesce(definition.label, 'Unregistered job'),
    job.status::text, job.attempts, job.max_attempts,
    pg_catalog.to_char(pg_catalog.timezone('UTC', job.run_at),
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    CASE WHEN job.completed_at IS NULL THEN NULL ELSE pg_catalog.to_char(
      pg_catalog.timezone('UTC', job.completed_at),
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ) END,
    pg_catalog.to_char(pg_catalog.timezone('UTC', job.created_at),
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    pg_catalog.to_char(pg_catalog.timezone('UTC', job.updated_at),
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    coalesce(definition.retry_disposition, 'never'),
    coalesce(definition.policy_availability, 'excluded'),
    "public"."plan7a_operations_safe_failure_code"(job.type, job.last_error)
  FROM "public"."jobs" job
  LEFT JOIN catalog definition ON definition.kind = job.type
  WHERE (requested_status IS NULL OR job.status::text = requested_status)
    AND (requested_kind IS NULL OR job.type = requested_kind)
    AND (requested_before_updated_at IS NULL OR
      (job.updated_at, job.id) < (requested_before_updated_at, requested_before_id))
  ORDER BY job.updated_at DESC, job.id DESC
  LIMIT requested_page_size;
END;
$list_operational_jobs$;--> statement-breakpoint

CREATE FUNCTION "public"."submit_job_retry_command"(
  uuid,uuid,text,integer,integer,timestamp with time zone,text,text,text,text
)
RETURNS TABLE (
  command_id uuid,
  kind text,
  target_job_id uuid,
  target_kind text,
  reason_code text,
  correlation_id text,
  status text,
  result_code text,
  created_at text,
  updated_at text,
  completed_at text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $submit_job_retry_command$
DECLARE
  requested_actor uuid := $1;
  requested_target uuid := $2;
  requested_kind text := $3;
  requested_attempts integer := $4;
  requested_max_attempts integer := $5;
  requested_updated_at timestamptz := $6;
  requested_reason text := $7;
  requested_correlation text := $8;
  requested_idempotency_hash text := $9;
  requested_fingerprint text := $10;
  canonical_expected_updated_at text;
  canonical_input text;
  rebuilt_fingerprint text;
  command_uuid uuid;
  command_row "public"."operations_job_retry_commands"%ROWTYPE;
  target_row "public"."jobs"%ROWTYPE;
BEGIN
  IF NOT (
    pg_catalog.pg_has_role(session_user, 'pale_orbit_runtime', 'MEMBER') AND
    NOT pg_catalog.pg_has_role(session_user, 'pale_orbit_financial_worker', 'MEMBER') AND
    NOT pg_catalog.pg_has_role(session_user, 'pale_orbit_storage_cleanup', 'MEMBER')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'job retry command submission is not permitted';
  END IF;
  IF requested_actor IS NULL OR requested_target IS NULL OR requested_kind IS NULL OR
    requested_attempts IS NULL OR requested_max_attempts IS NULL OR
    requested_updated_at IS NULL OR NOT pg_catalog.isfinite(requested_updated_at) OR
    requested_attempts NOT BETWEEN 1 AND requested_max_attempts OR
    requested_max_attempts NOT BETWEEN 1 AND 2147483647 OR
    requested_reason IS NULL OR requested_reason NOT IN (
      'dependency_recovered', 'configuration_recovered', 'operator_reassessment'
    ) OR requested_correlation IS NULL OR
    requested_correlation !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$' OR
    requested_idempotency_hash IS NULL OR
    requested_idempotency_hash !~ '^[a-f0-9]{64}$' OR
    requested_fingerprint IS NULL OR requested_fingerprint !~ '^[a-f0-9]{64}$' OR
    NOT EXISTS (
      SELECT 1 FROM "public"."plan7a_operations_job_catalog"() catalog
      WHERE catalog.kind = requested_kind
        AND catalog.max_attempts = requested_max_attempts
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid job retry command';
  END IF;

  canonical_expected_updated_at := pg_catalog.to_char(
    pg_catalog.timezone('UTC', requested_updated_at),
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  );
  canonical_input :=
    '{"targetJobId":' || pg_catalog.to_json(requested_target::text)::text ||
    ',"expectedKind":' || pg_catalog.to_json(requested_kind)::text ||
    ',"expectedStatus":"failed"' ||
    ',"expectedAttempts":' || requested_attempts::text ||
    ',"expectedMaxAttempts":' || requested_max_attempts::text ||
    ',"expectedUpdatedAt":' ||
      pg_catalog.to_json(canonical_expected_updated_at)::text ||
    ',"reasonCode":' || pg_catalog.to_json(requested_reason)::text || '}';
  rebuilt_fingerprint := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    canonical_input, 'UTF8'
  )), 'hex');
  IF rebuilt_fingerprint IS DISTINCT FROM requested_fingerprint THEN
    RAISE EXCEPTION USING ERRCODE = '40900',
      MESSAGE = 'job retry command input fingerprint conflict';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('pale-orbit:user-roles:admin')
  );
  IF NOT EXISTS (
    SELECT 1 FROM "public"."user_roles" role_row
    WHERE role_row.user_id = requested_actor AND role_row.role = 'admin'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'job operations capability is not current';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'pale-orbit:plan7a-operations-idempotency:' || requested_actor::text || ':' ||
      requested_idempotency_hash,
    0
  ));

  SELECT * INTO command_row
  FROM "public"."operations_job_retry_commands" command
  WHERE command.actor_user_id = requested_actor
    AND command.idempotency_key_sha256 = requested_idempotency_hash
  FOR UPDATE;
  IF FOUND THEN
    IF command_row.target_job_id IS DISTINCT FROM requested_target OR
      command_row.target_job_kind IS DISTINCT FROM requested_kind OR
      command_row.expected_status IS DISTINCT FROM 'failed' OR
      command_row.expected_attempts IS DISTINCT FROM requested_attempts OR
      command_row.expected_max_attempts IS DISTINCT FROM requested_max_attempts OR
      command_row.expected_updated_at IS DISTINCT FROM requested_updated_at OR
      command_row.reason_code::text IS DISTINCT FROM requested_reason OR
      command_row.input_fingerprint_sha256 IS DISTINCT FROM requested_fingerprint THEN
      RAISE EXCEPTION USING ERRCODE = '40900',
        MESSAGE = 'job retry command idempotency conflict';
    END IF;
    RETURN QUERY SELECT command_row.id, command_row.kind::text,
      command_row.target_job_id, command_row.target_job_kind::text,
      command_row.reason_code::text, command_row.correlation_id::text,
      command_row.status::text, command_row.safe_result_code::text,
      pg_catalog.to_char(pg_catalog.timezone('UTC', command_row.created_at),
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      pg_catalog.to_char(pg_catalog.timezone('UTC', command_row.updated_at),
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      CASE WHEN command_row.completed_at IS NULL THEN NULL ELSE pg_catalog.to_char(
        pg_catalog.timezone('UTC', command_row.completed_at),
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) END;
    RETURN;
  END IF;

  SELECT * INTO target_row
  FROM "public"."jobs" job
  WHERE job.id = requested_target
  FOR UPDATE;
  IF NOT FOUND OR target_row.type IS DISTINCT FROM requested_kind OR
    target_row.status IS DISTINCT FROM 'failed' OR
    target_row.attempts IS DISTINCT FROM requested_attempts OR
    target_row.max_attempts IS DISTINCT FROM requested_max_attempts OR
    target_row.updated_at IS DISTINCT FROM requested_updated_at THEN
    RAISE EXCEPTION USING ERRCODE = '40900',
      MESSAGE = 'job retry command target state conflict';
  END IF;

  command_uuid := pg_catalog.gen_random_uuid();
  PERFORM pg_catalog.set_config(
    'pale_orbit.plan7a_operations_command_insert_id', command_uuid::text, true
  );
  INSERT INTO "public"."operations_job_retry_commands" (
    id, actor_user_id, target_job_id, target_job_kind, expected_status,
    expected_attempts, expected_max_attempts, expected_updated_at, reason_code,
    correlation_id, idempotency_key_sha256, input_fingerprint_sha256
  ) VALUES (
    command_uuid, requested_actor, requested_target, requested_kind, 'failed',
    requested_attempts, requested_max_attempts, requested_updated_at,
    requested_reason::"public"."operations_job_retry_reason_code",
    requested_correlation, requested_idempotency_hash, requested_fingerprint
  ) RETURNING * INTO command_row;
  INSERT INTO "public"."jobs" (
    type, payload, deduplication_key, max_attempts
  ) VALUES (
    'operations.job-retry-command',
    pg_catalog.jsonb_build_object('commandId', command_uuid),
    'operations:job-retry-command:' || command_uuid::text || ':v1', 8
  );
  INSERT INTO "public"."audit_events" (
    actor_type, actor_id, action, outcome, resource_type, resource_id,
    correlation_id, request_metadata, before, after
  ) VALUES (
    'user'::"public"."audit_actor_type", requested_actor::text,
    'operations.job_retry.requested', 'succeeded'::"public"."audit_outcome",
    'operations_job_retry_command', command_uuid::text, requested_correlation,
    NULL, NULL, pg_catalog.jsonb_build_object(
      'commandId', command_uuid, 'targetJobId', requested_target,
      'registeredKind', requested_kind, 'reasonCode', requested_reason
    )
  );

  RETURN QUERY SELECT command_row.id, command_row.kind::text,
    command_row.target_job_id, command_row.target_job_kind::text,
    command_row.reason_code::text, command_row.correlation_id::text,
    command_row.status::text, command_row.safe_result_code::text,
    pg_catalog.to_char(pg_catalog.timezone('UTC', command_row.created_at),
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    pg_catalog.to_char(pg_catalog.timezone('UTC', command_row.updated_at),
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), NULL::text;
END;
$submit_job_retry_command$;--> statement-breakpoint

CREATE FUNCTION "public"."get_owned_job_retry_command"(uuid,uuid)
RETURNS TABLE (
  command_id uuid,
  kind text,
  target_job_id uuid,
  target_kind text,
  reason_code text,
  correlation_id text,
  status text,
  result_code text,
  created_at text,
  updated_at text,
  completed_at text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $get_owned_job_retry_command$
BEGIN
  IF NOT (
    pg_catalog.pg_has_role(session_user, 'pale_orbit_runtime', 'MEMBER') AND
    NOT pg_catalog.pg_has_role(session_user, 'pale_orbit_financial_worker', 'MEMBER') AND
    NOT pg_catalog.pg_has_role(session_user, 'pale_orbit_storage_cleanup', 'MEMBER')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'job retry command status is not permitted';
  END IF;
  IF $1 IS NULL OR $2 IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid job retry command status request';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('pale-orbit:user-roles:admin')
  );
  IF NOT EXISTS (
    SELECT 1 FROM "public"."user_roles" role_row
    WHERE role_row.user_id = $1 AND role_row.role = 'admin'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'job operations capability is not current';
  END IF;
  RETURN QUERY
  SELECT command.id, command.kind::text, command.target_job_id,
    command.target_job_kind::text, command.reason_code::text,
    command.correlation_id::text,
    command.status::text, command.safe_result_code::text,
    pg_catalog.to_char(pg_catalog.timezone('UTC', command.created_at),
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    pg_catalog.to_char(pg_catalog.timezone('UTC', command.updated_at),
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    CASE WHEN command.completed_at IS NULL THEN NULL ELSE pg_catalog.to_char(
      pg_catalog.timezone('UTC', command.completed_at),
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ) END
  FROM "public"."operations_job_retry_commands" command
  WHERE command.id = $2 AND command.actor_user_id = $1;
END;
$get_owned_job_retry_command$;--> statement-breakpoint

CREATE FUNCTION "public"."plan7a_operations_claim_job"(uuid,text,integer)
RETURNS TABLE (
  job_id uuid,
  job_kind text,
  payload jsonb,
  deduplication_key text,
  attempt integer,
  max_attempts integer,
  lease_owner text,
  lease_generation integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $plan7a_operations_claim_job$
DECLARE
  requested_job uuid := $1;
  requested_owner text := $2;
  requested_duration integer := $3;
  supplied_capability text;
  supplied_digest text;
  eligibility_now timestamptz;
  lease_now timestamptz;
  lease_expires_at timestamptz;
  next_attempt integer;
  next_generation integer;
  command_uuid uuid;
  job_row "public"."jobs"%ROWTYPE;
  claim_row "public"."operations_job_retry_claims"%ROWTYPE;
  command_row "public"."operations_job_retry_commands"%ROWTYPE;
  command_transitioned boolean := false;
  terminal_now timestamptz;
BEGIN
  IF NOT (
    session_user = (
      SELECT pg_catalog.pg_get_userbyid(database_row.datdba)
      FROM pg_catalog.pg_database database_row
      WHERE database_row.datname = pg_catalog.current_database()
    ) OR pg_catalog.pg_has_role(
      session_user, 'pale_orbit_financial_worker', 'MEMBER'
    )
  ) OR pg_catalog.pg_has_role(
    session_user, 'pale_orbit_storage_cleanup', 'MEMBER'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  supplied_capability := pg_catalog.current_setting(
    'pale_orbit.plan7a_operations_job_capability', true
  );
  IF requested_job IS NULL OR requested_owner IS NULL OR
    requested_owner !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' OR
    requested_duration IS NULL OR requested_duration NOT BETWEEN 1 AND 86400000 OR
    supplied_capability IS NULL OR supplied_capability !~ '^[A-Za-z0-9_-]{43}$' THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  supplied_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    supplied_capability, 'UTF8'
  )), 'hex');

  SELECT * INTO job_row
  FROM "public"."jobs" job
  WHERE job.id = requested_job
  FOR UPDATE;
  IF NOT FOUND OR job_row.type <> 'operations.job-retry-command' OR
    job_row.max_attempts <> 8 OR job_row.attempts NOT BETWEEN 0 AND 8 OR
    (job_row.status = 'pending' AND job_row.attempts >= job_row.max_attempts) OR
    pg_catalog.jsonb_typeof(job_row.payload) <> 'object' OR
    job_row.payload - 'commandId' <> '{}'::jsonb OR
    NOT pg_catalog.pg_input_is_valid(job_row.payload ->> 'commandId', 'uuid') OR
    job_row.deduplication_key IS DISTINCT FROM
      'operations:job-retry-command:' || (job_row.payload ->> 'commandId') || ':v1' THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  eligibility_now := pg_catalog.clock_timestamp();
  IF NOT (
    (job_row.status = 'pending' AND job_row.run_at <= eligibility_now) OR
    (job_row.status = 'running' AND job_row.run_at <= eligibility_now)
  ) THEN
    RETURN;
  END IF;
  command_uuid := (job_row.payload ->> 'commandId')::uuid;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'pale-orbit:plan7a-operations-job-lease:' || requested_job::text, 0
  ));
  SELECT * INTO claim_row
  FROM "public"."operations_job_retry_claims" claim
  WHERE claim.job_id = requested_job
  FOR UPDATE;
  IF FOUND THEN
    IF claim_row.command_id IS DISTINCT FROM command_uuid OR
      claim_row.generation >= 2147483647 OR
      claim_row.capability_sha256 = supplied_digest OR
      (job_row.status = 'pending' AND claim_row.state <> 'invalidated') OR
      (job_row.status = 'running' AND (
        claim_row.state <> 'active' OR claim_row.expires_at > eligibility_now OR
        claim_row.attempt IS DISTINCT FROM job_row.attempts OR
        claim_row.lease_owner IS DISTINCT FROM job_row.locked_by OR
        claim_row.expires_at IS DISTINCT FROM job_row.run_at
      )) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'Plan 7A operations job authority is not current';
    END IF;
    next_generation := claim_row.generation + 1;
  ELSE
    IF job_row.status <> 'pending' OR job_row.attempts <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'Plan 7A operations job authority is not current';
    END IF;
    next_generation := 1;
  END IF;
  SELECT * INTO command_row
  FROM "public"."operations_job_retry_commands" command
  WHERE command.id = command_uuid
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  lease_now := pg_catalog.clock_timestamp();
  next_attempt := CASE
    WHEN job_row.status = 'pending' THEN job_row.attempts + 1
    WHEN job_row.attempts < job_row.max_attempts THEN job_row.attempts + 1
    ELSE job_row.attempts
  END;
  lease_expires_at := lease_now +
    (requested_duration::double precision * interval '1 millisecond');
  INSERT INTO "public"."operations_job_retry_claims" (
    job_id, command_id, generation, attempt, lease_owner,
    capability_sha256, lease_duration_ms, state, expires_at,
    issued_at, renewed_at, invalidated_at
  ) VALUES (
    requested_job, command_uuid, next_generation, next_attempt, requested_owner,
    supplied_digest, requested_duration, 'active', lease_expires_at,
    lease_now, NULL, NULL
  ) ON CONFLICT ON CONSTRAINT "plan7a_operations_retry_claims_pkey" DO UPDATE SET
    command_id = EXCLUDED.command_id,
    generation = EXCLUDED.generation,
    attempt = EXCLUDED.attempt,
    lease_owner = EXCLUDED.lease_owner,
    capability_sha256 = EXCLUDED.capability_sha256,
    lease_duration_ms = EXCLUDED.lease_duration_ms,
    state = EXCLUDED.state,
    expires_at = EXCLUDED.expires_at,
    issued_at = EXCLUDED.issued_at,
    renewed_at = NULL,
    invalidated_at = NULL;
  PERFORM pg_catalog.set_config(
    'pale_orbit.plan7a_operations_job_transition_id', requested_job::text, true
  );
  UPDATE "public"."jobs" job SET
    status = 'running', attempts = next_attempt,
    locked_at = lease_now, locked_by = requested_owner,
    run_at = lease_expires_at, rerun_requested_at = NULL,
    updated_at = lease_now
  WHERE job.id = requested_job;

  IF job_row.status = 'running' AND job_row.attempts = job_row.max_attempts THEN
    IF command_row.status = 'pending' THEN
      terminal_now := pg_catalog.clock_timestamp();
      PERFORM pg_catalog.set_config(
        'pale_orbit.plan7a_operations_command_transition_id', command_uuid::text, true
      );
      UPDATE "public"."operations_job_retry_commands" command SET
        status = 'failed', safe_result_code = 'retry_command_exhausted',
        updated_at = terminal_now, completed_at = terminal_now
      WHERE command.id = command_uuid AND command.status = 'pending'
      RETURNING true INTO command_transitioned;
      IF command_transitioned THEN
        INSERT INTO "public"."audit_events" (
          actor_type, actor_id, action, outcome, resource_type, resource_id,
          correlation_id, request_metadata, before, after
        ) SELECT 'user'::"public"."audit_actor_type", command.actor_user_id::text,
          'operations.job_retry.failed', 'failed'::"public"."audit_outcome",
          'operations_job_retry_command', command.id::text, command.correlation_id,
          NULL, NULL, pg_catalog.jsonb_build_object(
            'commandId', command.id, 'targetJobId', command.target_job_id,
            'registeredKind', command.target_job_kind,
            'reasonCode', command.reason_code,
            'resultCode', command.safe_result_code
          )
        FROM "public"."operations_job_retry_commands" command
        WHERE command.id = command_uuid;
      END IF;
      UPDATE "public"."jobs" job SET
        status = 'failed', locked_at = NULL, locked_by = NULL,
        last_error = 'Operations job retry command exhausted.',
        completed_at = terminal_now, updated_at = terminal_now
      WHERE job.id = requested_job;
    ELSE
      terminal_now := pg_catalog.clock_timestamp();
      UPDATE "public"."jobs" job SET
        status = 'succeeded', locked_at = NULL, locked_by = NULL,
        last_error = NULL, completed_at = terminal_now, updated_at = terminal_now
      WHERE job.id = requested_job;
    END IF;
    UPDATE "public"."operations_job_retry_claims" claim SET
      state = 'invalidated', invalidated_at = pg_catalog.clock_timestamp()
    WHERE claim.job_id = requested_job AND claim.generation = next_generation;
    RETURN;
  END IF;

  RETURN QUERY SELECT requested_job, job_row.type::text, job_row.payload,
    job_row.deduplication_key::text, next_attempt, job_row.max_attempts,
    requested_owner, next_generation;
END;
$plan7a_operations_claim_job$;--> statement-breakpoint

CREATE FUNCTION "public"."plan7a_operations_renew_job_claim"(
  uuid,text,integer,integer
)
RETURNS TABLE (applied boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $plan7a_operations_renew_job_claim$
DECLARE
  job_row "public"."jobs"%ROWTYPE;
  claim_row "public"."operations_job_retry_claims"%ROWTYPE;
  renew_now timestamptz;
  renew_expires_at timestamptz;
BEGIN
  IF NOT (
    session_user = (
      SELECT pg_catalog.pg_get_userbyid(database_row.datdba)
      FROM pg_catalog.pg_database database_row
      WHERE database_row.datname = pg_catalog.current_database()
    ) OR pg_catalog.pg_has_role(
      session_user, 'pale_orbit_financial_worker', 'MEMBER'
    )
  ) OR pg_catalog.pg_has_role(
    session_user, 'pale_orbit_storage_cleanup', 'MEMBER'
  ) OR $1 IS NULL OR $2 IS NULL OR $2 !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' OR
    $3 IS NULL OR $4 IS NULL OR
    $3 NOT BETWEEN 1 AND 2147483647 OR $4 NOT BETWEEN 1 AND 2147483647 THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  SELECT * INTO job_row FROM "public"."jobs" job
  WHERE job.id = $1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(
    'pale-orbit:plan7a-operations-job-lease:' || $1::text, 0
  ));
  SELECT * INTO claim_row
  FROM "public"."operations_job_retry_claims" claim
  WHERE claim.job_id = $1 FOR UPDATE;
  IF NOT FOUND OR claim_row.lease_owner IS DISTINCT FROM $2 OR
    claim_row.attempt IS DISTINCT FROM $3 OR claim_row.generation IS DISTINCT FROM $4 THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  PERFORM "public"."plan7a_operations_assert_job_capability"(
    $1, claim_row.command_id, $2, $3, $4
  );
  renew_now := pg_catalog.clock_timestamp();
  renew_expires_at := renew_now +
    (claim_row.lease_duration_ms::double precision * interval '1 millisecond');
  UPDATE "public"."operations_job_retry_claims" claim SET
    renewed_at = renew_now, expires_at = renew_expires_at
  WHERE claim.job_id = $1 AND claim.generation = $4 AND claim.state = 'active';
  PERFORM pg_catalog.set_config(
    'pale_orbit.plan7a_operations_job_transition_id', $1::text, true
  );
  UPDATE "public"."jobs" job SET
    locked_at = renew_now, updated_at = renew_now, run_at = renew_expires_at
  WHERE job.id = $1 AND job.status = 'running' AND job.locked_by = $2
    AND job.attempts = $3;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  RETURN QUERY SELECT true;
END;
$plan7a_operations_renew_job_claim$;--> statement-breakpoint

CREATE FUNCTION "public"."plan7a_operations_relinquish_job"(
  uuid,text,integer,integer,text,integer
)
RETURNS TABLE (applied boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $plan7a_operations_relinquish_job$
DECLARE
  job_row "public"."jobs"%ROWTYPE;
  claim_row "public"."operations_job_retry_claims"%ROWTYPE;
  command_row "public"."operations_job_retry_commands"%ROWTYPE;
  transition_now timestamptz;
  retry_at timestamptz;
BEGIN
  IF NOT (
    session_user = (
      SELECT pg_catalog.pg_get_userbyid(database_row.datdba)
      FROM pg_catalog.pg_database database_row
      WHERE database_row.datname = pg_catalog.current_database()
    ) OR pg_catalog.pg_has_role(
      session_user, 'pale_orbit_financial_worker', 'MEMBER'
    )
  ) OR pg_catalog.pg_has_role(
    session_user, 'pale_orbit_storage_cleanup', 'MEMBER'
  ) OR $1 IS NULL OR $2 IS NULL OR $2 !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' OR
    $3 IS NULL OR $4 IS NULL OR $5 IS NULL OR $6 IS NULL OR
    $3 NOT BETWEEN 1 AND 2147483647 OR $4 NOT BETWEEN 1 AND 2147483647 OR
    $5 NOT IN ('Transient job handler failure', 'Transient job completion failure') OR
    $6 NOT BETWEEN 1 AND 86400000 THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  SELECT * INTO job_row FROM "public"."jobs" job
  WHERE job.id = $1 FOR UPDATE;
  IF NOT FOUND OR job_row.status <> 'running' OR
    job_row.attempts >= job_row.max_attempts THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'pale-orbit:plan7a-operations-job-lease:' || $1::text, 0
  ));
  SELECT * INTO claim_row FROM "public"."operations_job_retry_claims" claim
  WHERE claim.job_id = $1 FOR UPDATE;
  IF NOT FOUND OR claim_row.lease_owner IS DISTINCT FROM $2 OR
    claim_row.attempt IS DISTINCT FROM $3 OR claim_row.generation IS DISTINCT FROM $4 THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  SELECT * INTO command_row
  FROM "public"."operations_job_retry_commands" command
  WHERE command.id = claim_row.command_id FOR UPDATE;
  IF NOT FOUND OR command_row.status <> 'pending' THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  PERFORM "public"."plan7a_operations_assert_job_capability"(
    $1, claim_row.command_id, $2, $3, $4
  );
  transition_now := pg_catalog.clock_timestamp();
  retry_at := transition_now + ($6::double precision * interval '1 millisecond');
  PERFORM pg_catalog.set_config(
    'pale_orbit.plan7a_operations_job_transition_id', $1::text, true
  );
  UPDATE "public"."jobs" job SET
    status = 'pending', run_at = retry_at, locked_at = NULL, locked_by = NULL,
    last_error = $5, rerun_requested_at = NULL, completed_at = NULL,
    updated_at = transition_now
  WHERE job.id = $1 AND job.status = 'running' AND job.locked_by = $2
    AND job.attempts = $3;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  UPDATE "public"."operations_job_retry_claims" claim SET
    state = 'invalidated', invalidated_at = transition_now
  WHERE claim.job_id = $1 AND claim.generation = $4 AND claim.state = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  RETURN QUERY SELECT true;
END;
$plan7a_operations_relinquish_job$;--> statement-breakpoint

CREATE FUNCTION "public"."plan7a_operations_complete_job"(
  uuid,text,integer,integer
)
RETURNS TABLE (applied boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $plan7a_operations_complete_job$
DECLARE
  job_row "public"."jobs"%ROWTYPE;
  claim_row "public"."operations_job_retry_claims"%ROWTYPE;
  command_row "public"."operations_job_retry_commands"%ROWTYPE;
  transition_now timestamptz;
BEGIN
  IF NOT (
    session_user = (
      SELECT pg_catalog.pg_get_userbyid(database_row.datdba)
      FROM pg_catalog.pg_database database_row
      WHERE database_row.datname = pg_catalog.current_database()
    ) OR pg_catalog.pg_has_role(
      session_user, 'pale_orbit_financial_worker', 'MEMBER'
    )
  ) OR pg_catalog.pg_has_role(
    session_user, 'pale_orbit_storage_cleanup', 'MEMBER'
  ) OR $1 IS NULL OR $2 IS NULL OR $2 !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' OR
    $3 IS NULL OR $4 IS NULL OR
    $3 NOT BETWEEN 1 AND 2147483647 OR $4 NOT BETWEEN 1 AND 2147483647 THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  SELECT * INTO job_row FROM "public"."jobs" job
  WHERE job.id = $1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'pale-orbit:plan7a-operations-job-lease:' || $1::text, 0
  ));
  SELECT * INTO claim_row FROM "public"."operations_job_retry_claims" claim
  WHERE claim.job_id = $1 FOR UPDATE;
  IF NOT FOUND OR claim_row.lease_owner IS DISTINCT FROM $2 OR
    claim_row.attempt IS DISTINCT FROM $3 OR claim_row.generation IS DISTINCT FROM $4 THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  SELECT * INTO command_row FROM "public"."operations_job_retry_commands" command
  WHERE command.id = claim_row.command_id FOR UPDATE;
  IF NOT FOUND OR command_row.status = 'pending' THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  PERFORM "public"."plan7a_operations_assert_job_capability"(
    $1, claim_row.command_id, $2, $3, $4
  );
  transition_now := pg_catalog.clock_timestamp();
  PERFORM pg_catalog.set_config(
    'pale_orbit.plan7a_operations_job_transition_id', $1::text, true
  );
  UPDATE "public"."jobs" job SET
    status = 'succeeded', locked_at = NULL, locked_by = NULL, last_error = NULL,
    rerun_requested_at = NULL, completed_at = transition_now, updated_at = transition_now
  WHERE job.id = $1 AND job.status = 'running' AND job.locked_by = $2
    AND job.attempts = $3;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  UPDATE "public"."operations_job_retry_claims" claim SET
    state = 'invalidated', invalidated_at = transition_now
  WHERE claim.job_id = $1 AND claim.generation = $4 AND claim.state = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  RETURN QUERY SELECT true;
END;
$plan7a_operations_complete_job$;--> statement-breakpoint

CREATE FUNCTION "public"."plan7a_operations_fail_job"(
  uuid,text,integer,integer,text
)
RETURNS TABLE (applied boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $plan7a_operations_fail_job$
DECLARE
  job_row "public"."jobs"%ROWTYPE;
  claim_row "public"."operations_job_retry_claims"%ROWTYPE;
  command_row "public"."operations_job_retry_commands"%ROWTYPE;
  transition_now timestamptz;
  result_code "public"."operations_job_retry_result_code";
  command_was_pending boolean;
BEGIN
  IF NOT (
    session_user = (
      SELECT pg_catalog.pg_get_userbyid(database_row.datdba)
      FROM pg_catalog.pg_database database_row
      WHERE database_row.datname = pg_catalog.current_database()
    ) OR pg_catalog.pg_has_role(
      session_user, 'pale_orbit_financial_worker', 'MEMBER'
    )
  ) OR pg_catalog.pg_has_role(
    session_user, 'pale_orbit_storage_cleanup', 'MEMBER'
  ) OR $1 IS NULL OR $2 IS NULL OR $2 !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' OR
    $3 IS NULL OR $4 IS NULL OR $5 IS NULL OR
    $3 NOT BETWEEN 1 AND 2147483647 OR $4 NOT BETWEEN 1 AND 2147483647 OR
    $5 NOT IN (
      'Invalid operations job retry command identity.',
      'Operations job retry command permanently failed.',
      'Permanent job handler failure'
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  SELECT * INTO job_row FROM "public"."jobs" job
  WHERE job.id = $1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'pale-orbit:plan7a-operations-job-lease:' || $1::text, 0
  ));
  SELECT * INTO claim_row FROM "public"."operations_job_retry_claims" claim
  WHERE claim.job_id = $1 FOR UPDATE;
  IF NOT FOUND OR claim_row.lease_owner IS DISTINCT FROM $2 OR
    claim_row.attempt IS DISTINCT FROM $3 OR claim_row.generation IS DISTINCT FROM $4 THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  SELECT * INTO command_row FROM "public"."operations_job_retry_commands" command
  WHERE command.id = claim_row.command_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  PERFORM "public"."plan7a_operations_assert_job_capability"(
    $1, claim_row.command_id, $2, $3, $4
  );
  transition_now := pg_catalog.clock_timestamp();
  command_was_pending := command_row.status = 'pending';
  IF command_was_pending THEN
    result_code := CASE WHEN $5 =
      'Invalid operations job retry command identity.'
    THEN 'retry_command_invalid'::"public"."operations_job_retry_result_code"
      ELSE 'unexpected_failure'::"public"."operations_job_retry_result_code" END;
    PERFORM pg_catalog.set_config(
      'pale_orbit.plan7a_operations_command_transition_id', command_row.id::text, true
    );
    UPDATE "public"."operations_job_retry_commands" command SET
      status = 'failed', safe_result_code = result_code,
      updated_at = transition_now, completed_at = transition_now
    WHERE command.id = command_row.id AND command.status = 'pending'
    RETURNING * INTO command_row;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'Plan 7A operations job authority is not current';
    END IF;
    INSERT INTO "public"."audit_events" (
      actor_type, actor_id, action, outcome, resource_type, resource_id,
      correlation_id, request_metadata, before, after
    ) VALUES (
      'user'::"public"."audit_actor_type", command_row.actor_user_id::text,
      'operations.job_retry.failed', 'failed'::"public"."audit_outcome",
      'operations_job_retry_command', command_row.id::text,
      command_row.correlation_id, NULL, NULL, pg_catalog.jsonb_build_object(
        'commandId', command_row.id, 'targetJobId', command_row.target_job_id,
        'registeredKind', command_row.target_job_kind,
        'reasonCode', command_row.reason_code,
        'resultCode', command_row.safe_result_code
      )
    );
  END IF;
  PERFORM pg_catalog.set_config(
    'pale_orbit.plan7a_operations_job_transition_id', $1::text, true
  );
  UPDATE "public"."jobs" job SET
    status = CASE WHEN command_was_pending THEN 'failed'::"public"."job_status"
      ELSE 'succeeded'::"public"."job_status" END,
    locked_at = NULL, locked_by = NULL,
    last_error = CASE WHEN command_was_pending THEN $5 ELSE NULL END,
    rerun_requested_at = NULL, completed_at = transition_now, updated_at = transition_now
  WHERE job.id = $1 AND job.status = 'running' AND job.locked_by = $2
    AND job.attempts = $3;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  UPDATE "public"."operations_job_retry_claims" claim SET
    state = 'invalidated', invalidated_at = transition_now
  WHERE claim.job_id = $1 AND claim.generation = $4 AND claim.state = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  RETURN QUERY SELECT true;
END;
$plan7a_operations_fail_job$;--> statement-breakpoint

CREATE FUNCTION "public"."plan7a_operations_exhaust_job"(
  uuid,text,integer,integer
)
RETURNS TABLE (applied boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $plan7a_operations_exhaust_job$
DECLARE
  job_row "public"."jobs"%ROWTYPE;
  claim_row "public"."operations_job_retry_claims"%ROWTYPE;
  command_row "public"."operations_job_retry_commands"%ROWTYPE;
  transition_now timestamptz;
  command_was_pending boolean;
BEGIN
  IF NOT (
    session_user = (
      SELECT pg_catalog.pg_get_userbyid(database_row.datdba)
      FROM pg_catalog.pg_database database_row
      WHERE database_row.datname = pg_catalog.current_database()
    ) OR pg_catalog.pg_has_role(
      session_user, 'pale_orbit_financial_worker', 'MEMBER'
    )
  ) OR pg_catalog.pg_has_role(
    session_user, 'pale_orbit_storage_cleanup', 'MEMBER'
  ) OR $1 IS NULL OR $2 IS NULL OR $2 !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' OR
    $3 IS NULL OR $4 IS NULL OR
    $3 NOT BETWEEN 1 AND 2147483647 OR $4 NOT BETWEEN 1 AND 2147483647 THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  SELECT * INTO job_row FROM "public"."jobs" job
  WHERE job.id = $1 FOR UPDATE;
  IF NOT FOUND OR job_row.attempts <> job_row.max_attempts THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'pale-orbit:plan7a-operations-job-lease:' || $1::text, 0
  ));
  SELECT * INTO claim_row FROM "public"."operations_job_retry_claims" claim
  WHERE claim.job_id = $1 FOR UPDATE;
  IF NOT FOUND OR claim_row.lease_owner IS DISTINCT FROM $2 OR
    claim_row.attempt IS DISTINCT FROM $3 OR claim_row.generation IS DISTINCT FROM $4 THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  SELECT * INTO command_row FROM "public"."operations_job_retry_commands" command
  WHERE command.id = claim_row.command_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  PERFORM "public"."plan7a_operations_assert_job_capability"(
    $1, claim_row.command_id, $2, $3, $4
  );
  transition_now := pg_catalog.clock_timestamp();
  command_was_pending := command_row.status = 'pending';
  IF command_was_pending THEN
    PERFORM pg_catalog.set_config(
      'pale_orbit.plan7a_operations_command_transition_id', command_row.id::text, true
    );
    UPDATE "public"."operations_job_retry_commands" command SET
      status = 'failed', safe_result_code = 'retry_command_exhausted',
      updated_at = transition_now, completed_at = transition_now
    WHERE command.id = command_row.id AND command.status = 'pending'
    RETURNING * INTO command_row;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'Plan 7A operations job authority is not current';
    END IF;
    INSERT INTO "public"."audit_events" (
      actor_type, actor_id, action, outcome, resource_type, resource_id,
      correlation_id, request_metadata, before, after
    ) VALUES (
      'user'::"public"."audit_actor_type", command_row.actor_user_id::text,
      'operations.job_retry.failed', 'failed'::"public"."audit_outcome",
      'operations_job_retry_command', command_row.id::text,
      command_row.correlation_id, NULL, NULL, pg_catalog.jsonb_build_object(
        'commandId', command_row.id, 'targetJobId', command_row.target_job_id,
        'registeredKind', command_row.target_job_kind,
        'reasonCode', command_row.reason_code,
        'resultCode', command_row.safe_result_code
      )
    );
  END IF;
  PERFORM pg_catalog.set_config(
    'pale_orbit.plan7a_operations_job_transition_id', $1::text, true
  );
  UPDATE "public"."jobs" job SET
    status = CASE WHEN command_was_pending THEN 'failed'::"public"."job_status"
      ELSE 'succeeded'::"public"."job_status" END,
    locked_at = NULL, locked_by = NULL,
    last_error = CASE WHEN command_was_pending
      THEN 'Operations job retry command exhausted.' ELSE NULL END,
    rerun_requested_at = NULL, completed_at = transition_now, updated_at = transition_now
  WHERE job.id = $1 AND job.status = 'running' AND job.locked_by = $2
    AND job.attempts = $3;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  UPDATE "public"."operations_job_retry_claims" claim SET
    state = 'invalidated', invalidated_at = transition_now
  WHERE claim.job_id = $1 AND claim.generation = $4 AND claim.state = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  RETURN QUERY SELECT true;
END;
$plan7a_operations_exhaust_job$;--> statement-breakpoint

CREATE FUNCTION "public"."plan7a_operations_lock_job_retry_command"(
  uuid,uuid,text,integer,integer
)
RETURNS TABLE (
  command_id uuid,
  command_status text,
  result_code text,
  actor_authorized boolean,
  actor_user_id uuid,
  target_job_id uuid,
  target_job_kind text,
  expected_status text,
  expected_attempts integer,
  expected_max_attempts integer,
  expected_updated_at text,
  reason_code text,
  correlation_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $plan7a_operations_lock_job_retry_command$
DECLARE
  command_row "public"."operations_job_retry_commands"%ROWTYPE;
BEGIN
  IF NOT (
    session_user = (
      SELECT pg_catalog.pg_get_userbyid(database_row.datdba)
      FROM pg_catalog.pg_database database_row
      WHERE database_row.datname = pg_catalog.current_database()
    ) OR pg_catalog.pg_has_role(
      session_user, 'pale_orbit_financial_worker', 'MEMBER'
    )
  ) OR pg_catalog.pg_has_role(
    session_user, 'pale_orbit_storage_cleanup', 'MEMBER'
  ) OR $1 IS NULL OR $2 IS NULL OR $3 IS NULL OR
    $3 !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' OR
    $4 IS NULL OR $5 IS NULL OR
    $4 NOT BETWEEN 1 AND 2147483647 OR $5 NOT BETWEEN 1 AND 2147483647 THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('pale-orbit:user-roles:admin')
  );
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(
    'pale-orbit:plan7a-operations-job-lease:' || $1::text, 0
  ));
  PERFORM "public"."plan7a_operations_assert_job_capability"(
    $1, $2, $3, $4, $5
  );
  SELECT * INTO command_row
  FROM "public"."operations_job_retry_commands" command
  WHERE command.id = $2
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  RETURN QUERY SELECT command_row.id, command_row.status::text,
    command_row.safe_result_code::text,
    EXISTS (
      SELECT 1 FROM "public"."user_roles" role_row
      WHERE role_row.user_id = command_row.actor_user_id AND role_row.role = 'admin'
    ), command_row.actor_user_id, command_row.target_job_id,
    command_row.target_job_kind::text, command_row.expected_status::text,
    command_row.expected_attempts, command_row.expected_max_attempts,
    pg_catalog.to_char(pg_catalog.timezone('UTC', command_row.expected_updated_at),
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    command_row.reason_code::text, command_row.correlation_id::text;
END;
$plan7a_operations_lock_job_retry_command$;--> statement-breakpoint

CREATE FUNCTION "public"."plan7a_operations_transition_job_retry_command"(
  uuid,uuid,text,integer,integer,operations_job_retry_result_code
)
RETURNS TABLE (
  command_id uuid,
  command_status text,
  result_code text,
  completed_at text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $plan7a_operations_transition_job_retry_command$
DECLARE
  command_row "public"."operations_job_retry_commands"%ROWTYPE;
  transition_status "public"."operations_job_retry_command_status";
  transition_now timestamptz;
  allowed_outcome boolean;
  actor_is_authorized boolean;
BEGIN
  IF NOT (
    session_user = (
      SELECT pg_catalog.pg_get_userbyid(database_row.datdba)
      FROM pg_catalog.pg_database database_row
      WHERE database_row.datname = pg_catalog.current_database()
    ) OR pg_catalog.pg_has_role(
      session_user, 'pale_orbit_financial_worker', 'MEMBER'
    )
  ) OR pg_catalog.pg_has_role(
    session_user, 'pale_orbit_storage_cleanup', 'MEMBER'
  ) OR $1 IS NULL OR $2 IS NULL OR $3 IS NULL OR
    $3 !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$' OR
    $4 IS NULL OR $5 IS NULL OR
    $4 NOT BETWEEN 1 AND 2147483647 OR $5 NOT BETWEEN 1 AND 2147483647 OR
    $6 IS NULL OR
    $6 IN ('retry_command_invalid', 'retry_command_exhausted', 'unexpected_failure') THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('pale-orbit:user-roles:admin')
  );
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(
    'pale-orbit:plan7a-operations-job-lease:' || $1::text, 0
  ));
  PERFORM "public"."plan7a_operations_assert_job_capability"(
    $1, $2, $3, $4, $5
  );
  SELECT * INTO command_row
  FROM "public"."operations_job_retry_commands" command
  WHERE command.id = $2
  FOR UPDATE;
  IF NOT FOUND OR command_row.status <> 'pending' THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM "public"."user_roles" role_row
    WHERE role_row.user_id = command_row.actor_user_id AND role_row.role = 'admin'
  ) INTO actor_is_authorized;
  IF ($6 = 'actor_not_authorized') IS DISTINCT FROM (NOT actor_is_authorized) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  IF NOT actor_is_authorized THEN
    transition_status := 'denied';
    allowed_outcome := true;
  ELSE
    SELECT token.parts[1]::"public"."operations_job_retry_command_status", true
    INTO transition_status, allowed_outcome
    FROM "public"."plan7a_operations_job_catalog"() catalog
    CROSS JOIN LATERAL pg_catalog.unnest(
      catalog.allowed_policy_outcomes
    ) allowed(outcome_token)
    CROSS JOIN LATERAL pg_catalog.regexp_split_to_array(
      allowed.outcome_token, '/'
    ) token(parts)
    WHERE catalog.kind = command_row.target_job_kind AND token.parts[2] = $6::text;
  END IF;
  IF allowed_outcome IS DISTINCT FROM true OR transition_status IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  transition_now := pg_catalog.clock_timestamp();
  PERFORM pg_catalog.set_config(
    'pale_orbit.plan7a_operations_command_transition_id', command_row.id::text, true
  );
  UPDATE "public"."operations_job_retry_commands" command SET
    status = transition_status, safe_result_code = $6,
    updated_at = transition_now, completed_at = transition_now
  WHERE command.id = command_row.id AND command.status = 'pending'
  RETURNING * INTO command_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'Plan 7A operations job authority is not current';
  END IF;
  INSERT INTO "public"."audit_events" (
    actor_type, actor_id, action, outcome, resource_type, resource_id,
    correlation_id, request_metadata, before, after
  ) VALUES (
    'user'::"public"."audit_actor_type", command_row.actor_user_id::text,
    CASE transition_status
      WHEN 'succeeded' THEN 'operations.job_retry.succeeded'
      WHEN 'denied' THEN 'operations.job_retry.denied'
      ELSE 'operations.job_retry.failed'
    END,
    CASE transition_status
      WHEN 'succeeded' THEN 'succeeded'::"public"."audit_outcome"
      WHEN 'denied' THEN 'denied'::"public"."audit_outcome"
      ELSE 'failed'::"public"."audit_outcome"
    END,
    'operations_job_retry_command', command_row.id::text,
    command_row.correlation_id, NULL, NULL, pg_catalog.jsonb_build_object(
      'commandId', command_row.id, 'targetJobId', command_row.target_job_id,
      'registeredKind', command_row.target_job_kind,
      'reasonCode', command_row.reason_code,
      'resultCode', command_row.safe_result_code
    )
  );
  RETURN QUERY SELECT command_row.id, command_row.status::text,
    command_row.safe_result_code::text,
    pg_catalog.to_char(pg_catalog.timezone('UTC', command_row.completed_at),
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
END;
$plan7a_operations_transition_job_retry_command$;--> statement-breakpoint

REVOKE ALL ON TABLE "public"."operations_job_retry_commands", "public"."operations_job_retry_claims" FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
REVOKE ALL ON TYPE
  "public"."operations_job_retry_command_status",
  "public"."operations_job_retry_result_code",
  "public"."operations_job_retry_reason_code",
  "public"."operations_job_retry_claim_state"
FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
GRANT USAGE ON TYPE "public"."operations_job_retry_result_code"
TO "pale_orbit_financial_worker";--> statement-breakpoint

REVOKE ALL ON FUNCTION "public"."plan7a_operations_job_catalog"() FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."plan7a_operations_safe_failure_code"(text,text) FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."plan7a_operations_assert_job_capability"(uuid,uuid,text,integer,integer) FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."plan7a_operations_guard_command_update"() FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."plan7a_operations_guard_command_delete"() FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."plan7a_operations_guard_job_transition"() FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint

REVOKE ALL ON FUNCTION "public"."list_operational_jobs"(uuid,text,text,timestamp with time zone,uuid,integer) FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."submit_job_retry_command"(uuid,uuid,text,integer,integer,timestamp with time zone,text,text,text,text) FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."get_owned_job_retry_command"(uuid,uuid) FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."list_operational_jobs"(uuid,text,text,timestamp with time zone,uuid,integer) TO "pale_orbit_runtime";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."submit_job_retry_command"(uuid,uuid,text,integer,integer,timestamp with time zone,text,text,text,text) TO "pale_orbit_runtime";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."get_owned_job_retry_command"(uuid,uuid) TO "pale_orbit_runtime";--> statement-breakpoint

REVOKE ALL ON FUNCTION "public"."plan7a_operations_claim_job"(uuid,text,integer) FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."plan7a_operations_renew_job_claim"(uuid,text,integer,integer) FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."plan7a_operations_relinquish_job"(uuid,text,integer,integer,text,integer) FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."plan7a_operations_complete_job"(uuid,text,integer,integer) FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."plan7a_operations_fail_job"(uuid,text,integer,integer,text) FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."plan7a_operations_exhaust_job"(uuid,text,integer,integer) FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."plan7a_operations_lock_job_retry_command"(uuid,uuid,text,integer,integer) FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."plan7a_operations_transition_job_retry_command"(uuid,uuid,text,integer,integer,operations_job_retry_result_code) FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."plan7a_operations_claim_job"(uuid,text,integer) TO "pale_orbit_financial_worker";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."plan7a_operations_renew_job_claim"(uuid,text,integer,integer) TO "pale_orbit_financial_worker";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."plan7a_operations_relinquish_job"(uuid,text,integer,integer,text,integer) TO "pale_orbit_financial_worker";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."plan7a_operations_complete_job"(uuid,text,integer,integer) TO "pale_orbit_financial_worker";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."plan7a_operations_fail_job"(uuid,text,integer,integer,text) TO "pale_orbit_financial_worker";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."plan7a_operations_exhaust_job"(uuid,text,integer,integer) TO "pale_orbit_financial_worker";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."plan7a_operations_lock_job_retry_command"(uuid,uuid,text,integer,integer) TO "pale_orbit_financial_worker";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."plan7a_operations_transition_job_retry_command"(uuid,uuid,text,integer,integer,operations_job_retry_result_code) TO "pale_orbit_financial_worker";

DO $plan7a_operations_authority_postflight$
DECLARE
  database_oid oid;
  database_owner oid;
  database_owner_name name;
  expected_web_login text;
  expected_worker_login text;
  expected_storage_cleanup_login text;
  descriptor_count integer;
  actual_predecessor_acl_sha256 text;
  actual_predecessor_storage_sha256 text;
BEGIN
  SELECT database_row.oid, database_row.datdba,
    pg_catalog.pg_get_userbyid(database_row.datdba)
  INTO database_oid, database_owner, database_owner_name
  FROM pg_catalog.pg_database database_row
  WHERE database_row.datname = pg_catalog.current_database();
  IF database_owner IS NULL OR current_user IS DISTINCT FROM database_owner_name OR
    pg_catalog.current_setting('session_replication_role') IS DISTINCT FROM 'origin' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 7A operations authority postflight failed';
  END IF;

  IF pg_catalog.current_schema() IS DISTINCT FROM 'public' OR
    pg_catalog.current_schemas(false) IS DISTINCT FROM ARRAY['public']::name[] THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 7A operations authority search path is not canonical';
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
      MESSAGE = 'Plan 7A operations authority login identity is not canonical';
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
      MESSAGE = 'Plan 7A operations authority role membership is not canonical';
  END IF;

  IF EXISTS (
    WITH protected_principal(role_oid) AS (
      SELECT role_row.oid
      FROM pg_catalog.pg_roles role_row
      WHERE role_row.rolname IN (
        'pale_orbit_runtime', 'pale_orbit_financial_worker',
        'pale_orbit_storage_cleanup', expected_web_login,
        expected_worker_login, expected_storage_cleanup_login
      )
    ), unsafe_session_replication_default AS (
      SELECT 1
      FROM pg_catalog.pg_db_role_setting setting_row
      CROSS JOIN LATERAL pg_catalog.unnest(setting_row.setconfig) configured_setting(value)
      WHERE setting_row.setrole IN (0::oid, database_owner) AND
        setting_row.setdatabase IN (0::oid, database_oid) AND
        pg_catalog.split_part(configured_setting.value, '=', 1) =
          'session_replication_role' AND
        pg_catalog.split_part(configured_setting.value, '=', 2) IS DISTINCT FROM 'origin'
    ), unsafe_operations_setting_default AS (
      SELECT 1
      FROM pg_catalog.pg_db_role_setting setting_row
      CROSS JOIN LATERAL pg_catalog.unnest(setting_row.setconfig) configured_setting(value)
      WHERE (setting_row.setrole = 0 OR setting_row.setrole = database_owner OR
          setting_row.setrole IN (SELECT role_oid FROM protected_principal)) AND
        pg_catalog.split_part(configured_setting.value, '=', 1) = ANY(ARRAY[
          'pale_orbit.plan7a_operations_command_insert_id',
          'pale_orbit.plan7a_operations_command_transition_id',
          'pale_orbit.plan7a_operations_job_transition_id',
          'pale_orbit.plan7a_operations_job_capability'
        ]::text[])
    ), unsafe_parameter_acl AS (
      SELECT 1
      FROM pg_catalog.pg_parameter_acl parameter_acl
      CROSS JOIN LATERAL pg_catalog.aclexplode(parameter_acl.paracl) privilege
      WHERE privilege.grantee = 0 OR privilege.grantee IN (
        SELECT role_oid FROM protected_principal
      )
    ), actual_default_acl_identity(role_oid, namespace_oid, object_type) AS (
      SELECT default_acl.defaclrole, default_acl.defaclnamespace,
        default_acl.defaclobjtype
      FROM pg_catalog.pg_default_acl default_acl
    ), expected_default_acl_identity(role_oid, namespace_oid, object_type) AS (
      VALUES
        (database_owner, 0::oid, 'f'::"char"),
        (database_owner, 'public'::pg_catalog.regnamespace::oid, 'S'::"char"),
        (database_owner, 'public'::pg_catalog.regnamespace::oid, 'r'::"char")
    ), default_acl_identity_delta AS (
      (SELECT * FROM actual_default_acl_identity
       EXCEPT ALL SELECT * FROM expected_default_acl_identity)
      UNION ALL
      (SELECT * FROM expected_default_acl_identity
       EXCEPT ALL SELECT * FROM actual_default_acl_identity)
    ), actual_default_acl_privilege(
      role_oid, namespace_oid, object_type, grantee, grantor,
      privilege_type, is_grantable
    ) AS (
      SELECT default_acl.defaclrole, default_acl.defaclnamespace,
        default_acl.defaclobjtype, privilege.grantee, privilege.grantor,
        privilege.privilege_type::text, privilege.is_grantable
      FROM pg_catalog.pg_default_acl default_acl
      CROSS JOIN LATERAL pg_catalog.aclexplode(default_acl.defaclacl) privilege
    ), expected_default_acl_privilege(
      role_oid, namespace_oid, object_type, grantee, grantor,
      privilege_type, is_grantable
    ) AS (
      VALUES
        (database_owner, 0::oid, 'f'::"char", database_owner, database_owner,
          'EXECUTE'::text, false),
        (database_owner, 'public'::pg_catalog.regnamespace::oid, 'S'::"char",
          'pale_orbit_runtime'::pg_catalog.regrole::oid, database_owner,
          'SELECT'::text, false),
        (database_owner, 'public'::pg_catalog.regnamespace::oid, 'S'::"char",
          'pale_orbit_runtime'::pg_catalog.regrole::oid, database_owner,
          'UPDATE'::text, false),
        (database_owner, 'public'::pg_catalog.regnamespace::oid, 'S'::"char",
          'pale_orbit_runtime'::pg_catalog.regrole::oid, database_owner,
          'USAGE'::text, false),
        (database_owner, 'public'::pg_catalog.regnamespace::oid, 'r'::"char",
          'pale_orbit_runtime'::pg_catalog.regrole::oid, database_owner,
          'SELECT'::text, false)
    ), default_acl_privilege_delta AS (
      (SELECT * FROM actual_default_acl_privilege
       EXCEPT ALL SELECT * FROM expected_default_acl_privilege)
      UNION ALL
      (SELECT * FROM expected_default_acl_privilege
       EXCEPT ALL SELECT * FROM actual_default_acl_privilege)
    )
    SELECT 1 FROM unsafe_session_replication_default
    UNION ALL SELECT 1 FROM unsafe_operations_setting_default
    UNION ALL SELECT 1 FROM unsafe_parameter_acl
    UNION ALL SELECT 1 FROM default_acl_identity_delta
    UNION ALL SELECT 1 FROM default_acl_privilege_delta
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 7A operations authority settings are not canonical';
  END IF;

  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.string_agg(acl_descriptor.descriptor, E'\n'
      ORDER BY acl_descriptor.descriptor), 'UTF8'
  )), 'hex') INTO actual_predecessor_acl_sha256
  FROM (
    SELECT 'database:' || privilege.privilege_type || ':' ||
      CASE privilege.grantee WHEN 0 THEN '<public>'
        WHEN database_owner THEN '<owner>'
        ELSE pg_catalog.pg_get_userbyid(privilege.grantee) END || ':' ||
      CASE privilege.grantor WHEN database_owner THEN '<owner>'
        ELSE pg_catalog.pg_get_userbyid(privilege.grantor) END || ':' ||
      privilege.is_grantable::text AS descriptor
    FROM pg_catalog.pg_database database_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
      database_row.datacl, pg_catalog.acldefault('d', database_row.datdba)
    )) privilege
    WHERE database_row.datname = pg_catalog.current_database()
    UNION ALL
    SELECT 'schema:public:' || privilege.privilege_type || ':' ||
      CASE privilege.grantee WHEN 0 THEN '<public>'
        WHEN database_owner THEN '<owner>'
        ELSE pg_catalog.pg_get_userbyid(privilege.grantee) END || ':' ||
      CASE privilege.grantor WHEN database_owner THEN '<owner>'
        ELSE pg_catalog.pg_get_userbyid(privilege.grantor) END || ':' ||
      privilege.is_grantable::text
    FROM pg_catalog.pg_namespace namespace_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
      namespace_row.nspacl, pg_catalog.acldefault('n', namespace_row.nspowner)
    )) privilege
    WHERE namespace_row.nspname = 'public'
    UNION ALL
    SELECT 'relation:' || relation_row.relkind::text || ':' || relation_row.relname ||
      ':' || privilege.privilege_type || ':' ||
      CASE privilege.grantee WHEN 0 THEN '<public>'
        WHEN database_owner THEN '<owner>'
        ELSE pg_catalog.pg_get_userbyid(privilege.grantee) END || ':' ||
      CASE privilege.grantor WHEN database_owner THEN '<owner>'
        ELSE pg_catalog.pg_get_userbyid(privilege.grantor) END || ':' ||
      privilege.is_grantable::text
    FROM pg_catalog.pg_class relation_row
    JOIN pg_catalog.pg_namespace namespace_row
      ON namespace_row.oid = relation_row.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
      relation_row.relacl, pg_catalog.acldefault(
        (CASE WHEN relation_row.relkind = 'S' THEN 'S' ELSE 'r' END)::"char",
        relation_row.relowner
      )
    )) privilege
    WHERE namespace_row.nspname = 'public'
      AND relation_row.relkind IN ('r','p','v','m','S','f')
      AND relation_row.relname NOT IN (
        'operations_job_retry_commands', 'operations_job_retry_claims'
      )
    UNION ALL
    SELECT 'column:' || relation_row.relname || ':' || attribute_row.attname || ':' ||
      privilege.privilege_type || ':' ||
      CASE privilege.grantee WHEN 0 THEN '<public>'
        WHEN database_owner THEN '<owner>'
        ELSE pg_catalog.pg_get_userbyid(privilege.grantee) END || ':' ||
      CASE privilege.grantor WHEN database_owner THEN '<owner>'
        ELSE pg_catalog.pg_get_userbyid(privilege.grantor) END || ':' ||
      privilege.is_grantable::text
    FROM pg_catalog.pg_attribute attribute_row
    JOIN pg_catalog.pg_class relation_row ON relation_row.oid = attribute_row.attrelid
    JOIN pg_catalog.pg_namespace namespace_row
      ON namespace_row.oid = relation_row.relnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute_row.attacl) privilege
    WHERE namespace_row.nspname = 'public'
      AND relation_row.relname NOT IN (
        'operations_job_retry_commands', 'operations_job_retry_claims'
      ) AND attribute_row.attnum > 0 AND NOT attribute_row.attisdropped
      AND attribute_row.attacl IS NOT NULL
    UNION ALL
    SELECT 'type:' || type_row.typname || ':' || privilege.privilege_type || ':' ||
      CASE privilege.grantee WHEN 0 THEN '<public>'
        WHEN database_owner THEN '<owner>'
        ELSE pg_catalog.pg_get_userbyid(privilege.grantee) END || ':' ||
      CASE privilege.grantor WHEN database_owner THEN '<owner>'
        ELSE pg_catalog.pg_get_userbyid(privilege.grantor) END || ':' ||
      privilege.is_grantable::text
    FROM pg_catalog.pg_type type_row
    JOIN pg_catalog.pg_namespace namespace_row
      ON namespace_row.oid = type_row.typnamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
      type_row.typacl, pg_catalog.acldefault('T', type_row.typowner)
    )) privilege
    WHERE namespace_row.nspname = 'public' AND type_row.typtype IN ('d','e')
      AND type_row.typname NOT LIKE 'operations_job_retry_%'
    UNION ALL
    SELECT 'routine:' || routine.proname || '(' ||
      pg_catalog.pg_get_function_identity_arguments(routine.oid) || '):' ||
      privilege.privilege_type || ':' ||
      CASE privilege.grantee WHEN 0 THEN '<public>'
        WHEN database_owner THEN '<owner>'
        ELSE pg_catalog.pg_get_userbyid(privilege.grantee) END || ':' ||
      CASE privilege.grantor WHEN database_owner THEN '<owner>'
        ELSE pg_catalog.pg_get_userbyid(privilege.grantor) END || ':' ||
      privilege.is_grantable::text
    FROM pg_catalog.pg_proc routine
    JOIN pg_catalog.pg_namespace namespace_row
      ON namespace_row.oid = routine.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
      routine.proacl, pg_catalog.acldefault('f', routine.proowner)
    )) privilege
    WHERE namespace_row.nspname = 'public' AND routine.proname NOT IN (
      'plan7a_operations_job_catalog', 'plan7a_operations_safe_failure_code',
      'plan7a_operations_assert_job_capability',
      'plan7a_operations_guard_command_update',
      'plan7a_operations_guard_command_delete',
      'plan7a_operations_guard_job_transition', 'list_operational_jobs',
      'submit_job_retry_command', 'get_owned_job_retry_command',
      'plan7a_operations_claim_job', 'plan7a_operations_renew_job_claim',
      'plan7a_operations_relinquish_job', 'plan7a_operations_complete_job',
      'plan7a_operations_fail_job', 'plan7a_operations_exhaust_job',
      'plan7a_operations_lock_job_retry_command',
      'plan7a_operations_transition_job_retry_command'
    )
  ) acl_descriptor;

  IF actual_predecessor_acl_sha256 IS DISTINCT FROM
    '9d22545961747a6434b6eee47093c6c82c512483a6e36a5a49af0c0f41684e7a' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 7A predecessor ACL inventory is not canonical';
  END IF;

  SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.string_agg(storage_descriptor.descriptor, E'\n'
      ORDER BY storage_descriptor.descriptor), 'UTF8'
  )), 'hex') INTO actual_predecessor_storage_sha256
  FROM (
    SELECT 'relation:' || relation_row.relname || ':' ||
      relation_row.relkind::text || ':' || relation_row.relpersistence::text || ':' ||
      CASE relation_row.relowner WHEN database_owner THEN '<owner>'
        ELSE pg_catalog.pg_get_userbyid(relation_row.relowner) END || ':' ||
      relation_row.relrowsecurity::text || ':' || relation_row.relforcerowsecurity::text ||
      ':' || relation_row.relreplident::text || ':' || relation_row.relispartition::text ||
      ':' || relation_row.relhasrules::text || ':' || relation_row.relhastriggers::text ||
      ':' || relation_row.relchecks::text AS descriptor
    FROM pg_catalog.pg_class relation_row
    JOIN pg_catalog.pg_namespace namespace_row
      ON namespace_row.oid = relation_row.relnamespace
    WHERE namespace_row.nspname = 'public'
      AND relation_row.relname IN ('jobs', 'audit_events')
    UNION ALL
    SELECT 'column:' || relation_row.relname || ':' || attribute_row.attnum::text || ':' ||
      attribute_row.attname || ':' || type_namespace.nspname || '.' || type_row.typname ||
      ':' || pg_catalog.format_type(attribute_row.atttypid, attribute_row.atttypmod) ||
      ':' || attribute_row.attnotnull::text || ':' || attribute_row.attidentity::text ||
      ':' || attribute_row.attgenerated::text || ':' || coalesce(
        collation_namespace.nspname || '.' || collation_row.collname, ''
      ) || ':' || coalesce(
        pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid), ''
      )
    FROM pg_catalog.pg_attribute attribute_row
    JOIN pg_catalog.pg_class relation_row ON relation_row.oid = attribute_row.attrelid
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
    JOIN pg_catalog.pg_type type_row ON type_row.oid = attribute_row.atttypid
    JOIN pg_catalog.pg_namespace type_namespace ON type_namespace.oid = type_row.typnamespace
    LEFT JOIN pg_catalog.pg_attrdef default_row
      ON default_row.adrelid = attribute_row.attrelid
     AND default_row.adnum = attribute_row.attnum
    LEFT JOIN pg_catalog.pg_collation collation_row
      ON collation_row.oid = attribute_row.attcollation
    LEFT JOIN pg_catalog.pg_namespace collation_namespace
      ON collation_namespace.oid = collation_row.collnamespace
    WHERE namespace_row.nspname = 'public'
      AND relation_row.relname IN ('jobs', 'audit_events')
      AND attribute_row.attnum > 0 AND NOT attribute_row.attisdropped
    UNION ALL
    SELECT 'constraint:' || relation_row.relname || ':' || constraint_row.conname || ':' ||
      constraint_row.contype::text || ':' || constraint_row.convalidated::text || ':' ||
      constraint_row.condeferrable::text || ':' || constraint_row.condeferred::text || ':' ||
      constraint_row.connoinherit::text || ':' ||
      pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
    FROM pg_catalog.pg_constraint constraint_row
    JOIN pg_catalog.pg_class relation_row ON relation_row.oid = constraint_row.conrelid
    JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
    WHERE namespace_row.nspname = 'public'
      AND relation_row.relname IN ('jobs', 'audit_events')
    UNION ALL
    SELECT 'index:' || table_relation.relname || ':' || index_namespace.nspname || '.' ||
      index_relation.relname || ':' ||
      CASE index_relation.relowner WHEN database_owner THEN '<owner>'
        ELSE pg_catalog.pg_get_userbyid(index_relation.relowner) END || ':' ||
      index_row.indisunique::text || ':' || index_row.indisprimary::text || ':' ||
      index_row.indisexclusion::text || ':' || index_row.indimmediate::text || ':' ||
      index_row.indisclustered::text || ':' || index_row.indisvalid::text || ':' ||
      index_row.indisready::text || ':' || index_row.indislive::text || ':' ||
      index_row.indisreplident::text || ':' ||
      pg_catalog.pg_get_indexdef(index_relation.oid)
    FROM pg_catalog.pg_index index_row
    JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_row.indexrelid
    JOIN pg_catalog.pg_namespace index_namespace
      ON index_namespace.oid = index_relation.relnamespace
    JOIN pg_catalog.pg_class table_relation ON table_relation.oid = index_row.indrelid
    JOIN pg_catalog.pg_namespace table_namespace
      ON table_namespace.oid = table_relation.relnamespace
    WHERE table_namespace.nspname = 'public'
      AND table_relation.relname IN ('jobs', 'audit_events')
  ) storage_descriptor;

  IF actual_predecessor_storage_sha256 IS DISTINCT FROM
    '5dfb4b04a8259b1f11cbe91aacb668c62993fd1e32e319c9f8287f78b60e43c8' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 7A predecessor storage inventory is not canonical';
  END IF;

  IF EXISTS (
    WITH expected_routine(
      routine_name, signature, result_shape, security_definer, volatility,
      definition_sha256
    ) AS (
      VALUES
        ('get_owned_job_retry_command'::text,
          'public.get_owned_job_retry_command(uuid,uuid)'::text,
          'TABLE(command_id uuid, kind text, target_job_id uuid, target_kind text, reason_code text, correlation_id text, status text, result_code text, created_at text, updated_at text, completed_at text)'::text,
          true, 'v'::"char",
          '022292c2665a28aea7d0780994983898678e1df3c26386be5c7979fb8b941785'::text),
        ('list_operational_jobs',
          'public.list_operational_jobs(uuid,text,text,timestamp with time zone,uuid,integer)',
          'TABLE(job_id uuid, kind text, label text, status text, attempts integer, max_attempts integer, run_at text, completed_at text, created_at text, updated_at text, retry_disposition text, policy_availability text, safe_failure_code text)',
          true, 'v'::"char", '84290e11fcdb1cda15644938914d601f0bc62d54ad5372d3fbf448ef0e99af85'),
        ('plan7a_operations_assert_job_capability',
          'public.plan7a_operations_assert_job_capability(uuid,uuid,text,integer,integer)',
          'void', true, 'v'::"char", '25e29a8b14f53b95dde03d064301c22e6b652db7276fa4a25e74aba74311975d'),
        ('plan7a_operations_claim_job',
          'public.plan7a_operations_claim_job(uuid,text,integer)',
          'TABLE(job_id uuid, job_kind text, payload jsonb, deduplication_key text, attempt integer, max_attempts integer, lease_owner text, lease_generation integer)',
          true, 'v'::"char", '29d094836b4ebf934a1e2c307706839f4a8d96c8e3b05551a7624e021f807885'),
        ('plan7a_operations_complete_job',
          'public.plan7a_operations_complete_job(uuid,text,integer,integer)',
          'TABLE(applied boolean)', true, 'v'::"char", '97637d143fe11330d1780d552b966eb6474257e40043b5b463699ef6b39b6f0b'),
        ('plan7a_operations_exhaust_job',
          'public.plan7a_operations_exhaust_job(uuid,text,integer,integer)',
          'TABLE(applied boolean)', true, 'v'::"char", '38aa875da3b0c67d44394e7c8b7781b57707d117b8f1aaddb03e3a25bb0371bf'),
        ('plan7a_operations_fail_job',
          'public.plan7a_operations_fail_job(uuid,text,integer,integer,text)',
          'TABLE(applied boolean)', true, 'v'::"char", 'ec94c84bb0f560cfce890fc940daa9741b1fe2f87f1cbc17d0d3c667fc8d8138'),
        ('plan7a_operations_guard_command_delete',
          'public.plan7a_operations_guard_command_delete()', 'trigger', false, 'v'::"char",
          '51c644c3f62cba64bfc4b46f09cac247336edd86e4335c0b8289437fa5b97754'),
        ('plan7a_operations_guard_command_update',
          'public.plan7a_operations_guard_command_update()', 'trigger', false, 'v'::"char",
          '750cdbb29e154c9f2fbcd9f7fa56be76d792bb5f7e7b04486be5463f2b16e126'),
        ('plan7a_operations_guard_job_transition',
          'public.plan7a_operations_guard_job_transition()', 'trigger', false, 'v'::"char",
          '1d398a6ae0a87c59c9f4ad797ca0311b3be258dda847ad361893808680c5815b'),
        ('plan7a_operations_job_catalog', 'public.plan7a_operations_job_catalog()',
          'TABLE(kind text, label text, max_attempts integer, automatic_retry_owner text, retry_disposition text, policy_adapter text, policy_availability text, provider_verification_required boolean, provider_calls_in_plan7a boolean, administrator_retry_excluded boolean, safe_statuses text[], diagnostic_generation text, allowed_policy_outcomes text[])',
          true, 's'::"char", '3c032448b9e0194e3c3537708987abb475ae7ee2f94272f96e7985406ade1eab'),
        ('plan7a_operations_lock_job_retry_command',
          'public.plan7a_operations_lock_job_retry_command(uuid,uuid,text,integer,integer)',
          'TABLE(command_id uuid, command_status text, result_code text, actor_authorized boolean, actor_user_id uuid, target_job_id uuid, target_job_kind text, expected_status text, expected_attempts integer, expected_max_attempts integer, expected_updated_at text, reason_code text, correlation_id text)',
          true, 'v'::"char", 'a46713251ed99b9fcfa03b027dfe001e35ffcaa272cc29e13b74efa25aa298da'),
        ('plan7a_operations_relinquish_job',
          'public.plan7a_operations_relinquish_job(uuid,text,integer,integer,text,integer)',
          'TABLE(applied boolean)', true, 'v'::"char", '0ecedb56d53d9cdf03be6990b4f446e94058d9b82e778fd5d98ff1264d8379d8'),
        ('plan7a_operations_renew_job_claim',
          'public.plan7a_operations_renew_job_claim(uuid,text,integer,integer)',
          'TABLE(applied boolean)', true, 'v'::"char", '245f7b532dbef149f8ec1c9067242bc6740fab4e39575fdb2a1e34279a78672b'),
        ('plan7a_operations_safe_failure_code',
          'public.plan7a_operations_safe_failure_code(text,text)', 'text', true, 's'::"char",
          '534cc1821fd53eca619c90e4a49dd028fc93bf8aa32ffea502a33dc23712a1f5'),
        ('plan7a_operations_transition_job_retry_command',
          'public.plan7a_operations_transition_job_retry_command(uuid,uuid,text,integer,integer,operations_job_retry_result_code)',
          'TABLE(command_id uuid, command_status text, result_code text, completed_at text)',
          true, 'v'::"char", 'b7f6f0930645619d0f05b6f0087882850adca32e4e6beec496a80f70cb13732b'),
        ('submit_job_retry_command',
          'public.submit_job_retry_command(uuid,uuid,text,integer,integer,timestamp with time zone,text,text,text,text)',
          'TABLE(command_id uuid, kind text, target_job_id uuid, target_kind text, reason_code text, correlation_id text, status text, result_code text, created_at text, updated_at text, completed_at text)',
          true, 'v'::"char", '335d43be99e046133c2da4b2f204ef2806849a117cffdf13ee9ab31a9b4efe3d')
    ), actual_routine AS (
      SELECT routine.proname::text AS routine_name, routine.oid, routine.prosecdef,
        routine.provolatile, routine.proowner, routine.proconfig,
        routine.proparallel, routine.proleakproof, routine.prokind,
        routine.proisstrict, language_row.lanname,
        pg_catalog.pg_get_function_result(routine.oid) AS result_shape,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
          pg_catalog.replace(pg_catalog.replace(
            pg_catalog.pg_get_functiondef(routine.oid), E'\r\n', E'\n'
          ), E'\r', E'\n'), 'UTF8'
        )), 'hex') definition_sha256
      FROM pg_catalog.pg_proc routine
      JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = routine.pronamespace
      JOIN pg_catalog.pg_language language_row ON language_row.oid = routine.prolang
      WHERE namespace_row.nspname = 'public' AND routine.proname IN (
        SELECT expected.routine_name FROM expected_routine expected
      )
    ), invalid_routine AS (
      SELECT expected.routine_name
      FROM expected_routine expected
      LEFT JOIN actual_routine actual USING (routine_name)
      GROUP BY expected.routine_name, expected.security_definer, expected.volatility,
        expected.signature, expected.result_shape, expected.definition_sha256,
        actual.oid, actual.result_shape,
        actual.prosecdef, actual.provolatile, actual.proowner, actual.proconfig,
        actual.proparallel, actual.proleakproof, actual.prokind, actual.proisstrict,
        actual.lanname, actual.definition_sha256
      HAVING pg_catalog.count(actual.routine_name) <> 1 OR
        actual.oid IS DISTINCT FROM pg_catalog.to_regprocedure(expected.signature)::oid OR
        actual.result_shape IS DISTINCT FROM expected.result_shape OR
        actual.prosecdef IS DISTINCT FROM expected.security_definer OR
        actual.provolatile IS DISTINCT FROM expected.volatility OR
        actual.proowner IS DISTINCT FROM database_owner OR
        actual.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[] OR
        actual.proparallel IS DISTINCT FROM 'u'::"char" OR actual.proleakproof OR
        actual.prokind IS DISTINCT FROM 'f'::"char" OR actual.proisstrict OR
        actual.lanname IS DISTINCT FROM CASE WHEN expected.routine_name IN (
          'plan7a_operations_job_catalog', 'plan7a_operations_safe_failure_code'
        ) THEN 'sql' ELSE 'plpgsql' END OR
        actual.definition_sha256 IS DISTINCT FROM expected.definition_sha256
    )
    SELECT 1 FROM invalid_routine
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(ARRAY[
      'public.operations_job_retry_commands',
      'public.operations_job_retry_claims'
    ]::text[]) expected(relation_name)
    LEFT JOIN pg_catalog.pg_class relation_row
      ON relation_row.oid = pg_catalog.to_regclass(expected.relation_name)
    WHERE relation_row.oid IS NULL OR relation_row.relowner <> database_owner OR
      relation_row.relkind <> 'r' OR relation_row.relpersistence <> 'p' OR
      relation_row.relispartition OR relation_row.relrowsecurity OR
      relation_row.relforcerowsecurity OR relation_row.relreplident <> 'd'::"char" OR
      relation_row.relhasrules
  ) OR (
    SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.string_agg(storage_descriptor.descriptor, E'\n'
        ORDER BY storage_descriptor.descriptor), 'UTF8'
    )), 'hex')
    FROM (
      SELECT 'relation:' || relation_row.relname || ':' ||
        relation_row.relkind::text || ':' || relation_row.relpersistence::text || ':' ||
        CASE relation_row.relowner WHEN database_owner THEN '<owner>'
          ELSE pg_catalog.pg_get_userbyid(relation_row.relowner) END || ':' ||
        relation_row.relrowsecurity::text || ':' || relation_row.relforcerowsecurity::text ||
        ':' || relation_row.relreplident::text || ':' || relation_row.relispartition::text ||
        ':' || relation_row.relhasrules::text || ':' || relation_row.relhastriggers::text ||
        ':' || relation_row.relchecks::text AS descriptor
      FROM pg_catalog.pg_class relation_row
      JOIN pg_catalog.pg_namespace namespace_row
        ON namespace_row.oid = relation_row.relnamespace
      WHERE namespace_row.nspname = 'public'
        AND relation_row.relname IN (
          'operations_job_retry_commands', 'operations_job_retry_claims'
        )
      UNION ALL
      SELECT 'column:' || relation_row.relname || ':' || attribute_row.attnum::text || ':' ||
        attribute_row.attname || ':' || type_namespace.nspname || '.' || type_row.typname ||
        ':' || pg_catalog.format_type(attribute_row.atttypid, attribute_row.atttypmod) ||
        ':' || attribute_row.attnotnull::text || ':' || attribute_row.attidentity::text ||
        ':' || attribute_row.attgenerated::text || ':' || coalesce(
          collation_namespace.nspname || '.' || collation_row.collname, ''
        ) || ':' || coalesce(
          pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid), ''
        )
      FROM pg_catalog.pg_attribute attribute_row
      JOIN pg_catalog.pg_class relation_row ON relation_row.oid = attribute_row.attrelid
      JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
      JOIN pg_catalog.pg_type type_row ON type_row.oid = attribute_row.atttypid
      JOIN pg_catalog.pg_namespace type_namespace ON type_namespace.oid = type_row.typnamespace
      LEFT JOIN pg_catalog.pg_attrdef default_row
        ON default_row.adrelid = attribute_row.attrelid
       AND default_row.adnum = attribute_row.attnum
      LEFT JOIN pg_catalog.pg_collation collation_row
        ON collation_row.oid = attribute_row.attcollation
      LEFT JOIN pg_catalog.pg_namespace collation_namespace
        ON collation_namespace.oid = collation_row.collnamespace
      WHERE namespace_row.nspname = 'public'
        AND relation_row.relname IN (
          'operations_job_retry_commands', 'operations_job_retry_claims'
        ) AND attribute_row.attnum > 0 AND NOT attribute_row.attisdropped
      UNION ALL
      SELECT 'constraint:' || relation_row.relname || ':' || constraint_row.conname || ':' ||
        constraint_row.contype::text || ':' || constraint_row.convalidated::text || ':' ||
        constraint_row.condeferrable::text || ':' || constraint_row.condeferred::text || ':' ||
        constraint_row.connoinherit::text || ':' ||
        pg_catalog.pg_get_constraintdef(constraint_row.oid, true) AS descriptor
      FROM pg_catalog.pg_constraint constraint_row
      JOIN pg_catalog.pg_class relation_row ON relation_row.oid = constraint_row.conrelid
      JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
      WHERE namespace_row.nspname = 'public'
        AND relation_row.relname IN (
          'operations_job_retry_commands', 'operations_job_retry_claims'
        )
      UNION ALL
      SELECT 'index:' || table_relation.relname || ':' || index_namespace.nspname || '.' ||
        index_relation.relname || ':' ||
        CASE index_relation.relowner WHEN database_owner THEN '<owner>'
          ELSE pg_catalog.pg_get_userbyid(index_relation.relowner) END || ':' ||
        index_row.indisunique::text || ':' || index_row.indisprimary::text || ':' ||
        index_row.indisexclusion::text || ':' || index_row.indimmediate::text || ':' ||
        index_row.indisclustered::text || ':' || index_row.indisvalid::text || ':' ||
        index_row.indisready::text || ':' || index_row.indislive::text || ':' ||
        index_row.indisreplident::text || ':' ||
        pg_catalog.pg_get_indexdef(index_relation.oid)
      FROM pg_catalog.pg_index index_row
      JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_row.indexrelid
      JOIN pg_catalog.pg_namespace index_namespace
        ON index_namespace.oid = index_relation.relnamespace
      JOIN pg_catalog.pg_class table_relation ON table_relation.oid = index_row.indrelid
      JOIN pg_catalog.pg_namespace table_namespace
        ON table_namespace.oid = table_relation.relnamespace
      WHERE table_namespace.nspname = 'public'
        AND table_relation.relname IN (
          'operations_job_retry_commands', 'operations_job_retry_claims'
        )
    ) storage_descriptor
  ) IS DISTINCT FROM '6001a821a734f08c22041747299bdb27e6191d380318813a425fbd87eae46d20'
  OR EXISTS (
    WITH expected_enum(type_name, labels) AS (
      VALUES
        ('operations_job_retry_claim_state'::text,
          ARRAY['active','invalidated']::text[]),
        ('operations_job_retry_command_status',
          ARRAY['pending','succeeded','denied','failed']::text[]),
        ('operations_job_retry_reason_code',
          ARRAY['dependency_recovered','configuration_recovered',
            'operator_reassessment']::text[]),
        ('operations_job_retry_result_code',
          ARRAY['rearmed_existing','successor_enqueued','already_current',
            'retry_not_supported','retry_policy_not_enabled',
            'provider_recovery_not_enabled','target_not_failed',
            'target_state_changed','domain_state_not_retryable','source_unavailable',
            'actor_not_authorized','retry_command_invalid',
            'retry_command_exhausted','unexpected_failure']::text[])
    ), resolved_enum AS (
      SELECT expected.*, type_row.oid, type_row.typowner, type_row.typtype,
        type_row.typcategory, type_row.typisdefined, type_row.typrelid,
        type_row.typelem, type_row.typcollation, type_row.typarray,
        ARRAY(
          SELECT enum_row.enumlabel::text
          FROM pg_catalog.pg_enum enum_row
          WHERE enum_row.enumtypid = type_row.oid
          ORDER BY enum_row.enumsortorder
        ) AS actual_labels,
        (SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_type shadow_type
         WHERE shadow_type.typname = expected.type_name) AS global_name_count
      FROM expected_enum expected
      LEFT JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.nspname = 'public'
      LEFT JOIN pg_catalog.pg_type type_row
        ON type_row.typnamespace = namespace_row.oid
       AND type_row.typname = expected.type_name
    )
    SELECT 1 FROM resolved_enum resolved
    LEFT JOIN pg_catalog.pg_type array_type ON array_type.oid = resolved.typarray
    LEFT JOIN pg_catalog.pg_namespace array_namespace
      ON array_namespace.oid = array_type.typnamespace
    WHERE resolved.oid IS NULL OR resolved.typowner IS DISTINCT FROM database_owner OR
      resolved.typtype IS DISTINCT FROM 'e'::"char" OR
      resolved.typcategory IS DISTINCT FROM 'E'::"char" OR
      NOT resolved.typisdefined OR resolved.typrelid <> 0 OR resolved.typelem <> 0 OR
      resolved.typcollation <> 0 OR resolved.actual_labels IS DISTINCT FROM resolved.labels OR
      resolved.global_name_count <> 1 OR resolved.typarray = 0 OR array_type.oid IS NULL OR
      array_namespace.nspname IS DISTINCT FROM 'public' OR
      array_type.typname IS DISTINCT FROM '_' || resolved.type_name OR
      array_type.typowner IS DISTINCT FROM database_owner OR
      array_type.typtype IS DISTINCT FROM 'b'::"char" OR
      array_type.typcategory IS DISTINCT FROM 'A'::"char" OR
      NOT array_type.typisdefined OR array_type.typrelid <> 0 OR
      array_type.typelem IS DISTINCT FROM resolved.oid OR array_type.typcollation <> 0 OR
      (SELECT pg_catalog.count(*) FROM pg_catalog.pg_type shadow_array
       WHERE shadow_array.typname = '_' || resolved.type_name) <> 1
  ) OR EXISTS (
    WITH expected_table_type(relation_name) AS (
      VALUES
        ('operations_job_retry_commands'::text),
        ('operations_job_retry_claims'::text)
    )
    SELECT 1
    FROM expected_table_type expected
    LEFT JOIN pg_catalog.pg_namespace relation_namespace
      ON relation_namespace.nspname = 'public'
    LEFT JOIN pg_catalog.pg_class relation_row
      ON relation_row.relnamespace = relation_namespace.oid
     AND relation_row.relname = expected.relation_name
    LEFT JOIN pg_catalog.pg_type row_type ON row_type.oid = relation_row.reltype
    LEFT JOIN pg_catalog.pg_namespace row_namespace
      ON row_namespace.oid = row_type.typnamespace
    LEFT JOIN pg_catalog.pg_type array_type ON array_type.oid = row_type.typarray
    LEFT JOIN pg_catalog.pg_namespace array_namespace
      ON array_namespace.oid = array_type.typnamespace
    WHERE relation_row.oid IS NULL OR relation_row.reltype = 0 OR
      row_type.oid IS NULL OR row_namespace.nspname IS DISTINCT FROM 'public' OR
      row_type.typname IS DISTINCT FROM expected.relation_name OR
      row_type.typowner IS DISTINCT FROM database_owner OR
      row_type.typtype IS DISTINCT FROM 'c'::"char" OR
      row_type.typcategory IS DISTINCT FROM 'C'::"char" OR
      NOT row_type.typisdefined OR
      row_type.typrelid IS DISTINCT FROM relation_row.oid OR row_type.typelem <> 0 OR
      row_type.typcollation <> 0 OR row_type.typarray = 0 OR
      array_type.oid IS NULL OR array_namespace.nspname IS DISTINCT FROM 'public' OR
      array_type.typname IS DISTINCT FROM '_' || expected.relation_name OR
      array_type.typowner IS DISTINCT FROM database_owner OR
      array_type.typtype IS DISTINCT FROM 'b'::"char" OR
      array_type.typcategory IS DISTINCT FROM 'A'::"char" OR
      NOT array_type.typisdefined OR array_type.typrelid <> 0 OR
      array_type.typelem IS DISTINCT FROM row_type.oid OR array_type.typcollation <> 0 OR
      (SELECT pg_catalog.count(*) FROM pg_catalog.pg_type shadow_type
       WHERE shadow_type.typname = expected.relation_name) <> 1 OR
      (SELECT pg_catalog.count(*) FROM pg_catalog.pg_type shadow_array
       WHERE shadow_array.typname = '_' || expected.relation_name) <> 1
  ) OR EXISTS (
    WITH expected_binding(relation_name, column_name, type_name) AS (
      VALUES
        ('operations_job_retry_claims'::text, 'state'::text,
          'operations_job_retry_claim_state'::text),
        ('operations_job_retry_commands', 'reason_code',
          'operations_job_retry_reason_code'),
        ('operations_job_retry_commands', 'status',
          'operations_job_retry_command_status'),
        ('operations_job_retry_commands', 'safe_result_code',
          'operations_job_retry_result_code')
    )
    SELECT 1
    FROM expected_binding expected
    LEFT JOIN pg_catalog.pg_class relation_row
      ON relation_row.oid = pg_catalog.to_regclass('public.' || expected.relation_name)
    LEFT JOIN pg_catalog.pg_attribute attribute_row
      ON attribute_row.attrelid = relation_row.oid
     AND attribute_row.attname = expected.column_name
     AND attribute_row.attnum > 0 AND NOT attribute_row.attisdropped
    WHERE attribute_row.atttypid IS DISTINCT FROM
      pg_catalog.to_regtype('public.' || expected.type_name)::oid
  ) OR EXISTS (
    WITH expected_index(index_name, table_name) AS (
      VALUES
        ('plan7a_operations_retry_claims_pkey'::text,
          'operations_job_retry_claims'::text),
        ('plan7a_operations_retry_commands_pkey',
          'operations_job_retry_commands'),
        ('plan7a_operations_retry_claims_command_unique',
          'operations_job_retry_claims'),
        ('plan7a_operations_retry_commands_actor_idempotency_unique',
          'operations_job_retry_commands'),
        ('plan7a_operations_retry_commands_status_created_idx',
          'operations_job_retry_commands'),
        ('plan7a_operations_retry_commands_target_created_idx',
          'operations_job_retry_commands')
    ), resolved_index AS (
      SELECT expected.*, index_relation.oid, index_relation.relowner,
        index_relation.relkind, index_relation.relpersistence,
        index_relation.relispartition, index_row.indrelid,
        index_row.indisvalid, index_row.indisready, index_row.indislive,
        table_relation.oid AS table_oid,
        (SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_class shadow_relation
         WHERE shadow_relation.relname = expected.index_name) AS global_name_count
      FROM expected_index expected
      LEFT JOIN pg_catalog.pg_namespace public_namespace
        ON public_namespace.nspname = 'public'
      LEFT JOIN pg_catalog.pg_class index_relation
        ON index_relation.relnamespace = public_namespace.oid
       AND index_relation.relname = expected.index_name
      LEFT JOIN pg_catalog.pg_index index_row ON index_row.indexrelid = index_relation.oid
      LEFT JOIN pg_catalog.pg_class table_relation
        ON table_relation.relnamespace = public_namespace.oid
       AND table_relation.relname = expected.table_name
    )
    SELECT 1 FROM resolved_index resolved
    WHERE resolved.oid IS NULL OR resolved.relowner IS DISTINCT FROM database_owner OR
      resolved.relkind IS DISTINCT FROM 'i'::"char" OR
      resolved.relpersistence IS DISTINCT FROM 'p'::"char" OR
      resolved.relispartition OR resolved.table_oid IS NULL OR
      resolved.indrelid IS DISTINCT FROM resolved.table_oid OR
      NOT resolved.indisvalid OR NOT resolved.indisready OR NOT resolved.indislive OR
      resolved.global_name_count <> 1
  ) OR EXISTS (
    WITH expected_guard(signature, security_definer, definition_sha256) AS (
      VALUES
        ('public.plan6b_guard_audit_insert()'::text, false,
          'e84ef5f2a1d00b495c9bd6c01b27461fa57f0c4d0ac462a4bbc8f1386cb6f2b5'::text),
        ('public.plan6b_guard_job_insert()'::text, true,
          '3b4d7d5f65d013cea7fa3da0c23b0d3c495feaa022719ccbfd0b93e8a4804771'::text)
    ), resolved_guard AS (
      SELECT expected.*, pg_catalog.to_regprocedure(expected.signature)::oid routine_oid
      FROM expected_guard expected
    )
    SELECT 1
    FROM resolved_guard resolved
    LEFT JOIN pg_catalog.pg_proc routine ON routine.oid = resolved.routine_oid
    LEFT JOIN pg_catalog.pg_language language_row ON language_row.oid = routine.prolang
    WHERE routine.oid IS NULL OR routine.proowner IS DISTINCT FROM database_owner OR
      routine.prokind IS DISTINCT FROM 'f'::"char" OR
      routine.provolatile IS DISTINCT FROM 'v'::"char" OR
      routine.proparallel IS DISTINCT FROM 'u'::"char" OR
      routine.prosecdef IS DISTINCT FROM resolved.security_definer OR
      routine.proleakproof OR routine.proisstrict OR routine.proretset OR
      routine.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[] OR
      routine.prorettype IS DISTINCT FROM 'pg_catalog.trigger'::pg_catalog.regtype OR
      routine.pronargs <> 0 OR routine.pronargdefaults <> 0 OR
      language_row.lanname IS DISTINCT FROM 'plpgsql' OR
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        pg_catalog.replace(pg_catalog.replace(
          pg_catalog.pg_get_functiondef(routine.oid), E'\r\n', E'\n'
        ), E'\r', E'\n'), 'UTF8'
      )), 'hex') IS DISTINCT FROM resolved.definition_sha256 OR
      (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc overload
       WHERE overload.pronamespace = 'public'::pg_catalog.regnamespace
         AND overload.proname = routine.proname) <> 1
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 7A operations authority descriptor postflight failed';
  END IF;

  IF EXISTS (
    WITH protected_routine(signature, allowed_group) AS (
      VALUES
        ('public.plan6b_guard_job_insert()'::text, NULL::text),
        ('public.plan6b_guard_audit_insert()', NULL),
        ('public.plan7a_operations_job_catalog()'::text, NULL::text),
        ('public.plan7a_operations_safe_failure_code(text,text)', NULL),
        ('public.plan7a_operations_assert_job_capability(uuid,uuid,text,integer,integer)', NULL),
        ('public.plan7a_operations_guard_command_update()', NULL),
        ('public.plan7a_operations_guard_command_delete()', NULL),
        ('public.plan7a_operations_guard_job_transition()', NULL),
        ('public.list_operational_jobs(uuid,text,text,timestamp with time zone,uuid,integer)',
          'pale_orbit_runtime'),
        ('public.submit_job_retry_command(uuid,uuid,text,integer,integer,timestamp with time zone,text,text,text,text)',
          'pale_orbit_runtime'),
        ('public.get_owned_job_retry_command(uuid,uuid)', 'pale_orbit_runtime'),
        ('public.plan7a_operations_claim_job(uuid,text,integer)',
          'pale_orbit_financial_worker'),
        ('public.plan7a_operations_renew_job_claim(uuid,text,integer,integer)',
          'pale_orbit_financial_worker'),
        ('public.plan7a_operations_relinquish_job(uuid,text,integer,integer,text,integer)',
          'pale_orbit_financial_worker'),
        ('public.plan7a_operations_complete_job(uuid,text,integer,integer)',
          'pale_orbit_financial_worker'),
        ('public.plan7a_operations_fail_job(uuid,text,integer,integer,text)',
          'pale_orbit_financial_worker'),
        ('public.plan7a_operations_exhaust_job(uuid,text,integer,integer)',
          'pale_orbit_financial_worker'),
        ('public.plan7a_operations_lock_job_retry_command(uuid,uuid,text,integer,integer)',
          'pale_orbit_financial_worker'),
        ('public.plan7a_operations_transition_job_retry_command(uuid,uuid,text,integer,integer,operations_job_retry_result_code)',
          'pale_orbit_financial_worker')
    ), actual_acl AS (
      SELECT protected.signature, privilege.grantee, privilege.grantor,
        privilege.privilege_type::text privilege_type, privilege.is_grantable
      FROM protected_routine protected
      JOIN pg_catalog.pg_proc routine
        ON routine.oid = pg_catalog.to_regprocedure(protected.signature)
      CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
        routine.proacl, pg_catalog.acldefault('f', routine.proowner)
      )) privilege
    ), expected_acl AS (
      SELECT protected.signature, database_owner, database_owner, 'EXECUTE'::text,
        false AS is_grantable
      FROM protected_routine protected
      UNION ALL
      SELECT protected.signature,
        protected.allowed_group::pg_catalog.regrole::oid, database_owner,
        'EXECUTE'::text, false
      FROM protected_routine protected WHERE protected.allowed_group IS NOT NULL
    ), acl_delta AS (
      (SELECT * FROM actual_acl EXCEPT ALL SELECT * FROM expected_acl)
      UNION ALL
      (SELECT * FROM expected_acl EXCEPT ALL SELECT * FROM actual_acl)
    )
    SELECT 1 FROM acl_delta
  ) OR EXISTS (
    WITH protected_table(relation_name) AS (
      VALUES
        ('operations_job_retry_commands'::text),
        ('operations_job_retry_claims'::text)
    ), resolved_table AS (
      SELECT protected.relation_name, relation_row.oid, relation_row.relowner,
        relation_row.relacl
      FROM protected_table protected
      LEFT JOIN pg_catalog.pg_namespace namespace_row
        ON namespace_row.nspname = 'public'
      LEFT JOIN pg_catalog.pg_class relation_row
        ON relation_row.relnamespace = namespace_row.oid
       AND relation_row.relname = protected.relation_name
    ), actual_table_acl AS (
      SELECT resolved.relation_name, privilege.grantee, privilege.grantor,
        privilege.privilege_type::text, privilege.is_grantable
      FROM resolved_table resolved
      CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
        resolved.relacl, pg_catalog.acldefault('r', resolved.relowner)
      )) privilege
    ), expected_table_acl AS (
      SELECT protected.relation_name, privilege.grantee, privilege.grantor,
        privilege.privilege_type::text, privilege.is_grantable
      FROM protected_table protected
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        pg_catalog.acldefault('r', database_owner)
      ) privilege
    ), table_acl_delta AS (
      (SELECT * FROM actual_table_acl EXCEPT ALL SELECT * FROM expected_table_acl)
      UNION ALL
      (SELECT * FROM expected_table_acl EXCEPT ALL SELECT * FROM actual_table_acl)
    )
    SELECT 1 FROM resolved_table
    WHERE oid IS NULL OR relowner IS DISTINCT FROM database_owner
    UNION ALL SELECT 1 FROM table_acl_delta
  ) OR EXISTS (
    WITH protected_column_acl AS (
      SELECT relation_row.relname::text AS relation_name,
        attribute_row.attname::text AS column_name, attribute_row.attacl
      FROM pg_catalog.pg_attribute attribute_row
      JOIN pg_catalog.pg_class relation_row ON relation_row.oid = attribute_row.attrelid
      JOIN pg_catalog.pg_namespace namespace_row
        ON namespace_row.oid = relation_row.relnamespace
      WHERE namespace_row.nspname = 'public'
        AND relation_row.relname IN (
          'operations_job_retry_commands', 'operations_job_retry_claims'
        ) AND attribute_row.attnum > 0 AND NOT attribute_row.attisdropped
    ), actual_column_acl AS (
      SELECT protected.relation_name, protected.column_name,
        column_privilege.grantee, column_privilege.grantor,
        column_privilege.privilege_type::text, column_privilege.is_grantable
      FROM protected_column_acl protected
      CROSS JOIN LATERAL pg_catalog.aclexplode(protected.attacl) column_privilege
    )
    SELECT 1 FROM protected_column_acl
    WHERE protected_column_acl.attacl IS NOT NULL
    UNION ALL SELECT 1 FROM actual_column_acl
  ) OR EXISTS (
    WITH protected_type(type_name, worker_usage) AS (
      VALUES
        ('operations_job_retry_command_status'::text, false),
        ('operations_job_retry_result_code', true),
        ('operations_job_retry_reason_code', false),
        ('operations_job_retry_claim_state', false)
    ), resolved_type AS (
      SELECT protected.type_name, protected.worker_usage, type_row.oid,
        type_row.typowner, type_row.typacl
      FROM protected_type protected
      LEFT JOIN pg_catalog.pg_namespace namespace_row
        ON namespace_row.nspname = 'public'
      LEFT JOIN pg_catalog.pg_type type_row
        ON type_row.typnamespace = namespace_row.oid
       AND type_row.typname = protected.type_name
    ), actual_type_acl AS (
      SELECT resolved.type_name, privilege.grantee, privilege.grantor,
        privilege.privilege_type::text, privilege.is_grantable
      FROM resolved_type resolved
      CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(
        resolved.typacl, pg_catalog.acldefault('T', resolved.typowner)
      )) privilege
    ), expected_type_acl(
      type_name, grantee, grantor, privilege_type, is_grantable
    ) AS (
      SELECT resolved.type_name, database_owner, database_owner,
        'USAGE'::text, false
      FROM resolved_type resolved
      UNION ALL
      SELECT resolved.type_name,
        'pale_orbit_financial_worker'::pg_catalog.regrole::oid,
        database_owner, 'USAGE'::text, false
      FROM resolved_type resolved WHERE resolved.worker_usage
    ), type_acl_delta AS (
      (SELECT * FROM actual_type_acl EXCEPT ALL SELECT * FROM expected_type_acl)
      UNION ALL
      (SELECT * FROM expected_type_acl EXCEPT ALL SELECT * FROM actual_type_acl)
    )
    SELECT 1 FROM resolved_type
    WHERE oid IS NULL OR typowner IS DISTINCT FROM database_owner
    UNION ALL SELECT 1 FROM type_acl_delta
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 7A operations authority ACL postflight failed';
  END IF;

  IF EXISTS (
    WITH expected_trigger(
      trigger_name, relation_oid, routine_oid, enabled_mode, trigger_type,
      argument_count, argument_bytes, updated_columns, has_no_qualifier
    ) AS (
      VALUES
        ('jobs_plan6b_web_insert_guard'::name,
          'public.jobs'::pg_catalog.regclass::oid,
          'public.plan6b_guard_job_insert()'::pg_catalog.regprocedure::oid,
          'O'::"char", 7::smallint, 0::smallint, ''::text, ''::text, true),
        ('jobs_plan6bii_financial_admin_lease_guard'::name,
          'public.jobs'::pg_catalog.regclass::oid,
          'public.plan6bii_guard_financial_admin_job_lease()'::pg_catalog.regprocedure::oid,
          'O'::"char", 19::smallint, 0::smallint, ''::text, ''::text, true),
        ('jobs_plan6bii_financial_admin_terminal_sync'::name,
          'public.jobs'::pg_catalog.regclass::oid,
          'public.plan6bii_sync_failed_financial_admin_command()'::pg_catalog.regprocedure::oid,
          'O'::"char", 19::smallint, 0::smallint, ''::text, ''::text, true),
        ('audit_events_plan6b_web_insert_guard'::name,
          'public.audit_events'::pg_catalog.regclass::oid,
          'public.plan6b_guard_audit_insert()'::pg_catalog.regprocedure::oid,
          'O'::"char", 7::smallint, 0::smallint, ''::text, ''::text, true),
        ('audit_events_reject_update'::name,
          'public.audit_events'::pg_catalog.regclass::oid,
          'public.reject_audit_event_mutation()'::pg_catalog.regprocedure::oid,
          'O'::"char", 19::smallint, 0::smallint, ''::text, ''::text, true),
        ('audit_events_reject_delete'::name,
          'public.audit_events'::pg_catalog.regclass::oid,
          'public.reject_audit_event_mutation()'::pg_catalog.regprocedure::oid,
          'O'::"char", 11::smallint, 0::smallint, ''::text, ''::text, true),
        ('plan7a_operations_retry_commands_update_guard'::name,
          'public.operations_job_retry_commands'::pg_catalog.regclass::oid,
          'public.plan7a_operations_guard_command_update()'::pg_catalog.regprocedure::oid,
          'O'::"char", 19::smallint, 0::smallint, ''::text, ''::text, true),
        ('plan7a_operations_retry_commands_delete_guard'::name,
          'public.operations_job_retry_commands'::pg_catalog.regclass::oid,
          'public.plan7a_operations_guard_command_delete()'::pg_catalog.regprocedure::oid,
          'O'::"char", 11::smallint, 0::smallint, ''::text, ''::text, true),
        ('plan7a_operations_jobs_transition_guard'::name,
          'public.jobs'::pg_catalog.regclass::oid,
          'public.plan7a_operations_guard_job_transition()'::pg_catalog.regprocedure::oid,
          'O'::"char", 19::smallint, 0::smallint, ''::text, ''::text, true)
    ), actual_trigger AS (
      SELECT trigger_row.tgname, trigger_row.tgrelid, trigger_row.tgfoid,
        trigger_row.tgenabled, trigger_row.tgtype, trigger_row.tgnargs,
        pg_catalog.encode(trigger_row.tgargs, 'hex'), trigger_row.tgattr::text,
        trigger_row.tgqual IS NULL
      FROM pg_catalog.pg_trigger trigger_row
      WHERE NOT trigger_row.tgisinternal AND (
        trigger_row.tgrelid = 'public.jobs'::pg_catalog.regclass OR
        trigger_row.tgrelid = 'public.audit_events'::pg_catalog.regclass OR
        trigger_row.tgrelid = 'public.operations_job_retry_commands'::pg_catalog.regclass OR
        trigger_row.tgrelid = 'public.operations_job_retry_claims'::pg_catalog.regclass
      )
    ), trigger_delta AS (
      (SELECT * FROM actual_trigger EXCEPT ALL SELECT * FROM expected_trigger)
      UNION ALL
      (SELECT * FROM expected_trigger EXCEPT ALL SELECT * FROM actual_trigger)
    ) SELECT 1 FROM trigger_delta
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_rewrite rule_row
    WHERE rule_row.ev_class IN (
      'public.operations_job_retry_commands'::pg_catalog.regclass,
      'public.operations_job_retry_claims'::pg_catalog.regclass
    )
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_inherits inheritance_row
    WHERE inheritance_row.inhparent IN (
      'public.jobs'::pg_catalog.regclass,
      'public.audit_events'::pg_catalog.regclass,
      'public.operations_job_retry_commands'::pg_catalog.regclass,
      'public.operations_job_retry_claims'::pg_catalog.regclass
    ) OR inheritance_row.inhrelid IN (
      'public.jobs'::pg_catalog.regclass,
      'public.audit_events'::pg_catalog.regclass,
      'public.operations_job_retry_commands'::pg_catalog.regclass,
      'public.operations_job_retry_claims'::pg_catalog.regclass
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 7A operations authority trigger postflight failed';
  END IF;

  SELECT pg_catalog.count(*)::integer INTO descriptor_count
  FROM "public"."plan7a_operations_job_catalog"();
  IF descriptor_count IS DISTINCT FROM 11 OR EXISTS (
    SELECT 1
    FROM "public"."plan7a_operations_job_catalog"() catalog
    WHERE catalog.provider_calls_in_plan7a OR catalog.max_attempts NOT BETWEEN 1 AND 12
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 7A operations authority catalog postflight failed';
  END IF;
END;
$plan7a_operations_authority_postflight$;
