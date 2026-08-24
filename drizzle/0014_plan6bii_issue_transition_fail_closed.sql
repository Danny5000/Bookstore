DO $plan6bii_issue_transition_fail_closed_preflight$
DECLARE
  database_oid oid;
  database_owner oid;
  database_owner_name name;
  expected_web_login text;
  expected_worker_login text;
  expected_storage_cleanup_login text;
  transition_oid oid;
  actual_definition_sha256 text;
BEGIN
  SELECT database_row.oid, database_row.datdba,
    pg_catalog.pg_get_userbyid(database_row.datdba)
  INTO database_oid, database_owner, database_owner_name
  FROM pg_catalog.pg_database database_row
  WHERE database_row.datname = pg_catalog.current_database();

  IF database_owner IS NULL OR current_user IS DISTINCT FROM database_owner_name OR
    pg_catalog.current_setting('session_replication_role') IS DISTINCT FROM 'origin' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 6B-II issue-transition repair requires canonical owner authority';
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
      MESSAGE = 'Plan 6B-II issue-transition repair login identity is not canonical';
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
      MESSAGE = 'Plan 6B-II issue-transition repair login identity is not canonical';
  END IF;

  IF EXISTS (
    WITH unsafe_session_replication_default AS (
      SELECT 1
      FROM pg_catalog.pg_db_role_setting setting_row
      CROSS JOIN LATERAL pg_catalog.unnest(setting_row.setconfig) configured_setting(value)
      WHERE ((setting_row.setrole = database_owner AND
          setting_row.setdatabase IN (0::oid, database_oid)) OR
        (setting_row.setrole = 0 AND
          setting_row.setdatabase IN (0::oid, database_oid)))
        AND pg_catalog.split_part(configured_setting.value, '=', 1) =
          'session_replication_role'
        AND pg_catalog.split_part(configured_setting.value, '=', 2) IS DISTINCT FROM 'origin'
    )
    SELECT 1 FROM unsafe_session_replication_default
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 6B-II issue-transition repair session-replication default is not canonical';
  END IF;

  IF EXISTS (
    WITH protected_parameter_principal(role_oid) AS (
      SELECT role_row.oid
      FROM pg_catalog.pg_roles role_row
      WHERE role_row.rolname IN (
        'pale_orbit_runtime', 'pale_orbit_financial_worker',
        'pale_orbit_storage_cleanup'
      )
      UNION
      SELECT membership.member
      FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted_role ON granted_role.oid = membership.roleid
      JOIN pg_catalog.pg_roles member_role ON member_role.oid = membership.member
      WHERE granted_role.rolname IN (
        'pale_orbit_runtime', 'pale_orbit_financial_worker',
        'pale_orbit_storage_cleanup'
      ) AND member_role.rolcanlogin
    ), unsafe_parameter_acl AS (
      SELECT parameter_acl.parname, privilege.grantee,
        privilege.grantor, privilege.privilege_type, privilege.is_grantable
      FROM pg_catalog.pg_parameter_acl parameter_acl
      CROSS JOIN LATERAL pg_catalog.aclexplode(parameter_acl.paracl) privilege
      WHERE privilege.grantee = 0 OR privilege.grantee IN (
        SELECT principal.role_oid FROM protected_parameter_principal principal
      )
    )
    SELECT 1 FROM unsafe_parameter_acl
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 6B-II issue-transition repair parameter ACL is not canonical';
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

  LOCK TABLE "public"."financial_admin_commands" IN EXCLUSIVE MODE;
  LOCK TABLE "public"."financial_allocation_sets",
    "public"."financial_reconciliation_issues", "public"."audit_events"
    IN SHARE ROW EXCLUSIVE MODE;

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
    '33a6441df520bf0c6ed486f7c3b8585ad719683dfe73835eb62176d5bbf898c8' THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 6B-II issue-transition repair predecessor definition is not canonical';
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
END;
$plan6bii_issue_transition_fail_closed_preflight$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "public"."plan6b_validate_issue_transition"() RETURNS trigger
LANGUAGE plpgsql AS $plan6bii_issue_transition_fail_closed$
DECLARE
  worker_resolution boolean := false;
  admin_resolution boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'financial issue history cannot be deleted';
  END IF;
  IF OLD.resource_type = 'financial_classification'
    AND OLD.safe_code = 'unsupported_category'
    AND NEW.state <> 'open' THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'immutable classification diagnostics cannot be resolved';
  END IF;
  IF OLD.state = 'resolved' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'resolved financial issue history is immutable';
  END IF;
  IF NEW.state = 'resolved' THEN
    worker_resolution :=
      COALESCE(
        pg_catalog.current_setting('pale_orbit.financial_worker_issue_resolution', true) =
          OLD.id::text,
        false
      ) AND
      current_user = (
        SELECT pg_catalog.pg_get_userbyid(worker_resolver.proowner)
        FROM pg_catalog.pg_proc worker_resolver
        WHERE worker_resolver.oid =
          'public.resolve_financial_issue_after_worker_recompute(uuid,text)'::pg_catalog.regprocedure
      ) AND NEW.resolved_by_admin_id IS NULL AND NEW.resolved_at IS NOT NULL AND
      NEW.occurrence_count = OLD.occurrence_count AND
      NEW.last_observed_at IS NOT DISTINCT FROM OLD.last_observed_at;
    admin_resolution :=
      COALESCE(
        pg_catalog.current_setting(
          'pale_orbit.plan6bii_financial_admin_issue_resolution_issue_id', true
        ) = OLD.id::text,
        false
      ) AND COALESCE(
        pg_catalog.current_setting(
          'pale_orbit.plan6bii_financial_admin_issue_resolution_command_id', true
        ) ~ '^[0-9a-f-]{36}$',
        false
      ) AND COALESCE(
        pg_catalog.current_setting(
          'pale_orbit.plan6bii_financial_admin_issue_resolution_actor_id', true
        ) = NEW.resolved_by_admin_id::text,
        false
      ) AND
      current_user = (
        SELECT pg_catalog.pg_get_userbyid(admin_resolver.proowner)
        FROM pg_catalog.pg_proc admin_resolver
        WHERE admin_resolver.oid =
          'public.resolve_financial_issue_after_admin_command(uuid,uuid)'::pg_catalog.regprocedure
      ) AND NEW.resolved_by_admin_id IS NOT NULL AND NEW.resolved_at IS NOT NULL AND
      NEW.occurrence_count = OLD.occurrence_count AND
      NEW.last_observed_at IS NOT DISTINCT FROM OLD.last_observed_at;
    IF NOT COALESCE(worker_resolution OR admin_resolution, false) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'financial issue resolution requires a guarded resolver';
    END IF;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.resource_type IS DISTINCT FROM OLD.resource_type OR
     NEW.resource_id IS DISTINCT FROM OLD.resource_id OR NEW.safe_code IS DISTINCT FROM OLD.safe_code OR
     NEW.impact IS DISTINCT FROM OLD.impact OR NEW.first_observed_at IS DISTINCT FROM OLD.first_observed_at OR
     NEW.correlation_id IS DISTINCT FROM OLD.correlation_id OR NEW.occurrence_count < OLD.occurrence_count OR
     NEW.last_observed_at < OLD.last_observed_at OR
     (OLD.state = 'open' AND NEW.state NOT IN ('open', 'resolved')) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid financial issue history mutation';
  END IF;
  RETURN NEW;
END;
$plan6bii_issue_transition_fail_closed$;--> statement-breakpoint

REVOKE ALL ON FUNCTION "public"."plan6b_validate_issue_transition"() FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint

DO $plan6bii_issue_transition_fail_closed_postflight$
DECLARE
  database_owner oid;
  database_owner_name name;
  transition_oid oid;
  actual_definition_sha256 text;
BEGIN
  SELECT database_row.datdba, pg_catalog.pg_get_userbyid(database_row.datdba)
  INTO database_owner, database_owner_name
  FROM pg_catalog.pg_database database_row
  WHERE database_row.datname = pg_catalog.current_database();
  transition_oid := pg_catalog.to_regprocedure(
    'public.plan6b_validate_issue_transition()'
  )::oid;

  IF database_owner IS NULL OR current_user IS DISTINCT FROM database_owner_name OR
    pg_catalog.current_setting('session_replication_role') IS DISTINCT FROM 'origin' OR
    transition_oid IS NULL OR NOT EXISTS (
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
    ) OR NOT EXISTS (
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
      MESSAGE = 'Plan 6B-II issue-transition repair authority postflight failed';
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
      MESSAGE = 'Plan 6B-II issue-transition repair definition postflight failed';
  END IF;
END;
$plan6bii_issue_transition_fail_closed_postflight$;
