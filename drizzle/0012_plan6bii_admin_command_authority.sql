DO $plan6bii_preflight$
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
      MESSAGE = 'Plan 6B-II migration requires canonical owner authority';
  END IF;

  IF pg_catalog.to_regtype('public.financial_admin_command_kind') IS NOT NULL OR
    pg_catalog.to_regtype('public.financial_admin_command_status') IS NOT NULL OR
    pg_catalog.to_regclass('public.financial_admin_commands') IS NOT NULL OR
    pg_catalog.to_regclass('public.financial_admin_job_claims') IS NOT NULL OR
    EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(ARRAY[
        'public.submit_financial_admin_command(uuid,text,text,text,text,jsonb)',
        'public.financial_admin_command_status(uuid,uuid)',
        'public.append_financial_issue_view_audit(uuid,uuid,text,text,text)',
        'public.append_financial_refund_review_view_audit(uuid,uuid,text,text,text)',
        'public.append_financial_payout_view_audit(uuid,uuid,text,text,text)',
        'public.append_financial_sales_export_audit(uuid,text,text,integer,integer,integer,text,text)',
        'public.resolve_financial_issue_after_admin_command(uuid,uuid)',
        'public.transition_administrative_recovery_grant_after_admin_command(uuid)',
        'public.plan6bii_assert_financial_admin_job_lease(uuid)',
        'public.plan6bii_guard_financial_admin_job_lease()',
        'public.plan6bii_guard_financial_admin_command_update()',
        'public.plan6bii_guard_financial_admin_command_delete()',
        'public.plan6bii_guard_administrative_grant_transition()',
        'public.plan6bii_sync_failed_financial_admin_command()'
      ]::text[]) candidate(signature)
      WHERE pg_catalog.to_regprocedure(candidate.signature) IS NOT NULL
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger trigger_row
      WHERE NOT trigger_row.tgisinternal
        AND trigger_row.tgname = ANY(ARRAY[
          'financial_admin_commands_plan6bii_update_guard',
          'financial_admin_commands_plan6bii_delete_guard',
          'jobs_plan6bii_financial_admin_lease_guard',
          'entitlement_grants_plan6bii_administrative_guard',
          'jobs_plan6bii_financial_admin_terminal_sync'
        ]::name[])
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 6B-II authority object name is already occupied';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace namespace_row
    WHERE namespace_row.nspname = 'public'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace namespace_row
    WHERE namespace_row.nspname = 'public'
      AND namespace_row.nspowner NOT IN (
        database_owner,
        'pg_database_owner'::pg_catalog.regrole
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(ARRAY[
      'public.user', 'public.user_roles', 'public.jobs', 'public.audit_events',
      'public.financial_reconciliation_issues', 'public.entitlement_grants',
      'public.refunds', 'public.refund_allocations',
      'public.refund_allocation_drafts', 'public.refund_allocation_draft_items',
      'public.refund_allocation_finalization_effects',
      'public.refund_reporting_correction_sets',
      'public.refund_reporting_correction_items',
      'public.refund_allocation_components', 'public.order_items',
      'public.orders', 'public.titles', 'public.payments', 'public.disputes',
      'public.dispute_item_allocations', 'public.financial_projection_versions',
      'public.stripe_balance_transactions',
      'public.stripe_balance_transaction_fee_details', 'public.stripe_payouts',
      'public.stripe_payout_balance_transactions',
      'public.financial_classification_versions',
      'public.financial_allocation_sets', 'public.financial_item_allocations',
      'public.current_financial_projection_heads',
      'public.current_financial_projection_items',
      'public.stripe_events', 'public.title_revisions'
    ]::text[]) prerequisite(relation_name)
    LEFT JOIN pg_catalog.pg_class relation_row
      ON relation_row.oid = pg_catalog.to_regclass(prerequisite.relation_name)
    WHERE relation_row.oid IS NULL OR relation_row.relowner <> database_owner
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(ARRAY[
      'public.plan6b_guard_job_insert()',
      'public.plan6b_guard_audit_insert()',
      'public.plan6b_validate_issue_transition()',
      'public.reject_audit_event_mutation()',
      'public.plan6b_validate_issue_insert()',
      'public.claim_guest_purchases_after_authorization(text,text)',
      'public.resolve_financial_issue_after_worker_recompute(uuid,text)'
    ]::text[]) prerequisite(signature)
    LEFT JOIN pg_catalog.pg_proc routine
      ON routine.oid = pg_catalog.to_regprocedure(prerequisite.signature)
    WHERE routine.oid IS NULL OR routine.proowner <> database_owner
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(ARRAY[
      'public.job_status', 'public.audit_actor_type', 'public.audit_outcome',
      'public.financial_issue_state', 'public.financial_issue_impact',
      'public.entitlement_grant_status', 'public.entitlement_grant_source',
      'public.refund_allocation_source', 'public.financial_allocation_source_kind',
      'public.financial_allocation_basis', 'public.financial_allocation_scope',
      'public.financial_component', 'public.financial_finalization_transition',
      'public.refund_allocation_draft_state', 'public.refund_correction_kind',
      'public.refund_correction_domain', 'public.commerce_refund_status',
      'public.refund_allocation_status', 'public.commerce_payment_status',
      'public.commerce_order_status', 'public.stripe_event_status',
      'public.revision_state'
    ]::text[]) prerequisite(type_name)
    LEFT JOIN pg_catalog.pg_type type_row
      ON type_row.oid = pg_catalog.to_regtype(prerequisite.type_name)
    WHERE type_row.oid IS NULL OR type_row.typowner <> database_owner
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 6B-II prerequisite owner is not canonical';
  END IF;

  expected_web_login := pg_catalog.current_setting('pale_orbit.migration_expected_web_login', true);
  expected_worker_login := pg_catalog.current_setting('pale_orbit.migration_expected_worker_login', true);
  expected_storage_cleanup_login := pg_catalog.current_setting('pale_orbit.migration_expected_storage_cleanup_login', true);

  IF expected_web_login IS NULL OR
    expected_worker_login IS NULL OR
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
    ]::text[]) OR
    expected_web_login = database_owner_name::text OR
    expected_worker_login = database_owner_name::text OR
    expected_storage_cleanup_login = database_owner_name::text OR
    expected_web_login = expected_worker_login OR
    expected_web_login = expected_storage_cleanup_login OR
    expected_worker_login = expected_storage_cleanup_login THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 6B-II migration login identity is not canonical';
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
          SELECT 1
          FROM pg_catalog.pg_db_role_setting setting_row
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
          SELECT 1
          FROM pg_catalog.pg_db_role_setting setting_row
          WHERE setting_row.setrole = role_row.oid
        )
    ), relevant_role_names(role_name) AS (
      SELECT login_name FROM attested_login_expectations
      UNION SELECT group_name FROM expected_fixed_groups
      UNION SELECT database_owner_name::text
    ), actual_relevant_memberships AS (
      SELECT member_role.rolname::text AS member_name,
        granted_role.rolname::text AS granted_name,
        membership.admin_option AS admin_option,
        membership.inherit_option AS inherit_option,
        membership.set_option AS set_option
      FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles member_role ON member_role.oid = membership.member
      JOIN pg_catalog.pg_roles granted_role ON granted_role.oid = membership.roleid
      WHERE member_role.rolname = database_owner_name::text OR
        granted_role.rolname = database_owner_name::text OR
        member_role.rolname IN (
        SELECT role_name FROM relevant_role_names
      ) OR granted_role.rolname IN (
        SELECT role_name FROM relevant_role_names
      )
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
      WHERE expected_membership.member_name = 'pale_orbit_financial_worker' OR
        EXISTS (
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
      CROSS JOIN LATERAL pg_catalog.unnest(setting_row.setconfig)
        configured_setting(value)
      WHERE ((
        setting_row.setrole = database_owner AND
        setting_row.setdatabase IN (0::oid, database_oid)
      ) OR (
        setting_row.setrole = 0 AND
        setting_row.setdatabase IN (0::oid, database_oid)
      )) AND pg_catalog.split_part(configured_setting.value, '=', 1) = ANY(ARRAY[
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
      MESSAGE = 'Plan 6B-II migration login identity is not canonical';
  END IF;

  IF EXISTS (
    WITH actual_default_acl_identity(
      owner_oid, namespace_oid, object_type
    ) AS (
      SELECT default_acl.defaclrole, default_acl.defaclnamespace,
        default_acl.defaclobjtype
      FROM pg_catalog.pg_default_acl default_acl
    ), expected_default_acl_identity(
      owner_oid, namespace_oid, object_type
    ) AS (
      VALUES
        (database_owner, 'public'::pg_catalog.regnamespace::oid, 'r'::"char"),
        (database_owner, 'public'::pg_catalog.regnamespace::oid, 'S'::"char"),
        (database_owner, 0::oid, 'f'::"char")
    ), default_acl_identity_delta AS (
      (SELECT * FROM actual_default_acl_identity
       EXCEPT SELECT * FROM expected_default_acl_identity)
      UNION ALL
      (SELECT * FROM expected_default_acl_identity
       EXCEPT SELECT * FROM actual_default_acl_identity)
    )
    SELECT 1 FROM default_acl_identity_delta
  ) OR EXISTS (
    WITH raw_explicit_default_acl AS (
      SELECT
        CASE WHEN default_acl.defaclnamespace = 0 THEN 'global'
          ELSE namespace_row.nspname END::text AS namespace_name,
        default_acl.defaclobjtype::text AS object_type,
        owner_role.rolname::text AS owner_name,
        grantor_role.rolname::text AS grantor_name,
        CASE WHEN privilege.grantee = 0 THEN 'PUBLIC'
          ELSE grantee_role.rolname END::text AS grantee_name,
        privilege.privilege_type::text AS privilege_type,
        privilege.is_grantable
      FROM pg_catalog.pg_default_acl default_acl
      JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = default_acl.defaclrole
      LEFT JOIN pg_catalog.pg_namespace namespace_row
        ON namespace_row.oid = default_acl.defaclnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(default_acl.defaclacl) privilege
      JOIN pg_catalog.pg_roles grantor_role ON grantor_role.oid = privilege.grantor
      LEFT JOIN pg_catalog.pg_roles grantee_role ON grantee_role.oid = privilege.grantee
    ), implicit_owner_default_acl AS (
      SELECT 'public'::text AS namespace_name,
        default_acl.defaclobjtype::text AS object_type,
        database_owner_name::text AS owner_name,
        database_owner_name::text AS grantor_name,
        database_owner_name::text AS grantee_name,
        implicit_privilege.privilege_type::text AS privilege_type,
        false AS is_grantable
      FROM pg_catalog.pg_default_acl default_acl
      CROSS JOIN LATERAL (VALUES
        ('r','INSERT'), ('r','SELECT'), ('r','UPDATE'), ('r','DELETE'),
        ('r','TRUNCATE'), ('r','REFERENCES'), ('r','TRIGGER'), ('r','MAINTAIN'),
        ('S','USAGE'), ('S','SELECT'), ('S','UPDATE')
      ) implicit_privilege(object_type, privilege_type)
      WHERE default_acl.defaclrole = database_owner
        AND default_acl.defaclnamespace = 'public'::pg_catalog.regnamespace::oid
        AND default_acl.defaclobjtype IN ('r'::"char", 'S'::"char")
        AND default_acl.defaclobjtype =
          implicit_privilege.object_type::"char"
    ), normalized_effective_default_acl AS (
      SELECT * FROM raw_explicit_default_acl
      UNION ALL
      SELECT * FROM implicit_owner_default_acl
    ), expected_default_acl(
      namespace_name, object_type, owner_name, grantor_name,
      grantee_name, privilege_type, is_grantable
    ) AS (
      SELECT expected.namespace_name, expected.object_type,
        database_owner_name::text, database_owner_name::text,
        expected.grantee_name, expected.privilege_type, false
      FROM (VALUES
        ('public','r',database_owner_name::text,'INSERT'),
        ('public','r',database_owner_name::text,'SELECT'),
        ('public','r',database_owner_name::text,'UPDATE'),
        ('public','r',database_owner_name::text,'DELETE'),
        ('public','r',database_owner_name::text,'TRUNCATE'),
        ('public','r',database_owner_name::text,'REFERENCES'),
        ('public','r',database_owner_name::text,'TRIGGER'),
        ('public','r',database_owner_name::text,'MAINTAIN'),
        ('public','r','pale_orbit_runtime','SELECT'),
        ('public','S',database_owner_name::text,'USAGE'),
        ('public','S',database_owner_name::text,'SELECT'),
        ('public','S',database_owner_name::text,'UPDATE'),
        ('public','S','pale_orbit_runtime','USAGE'),
        ('public','S','pale_orbit_runtime','SELECT'),
        ('public','S','pale_orbit_runtime','UPDATE'),
        ('global','f',database_owner_name::text,'EXECUTE')
      ) expected(namespace_name, object_type, grantee_name, privilege_type)
    ), default_acl_delta AS (
      (SELECT * FROM normalized_effective_default_acl
       EXCEPT ALL SELECT * FROM expected_default_acl)
      UNION ALL
      (SELECT * FROM expected_default_acl
       EXCEPT ALL SELECT * FROM normalized_effective_default_acl)
    )
    SELECT 1 FROM default_acl_delta
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 6B-II database owner default ACL is not canonical';
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
      MESSAGE = 'Plan 6B-II fixed role parameter ACL is not canonical';
  END IF;

  IF EXISTS (
    WITH expected_jobs_trigger_inventory(
      trigger_name, relation_oid, routine_oid, enabled_mode, trigger_type,
      argument_count, argument_bytes, updated_columns, has_no_qualifier
    ) AS (
      VALUES (
        'jobs_plan6b_web_insert_guard'::name,
        'public.jobs'::pg_catalog.regclass::oid,
        'public.plan6b_guard_job_insert()'::pg_catalog.regprocedure::oid,
        'O'::"char", 7::smallint, 0::smallint, ''::text, ''::text, true
      )
    ), actual_jobs_trigger_inventory AS (
      SELECT trigger_row.tgname, trigger_row.tgrelid, trigger_row.tgfoid,
        trigger_row.tgenabled, trigger_row.tgtype, trigger_row.tgnargs,
        pg_catalog.encode(trigger_row.tgargs, 'hex'), trigger_row.tgattr::text,
        trigger_row.tgqual IS NULL
      FROM pg_catalog.pg_trigger trigger_row
      WHERE trigger_row.tgrelid = 'public.jobs'::pg_catalog.regclass
        AND NOT trigger_row.tgisinternal
    ), jobs_trigger_inventory_delta AS (
      (SELECT * FROM actual_jobs_trigger_inventory
       EXCEPT SELECT * FROM expected_jobs_trigger_inventory)
      UNION ALL
      (SELECT * FROM expected_jobs_trigger_inventory
       EXCEPT SELECT * FROM actual_jobs_trigger_inventory)
    ), unexpected_jobs_before_update_trigger AS (
      SELECT trigger_row.tgname
      FROM pg_catalog.pg_trigger trigger_row
      WHERE trigger_row.tgrelid = 'public.jobs'::pg_catalog.regclass
        AND NOT trigger_row.tgisinternal AND trigger_row.tgenabled <> 'D'
        AND (trigger_row.tgtype & 2) = 2
        AND (trigger_row.tgtype & 16) = 16
    )
    SELECT 1 FROM jobs_trigger_inventory_delta
    UNION ALL
    SELECT 1 FROM unexpected_jobs_before_update_trigger
  ) OR EXISTS (
    WITH expected_nonjob_trigger_inventory(
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
          'O'::"char", 27::smallint, 0::smallint, ''::text, ''::text, true)
    ), actual_nonjob_trigger_inventory AS (
      SELECT trigger_row.tgname, trigger_row.tgrelid, trigger_row.tgfoid,
        trigger_row.tgenabled, trigger_row.tgtype, trigger_row.tgnargs,
        pg_catalog.encode(trigger_row.tgargs, 'hex'), trigger_row.tgattr::text,
        trigger_row.tgqual IS NULL
      FROM pg_catalog.pg_trigger trigger_row
      WHERE trigger_row.tgrelid IN (
        'public.audit_events'::pg_catalog.regclass,
        'public.financial_reconciliation_issues'::pg_catalog.regclass
      ) AND NOT trigger_row.tgisinternal
    ), nonjob_trigger_inventory_delta AS (
      (SELECT * FROM actual_nonjob_trigger_inventory
       EXCEPT SELECT * FROM expected_nonjob_trigger_inventory)
      UNION ALL
      (SELECT * FROM expected_nonjob_trigger_inventory
       EXCEPT SELECT * FROM actual_nonjob_trigger_inventory)
    )
    SELECT 1 FROM nonjob_trigger_inventory_delta
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 6B-II prerequisite trigger is missing, disabled, or displaced';
  END IF;

  IF pg_catalog.has_table_privilege(
    'pale_orbit_financial_worker', 'public.jobs', 'TRIGGER'
  ) OR EXISTS (
    WITH actual_database_acl AS (
      SELECT pg_catalog.current_database()::text AS object_name,
        CASE WHEN privilege.grantee = 0 THEN 'PUBLIC'
          ELSE grantee_role.rolname::text END AS grantee_name,
        grantor_role.rolname::text AS grantor_name,
        privilege.privilege_type::text, privilege.is_grantable
      FROM pg_catalog.pg_database database_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
        database_row.datacl, pg_catalog.acldefault('d', database_row.datdba)
      )) privilege
      JOIN pg_catalog.pg_roles grantor_role ON grantor_role.oid = privilege.grantor
      LEFT JOIN pg_catalog.pg_roles grantee_role ON grantee_role.oid = privilege.grantee
      WHERE database_row.datname = pg_catalog.current_database()
    ), expected_database_acl(
      object_name, grantee_name, grantor_name, privilege_type, is_grantable
    ) AS (
      SELECT pg_catalog.current_database()::text, expected.grantee_name,
        database_owner_name::text, expected.privilege_type, false
      FROM (VALUES
        (database_owner_name::text, 'CREATE'),
        (database_owner_name::text, 'CONNECT'),
        (database_owner_name::text, 'TEMPORARY'),
        ('PUBLIC', 'CONNECT'), ('PUBLIC', 'TEMPORARY'),
        ('pale_orbit_runtime', 'CONNECT'),
        ('pale_orbit_financial_worker', 'CONNECT'),
        ('pale_orbit_storage_cleanup', 'CONNECT')
      ) expected(grantee_name, privilege_type)
    ), database_acl_delta AS (
      (SELECT * FROM actual_database_acl EXCEPT SELECT * FROM expected_database_acl)
      UNION ALL
      (SELECT * FROM expected_database_acl EXCEPT SELECT * FROM actual_database_acl)
    ), actual_schema_acl AS (
      SELECT namespace_row.nspname::text AS object_name,
        CASE WHEN privilege.grantee = 0 THEN 'PUBLIC'
          WHEN privilege.grantee IN (
            database_owner, 'pg_database_owner'::pg_catalog.regrole
          ) THEN 'DATABASE_OWNER'
          ELSE grantee_role.rolname::text END AS grantee_name,
        CASE WHEN privilege.grantor IN (
            database_owner, 'pg_database_owner'::pg_catalog.regrole
          ) THEN 'DATABASE_OWNER'
          ELSE grantor_role.rolname::text END AS grantor_name,
        privilege.privilege_type::text, privilege.is_grantable
      FROM pg_catalog.pg_namespace namespace_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
        namespace_row.nspacl, pg_catalog.acldefault('n', namespace_row.nspowner)
      )) privilege
      JOIN pg_catalog.pg_roles grantor_role ON grantor_role.oid = privilege.grantor
      LEFT JOIN pg_catalog.pg_roles grantee_role ON grantee_role.oid = privilege.grantee
      WHERE namespace_row.nspname = 'public'
    ), expected_schema_acl(
      object_name, grantee_name, grantor_name, privilege_type, is_grantable
    ) AS (
      SELECT 'public', expected.grantee_name, 'DATABASE_OWNER',
        expected.privilege_type, false
      FROM (VALUES
        ('DATABASE_OWNER', 'CREATE'),
        ('DATABASE_OWNER', 'USAGE'),
        ('pale_orbit_runtime', 'USAGE'),
        ('pale_orbit_storage_cleanup', 'USAGE')
      ) expected(grantee_name, privilege_type)
    ), schema_acl_delta AS (
      (SELECT * FROM actual_schema_acl EXCEPT ALL SELECT * FROM expected_schema_acl)
      UNION ALL
      (SELECT * FROM expected_schema_acl EXCEPT ALL SELECT * FROM actual_schema_acl)
    ), protected_acl_relations(relation_name) AS (
      VALUES
        ('user'::text), ('user_roles'::text), ('jobs'::text),
        ('audit_events'::text), ('financial_reconciliation_issues'::text),
        ('entitlement_grants'::text), ('refunds'::text),
        ('refund_allocations'::text), ('refund_allocation_drafts'::text),
        ('refund_allocation_draft_items'::text),
        ('refund_allocation_finalization_effects'::text),
        ('refund_reporting_correction_sets'::text),
        ('refund_reporting_correction_items'::text),
        ('refund_allocation_components'::text), ('order_items'::text),
        ('orders'::text), ('titles'::text), ('payments'::text),
        ('disputes'::text), ('dispute_item_allocations'::text),
        ('financial_projection_versions'::text),
        ('stripe_balance_transactions'::text),
        ('stripe_balance_transaction_fee_details'::text),
        ('stripe_payouts'::text), ('stripe_payout_balance_transactions'::text),
        ('financial_classification_versions'::text),
        ('financial_allocation_sets'::text),
        ('financial_item_allocations'::text),
        ('current_financial_projection_heads'::text),
        ('current_financial_projection_items'::text), ('stripe_events'::text),
        ('title_revisions'::text)
    ), actual_relation_acl AS (
      SELECT relation_row.relname::text AS object_name,
        CASE WHEN privilege.grantee = 0 THEN 'PUBLIC'
          ELSE grantee_role.rolname::text END AS grantee_name,
        grantor_role.rolname::text AS grantor_name,
        privilege.privilege_type::text, privilege.is_grantable
      FROM pg_catalog.pg_class relation_row
      JOIN pg_catalog.pg_namespace namespace_row
        ON namespace_row.oid = relation_row.relnamespace
      JOIN protected_acl_relations protected
        ON protected.relation_name = relation_row.relname
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
        relation_row.relacl, pg_catalog.acldefault('r', relation_row.relowner)
      )) privilege
      JOIN pg_catalog.pg_roles grantor_role ON grantor_role.oid = privilege.grantor
      LEFT JOIN pg_catalog.pg_roles grantee_role ON grantee_role.oid = privilege.grantee
      WHERE namespace_row.nspname = 'public'
    ), expected_relation_acl(
      object_name, grantee_name, grantor_name, privilege_type, is_grantable
    ) AS (
      SELECT protected.relation_name, database_owner_name::text,
        database_owner_name::text, owner_privilege.privilege_type, false
      FROM protected_acl_relations protected
      CROSS JOIN (VALUES
        ('INSERT'), ('SELECT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
        ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')
      ) owner_privilege(privilege_type)
      UNION ALL
      SELECT expected.object_name, expected.grantee_name,
        database_owner_name::text, expected.privilege_type, false
      FROM (VALUES
        ('jobs','pale_orbit_runtime','SELECT'),
        ('jobs','pale_orbit_financial_worker','UPDATE'),
        ('audit_events','pale_orbit_runtime','SELECT'),
        ('audit_events','pale_orbit_runtime','INSERT'),
        ('audit_events','pale_orbit_runtime','UPDATE'),
        ('audit_events','pale_orbit_runtime','DELETE'),
        ('financial_reconciliation_issues','pale_orbit_runtime','SELECT'),
        ('financial_reconciliation_issues','pale_orbit_financial_worker','INSERT'),
        ('financial_reconciliation_issues','pale_orbit_financial_worker','UPDATE'),
        ('user','pale_orbit_runtime','SELECT'),
        ('user','pale_orbit_runtime','INSERT'),
        ('user','pale_orbit_runtime','UPDATE'),
        ('user','pale_orbit_runtime','DELETE'),
        ('user_roles','pale_orbit_runtime','SELECT'),
        ('user_roles','pale_orbit_runtime','INSERT'),
        ('user_roles','pale_orbit_runtime','UPDATE'),
        ('user_roles','pale_orbit_runtime','DELETE'),
        ('audit_events','pale_orbit_runtime','SELECT'),
        ('audit_events','pale_orbit_runtime','INSERT'),
        ('audit_events','pale_orbit_runtime','UPDATE'),
        ('audit_events','pale_orbit_runtime','DELETE'),
        ('titles','pale_orbit_runtime','SELECT'),
        ('titles','pale_orbit_runtime','INSERT'),
        ('titles','pale_orbit_runtime','UPDATE'),
        ('titles','pale_orbit_runtime','DELETE'),
        ('entitlement_grants','pale_orbit_runtime','SELECT'),
        ('entitlement_grants','pale_orbit_financial_worker','INSERT'),
        ('entitlement_grants','pale_orbit_financial_worker','UPDATE'),
        ('refunds','pale_orbit_runtime','SELECT'),
        ('refunds','pale_orbit_financial_worker','INSERT'),
        ('refunds','pale_orbit_financial_worker','UPDATE'),
        ('refund_allocations','pale_orbit_runtime','SELECT'),
        ('refund_allocations','pale_orbit_financial_worker','INSERT'),
        ('refund_allocation_drafts','pale_orbit_runtime','SELECT'),
        ('refund_allocation_draft_items','pale_orbit_runtime','SELECT'),
        ('refund_allocation_finalization_effects','pale_orbit_runtime','SELECT'),
        ('refund_reporting_correction_sets','pale_orbit_runtime','SELECT'),
        ('refund_reporting_correction_sets','pale_orbit_financial_worker','INSERT'),
        ('refund_reporting_correction_items','pale_orbit_runtime','SELECT'),
        ('refund_reporting_correction_items','pale_orbit_financial_worker','INSERT'),
        ('refund_allocation_components','pale_orbit_runtime','SELECT'),
        ('refund_allocation_components','pale_orbit_financial_worker','INSERT'),
        ('order_items','pale_orbit_runtime','SELECT'),
        ('order_items','pale_orbit_financial_worker','UPDATE'),
        ('orders','pale_orbit_runtime','SELECT'),
        ('orders','pale_orbit_financial_worker','UPDATE'),
        ('payments','pale_orbit_runtime','SELECT'),
        ('payments','pale_orbit_financial_worker','INSERT'),
        ('payments','pale_orbit_financial_worker','UPDATE'),
        ('disputes','pale_orbit_runtime','SELECT'),
        ('disputes','pale_orbit_financial_worker','INSERT'),
        ('disputes','pale_orbit_financial_worker','UPDATE'),
        ('dispute_item_allocations','pale_orbit_runtime','SELECT'),
        ('dispute_item_allocations','pale_orbit_financial_worker','INSERT'),
        ('financial_projection_versions','pale_orbit_runtime','SELECT'),
        ('financial_projection_versions','pale_orbit_financial_worker','UPDATE'),
        ('stripe_balance_transactions','pale_orbit_runtime','SELECT'),
        ('stripe_balance_transactions','pale_orbit_financial_worker','INSERT'),
        ('stripe_balance_transactions','pale_orbit_financial_worker','UPDATE'),
        ('stripe_balance_transaction_fee_details','pale_orbit_runtime','SELECT'),
        ('stripe_balance_transaction_fee_details','pale_orbit_financial_worker','INSERT'),
        ('stripe_payouts','pale_orbit_runtime','SELECT'),
        ('stripe_payouts','pale_orbit_financial_worker','INSERT'),
        ('stripe_payouts','pale_orbit_financial_worker','UPDATE'),
        ('stripe_payout_balance_transactions','pale_orbit_runtime','SELECT'),
        ('stripe_payout_balance_transactions','pale_orbit_financial_worker','INSERT'),
        ('financial_classification_versions','pale_orbit_runtime','SELECT'),
        ('financial_classification_versions','pale_orbit_financial_worker','INSERT'),
        ('financial_allocation_sets','pale_orbit_runtime','SELECT'),
        ('financial_allocation_sets','pale_orbit_financial_worker','INSERT'),
        ('financial_item_allocations','pale_orbit_runtime','SELECT'),
        ('financial_item_allocations','pale_orbit_financial_worker','INSERT'),
        ('current_financial_projection_heads','pale_orbit_runtime','SELECT'),
        ('current_financial_projection_items','pale_orbit_runtime','SELECT'),
        ('stripe_events','pale_orbit_runtime','SELECT'),
        ('stripe_events','pale_orbit_financial_worker','UPDATE'),
        ('title_revisions','pale_orbit_runtime','SELECT'),
        ('title_revisions','pale_orbit_financial_worker','UPDATE')
      ) expected(object_name, grantee_name, privilege_type)
    ), relation_acl_delta AS (
      (SELECT * FROM actual_relation_acl EXCEPT SELECT * FROM expected_relation_acl)
      UNION ALL
      (SELECT * FROM expected_relation_acl EXCEPT SELECT * FROM actual_relation_acl)
    ), actual_column_acl AS (
      SELECT (relation_row.relname || '.' || attribute_row.attname)::text AS object_name,
        CASE WHEN privilege.grantee = 0 THEN 'PUBLIC'
          ELSE grantee_role.rolname::text END AS grantee_name,
        grantor_role.rolname::text AS grantor_name,
        privilege.privilege_type::text, privilege.is_grantable
      FROM pg_catalog.pg_attribute attribute_row
      JOIN pg_catalog.pg_class relation_row ON relation_row.oid = attribute_row.attrelid
      JOIN pg_catalog.pg_namespace namespace_row
        ON namespace_row.oid = relation_row.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute_row.attacl) privilege
      JOIN pg_catalog.pg_roles grantor_role ON grantor_role.oid = privilege.grantor
      LEFT JOIN pg_catalog.pg_roles grantee_role ON grantee_role.oid = privilege.grantee
      WHERE namespace_row.nspname = 'public'
        AND relation_row.relname IN (
          SELECT protected.relation_name FROM protected_acl_relations protected
        )
    ), expected_column_acl(
      object_name, grantee_name, grantor_name, privilege_type, is_grantable
    ) AS (
      SELECT expected.object_name, expected.grantee_name,
        database_owner_name::text, expected.privilege_type, false
      FROM (VALUES
        ('jobs.type','pale_orbit_runtime','INSERT'),
        ('jobs.payload','pale_orbit_runtime','INSERT'),
        ('jobs.deduplication_key','pale_orbit_runtime','INSERT'),
        ('jobs.run_at','pale_orbit_runtime','INSERT'),
        ('jobs.max_attempts','pale_orbit_runtime','INSERT'),
        ('stripe_events.provider_event_id','pale_orbit_runtime','INSERT'),
        ('stripe_events.event_type','pale_orbit_runtime','INSERT'),
        ('stripe_events.object_id','pale_orbit_runtime','INSERT'),
        ('stripe_events.live_mode','pale_orbit_runtime','INSERT'),
        ('stripe_events.api_version','pale_orbit_runtime','INSERT'),
        ('stripe_events.provider_created_at','pale_orbit_runtime','INSERT'),
        ('stripe_events.raw_body_sha256','pale_orbit_runtime','INSERT'),
        ('orders.initiating_user_id','pale_orbit_runtime','INSERT'),
        ('orders.purchase_email','pale_orbit_runtime','INSERT'),
        ('orders.currency','pale_orbit_runtime','INSERT'),
        ('orders.subtotal_minor','pale_orbit_runtime','INSERT'),
        ('orders.client_checkout_attempt_id','pale_orbit_runtime','INSERT'),
        ('orders.quote_fingerprint_sha256','pale_orbit_runtime','INSERT'),
        ('orders.status_token_sha256','pale_orbit_runtime','INSERT'),
        ('orders.status','pale_orbit_runtime','UPDATE'),
        ('orders.stripe_checkout_session_id','pale_orbit_runtime','UPDATE'),
        ('orders.checkout_expires_at','pale_orbit_runtime','UPDATE'),
        ('orders.updated_at','pale_orbit_runtime','UPDATE'),
        ('order_items.order_id','pale_orbit_runtime','INSERT'),
        ('order_items.title_id','pale_orbit_runtime','INSERT'),
        ('order_items.title_snapshot','pale_orbit_runtime','INSERT'),
        ('order_items.creator_name_snapshot','pale_orbit_runtime','INSERT'),
        ('order_items.format','pale_orbit_runtime','INSERT'),
        ('order_items.currency','pale_orbit_runtime','INSERT'),
        ('order_items.unit_subtotal_minor','pale_orbit_runtime','INSERT'),
        ('title_revisions.title_id','pale_orbit_runtime','INSERT'),
        ('title_revisions.parent_revision_id','pale_orbit_runtime','INSERT'),
        ('title_revisions.created_by_actor_id','pale_orbit_runtime','INSERT'),
        ('title_revisions.change_summary','pale_orbit_runtime','INSERT'),
        ('title_revisions.staging_storage_key','pale_orbit_runtime','INSERT'),
        ('title_revisions.staging_checksum_sha256','pale_orbit_runtime','INSERT'),
        ('title_revisions.staging_byte_size','pale_orbit_runtime','INSERT'),
        ('title_revisions.upload_filename','pale_orbit_runtime','INSERT'),
        ('title_revisions.upload_mime_type','pale_orbit_runtime','INSERT'),
        ('title_revisions.state','pale_orbit_runtime','UPDATE'),
        ('title_revisions.staging_storage_key','pale_orbit_runtime','UPDATE'),
        ('title_revisions.ingestion_generation','pale_orbit_runtime','UPDATE'),
        ('title_revisions.processing_started_at','pale_orbit_runtime','UPDATE'),
        ('title_revisions.processed_at','pale_orbit_runtime','UPDATE'),
        ('title_revisions.failure_code','pale_orbit_runtime','UPDATE'),
        ('title_revisions.failure_details','pale_orbit_runtime','UPDATE'),
        ('title_revisions.activated_at','pale_orbit_runtime','UPDATE'),
        ('title_revisions.retired_at','pale_orbit_runtime','UPDATE'),
        ('refund_allocation_drafts.id','pale_orbit_financial_worker','UPDATE'),
        ('refund_allocation_draft_items.id','pale_orbit_financial_worker','UPDATE'),
        ('refund_allocations.id','pale_orbit_financial_worker','UPDATE'),
        ('refund_allocation_components.id','pale_orbit_financial_worker','UPDATE'),
        ('refund_reporting_correction_sets.id','pale_orbit_financial_worker','UPDATE'),
        ('refund_reporting_correction_items.id','pale_orbit_financial_worker','UPDATE'),
        ('dispute_item_allocations.id','pale_orbit_financial_worker','UPDATE'),
        ('stripe_payout_balance_transactions.id','pale_orbit_financial_worker','UPDATE'),
        ('stripe_balance_transaction_fee_details.id','pale_orbit_financial_worker','UPDATE'),
        ('financial_classification_versions.id','pale_orbit_financial_worker','UPDATE'),
        ('financial_allocation_sets.id','pale_orbit_financial_worker','UPDATE'),
        ('financial_item_allocations.id','pale_orbit_financial_worker','UPDATE')
      ) expected(object_name, grantee_name, privilege_type)
    ), column_acl_delta AS (
      (SELECT * FROM actual_column_acl EXCEPT SELECT * FROM expected_column_acl)
      UNION ALL
      (SELECT * FROM expected_column_acl EXCEPT SELECT * FROM actual_column_acl)
    ), actual_routine_acl AS (
      SELECT pg_catalog.oidvectortypes(routine.proargtypes) || ':' ||
          routine.proname AS object_name,
        CASE WHEN privilege.grantee = 0 THEN 'PUBLIC'
          ELSE grantee_role.rolname::text END AS grantee_name,
        grantor_role.rolname::text AS grantor_name,
        privilege.privilege_type::text, privilege.is_grantable
      FROM pg_catalog.pg_proc routine
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
        routine.proacl, pg_catalog.acldefault('f', routine.proowner)
      )) privilege
      JOIN pg_catalog.pg_roles grantor_role ON grantor_role.oid = privilege.grantor
      LEFT JOIN pg_catalog.pg_roles grantee_role ON grantee_role.oid = privilege.grantee
      WHERE routine.oid = ANY(ARRAY[
        'public.plan6b_guard_job_insert()'::pg_catalog.regprocedure,
        'public.plan6b_guard_audit_insert()'::pg_catalog.regprocedure,
        'public.plan6b_validate_issue_transition()'::pg_catalog.regprocedure,
        'public.reject_audit_event_mutation()'::pg_catalog.regprocedure,
        'public.plan6b_validate_issue_insert()'::pg_catalog.regprocedure,
        'public.claim_guest_purchases_after_authorization(text,text)'::pg_catalog.regprocedure,
        'public.resolve_financial_issue_after_worker_recompute(uuid,text)'::pg_catalog.regprocedure
      ]::oid[])
    ), expected_routine_acl(
      object_name, grantee_name, grantor_name, privilege_type, is_grantable
    ) AS (
      SELECT pg_catalog.oidvectortypes(routine.proargtypes) || ':' || routine.proname,
        database_owner_name::text, database_owner_name::text, 'EXECUTE', false
      FROM pg_catalog.pg_proc routine
      WHERE routine.oid = ANY(ARRAY[
        'public.plan6b_guard_job_insert()'::pg_catalog.regprocedure,
        'public.plan6b_guard_audit_insert()'::pg_catalog.regprocedure,
        'public.plan6b_validate_issue_transition()'::pg_catalog.regprocedure,
        'public.reject_audit_event_mutation()'::pg_catalog.regprocedure,
        'public.plan6b_validate_issue_insert()'::pg_catalog.regprocedure,
        'public.claim_guest_purchases_after_authorization(text,text)'::pg_catalog.regprocedure,
        'public.resolve_financial_issue_after_worker_recompute(uuid,text)'::pg_catalog.regprocedure
      ]::oid[])
      UNION ALL
      SELECT expected.object_name, expected.grantee_name,
        database_owner_name::text, 'EXECUTE', false
      FROM (VALUES
        ('text, text:claim_guest_purchases_after_authorization','pale_orbit_runtime'),
        ('uuid, text:resolve_financial_issue_after_worker_recompute','pale_orbit_financial_worker')
      ) expected(object_name, grantee_name)
    ), routine_acl_delta AS (
      (SELECT * FROM actual_routine_acl EXCEPT SELECT * FROM expected_routine_acl)
      UNION ALL
      (SELECT * FROM expected_routine_acl EXCEPT SELECT * FROM actual_routine_acl)
    ), protected_acl_types(type_name) AS (
      VALUES ('job_status'::text), ('audit_actor_type'::text),
        ('audit_outcome'::text), ('financial_issue_state'::text),
        ('financial_issue_impact'::text), ('entitlement_grant_status'::text),
        ('entitlement_grant_source'::text), ('refund_allocation_source'::text),
        ('financial_allocation_source_kind'::text),
        ('financial_allocation_basis'::text), ('financial_allocation_scope'::text),
        ('financial_component'::text), ('financial_finalization_transition'::text),
        ('refund_allocation_draft_state'::text), ('refund_correction_kind'::text),
        ('refund_correction_domain'::text), ('commerce_refund_status'::text),
        ('refund_allocation_status'::text), ('commerce_payment_status'::text),
        ('commerce_order_status'::text), ('stripe_event_status'::text),
        ('revision_state'::text)
    ), actual_type_acl AS (
      SELECT type_row.typname::text AS object_name,
        CASE WHEN privilege.grantee = 0 THEN 'PUBLIC'
          ELSE grantee_role.rolname::text END AS grantee_name,
        grantor_role.rolname::text AS grantor_name,
        privilege.privilege_type::text, privilege.is_grantable
      FROM pg_catalog.pg_type type_row
      JOIN pg_catalog.pg_namespace namespace_row
        ON namespace_row.oid = type_row.typnamespace
      JOIN protected_acl_types protected ON protected.type_name = type_row.typname
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
        type_row.typacl, pg_catalog.acldefault('T', type_row.typowner)
      )) privilege
      JOIN pg_catalog.pg_roles grantor_role ON grantor_role.oid = privilege.grantor
      LEFT JOIN pg_catalog.pg_roles grantee_role ON grantee_role.oid = privilege.grantee
      WHERE namespace_row.nspname = 'public'
    ), expected_type_acl(
      object_name, grantee_name, grantor_name, privilege_type, is_grantable
    ) AS (
      SELECT protected.type_name, expected.grantee_name,
        database_owner_name::text, 'USAGE', false
      FROM protected_acl_types protected
      CROSS JOIN (VALUES (database_owner_name::text), ('PUBLIC')) expected(grantee_name)
    ), type_acl_delta AS (
      (SELECT * FROM actual_type_acl EXCEPT SELECT * FROM expected_type_acl)
      UNION ALL
      (SELECT * FROM expected_type_acl EXCEPT SELECT * FROM actual_type_acl)
    )
    SELECT 1 FROM database_acl_delta
    UNION ALL SELECT 1 FROM schema_acl_delta
    UNION ALL SELECT 1 FROM relation_acl_delta
    UNION ALL SELECT 1 FROM column_acl_delta
    UNION ALL SELECT 1 FROM routine_acl_delta
    UNION ALL SELECT 1 FROM type_acl_delta
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 6B-II prerequisite direct ACL is not canonical';
  END IF;
END;
$plan6bii_preflight$;--> statement-breakpoint
CREATE TYPE "public"."financial_admin_command_kind" AS ENUM('refund_draft_save', 'refund_draft_discard', 'refund_allocation_finalize', 'refund_reporting_correction_create', 'administrative_recovery_activate', 'administrative_recovery_deactivate');--> statement-breakpoint
CREATE TYPE "public"."financial_admin_command_status" AS ENUM('pending', 'succeeded', 'denied', 'conflict', 'failed');--> statement-breakpoint
CREATE TABLE "financial_admin_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "financial_admin_command_kind" NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"correlation_id" varchar(100) NOT NULL,
	"idempotency_key_sha256" varchar(64) NOT NULL,
	"input_fingerprint_sha256" varchar(64) NOT NULL,
	"private_input" jsonb NOT NULL,
	"job_id" uuid NOT NULL,
	"status" "financial_admin_command_status" DEFAULT 'pending' NOT NULL,
	"safe_result_code" varchar(100),
	"safe_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "financial_admin_commands_correlation_canonical" CHECK (("financial_admin_commands"."correlation_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$') is true),
	CONSTRAINT "financial_admin_commands_hashes_sha256" CHECK (("financial_admin_commands"."idempotency_key_sha256" ~ '^[a-f0-9]{64}$' and "financial_admin_commands"."input_fingerprint_sha256" ~ '^[a-f0-9]{64}$') is true),
	CONSTRAINT "financial_admin_commands_input_bounded_object" CHECK ((pg_catalog.jsonb_typeof("financial_admin_commands"."private_input") = 'object' and pg_catalog.pg_column_size("financial_admin_commands"."private_input") <= 8192) is true),
	CONSTRAINT "financial_admin_commands_result_bounded_object" CHECK (("financial_admin_commands"."safe_result" is null or (pg_catalog.jsonb_typeof("financial_admin_commands"."safe_result") = 'object' and pg_catalog.pg_column_size("financial_admin_commands"."safe_result") <= 4096)) is true),
	CONSTRAINT "financial_admin_commands_lifecycle_consistent" CHECK ((
        pg_catalog.isfinite("financial_admin_commands"."created_at")
        and pg_catalog.isfinite("financial_admin_commands"."updated_at")
        and "financial_admin_commands"."updated_at" >= "financial_admin_commands"."created_at"
        and ("financial_admin_commands"."completed_at" is null or (
          pg_catalog.isfinite("financial_admin_commands"."completed_at")
          and "financial_admin_commands"."completed_at" >= "financial_admin_commands"."updated_at"
        ))
        and ((
        "financial_admin_commands"."status" = 'pending'
        and "financial_admin_commands"."safe_result_code" is null
        and "financial_admin_commands"."safe_result" is null
        and "financial_admin_commands"."completed_at" is null
      ) or (
        "financial_admin_commands"."status" = 'succeeded'
        and "financial_admin_commands"."completed_at" is not null
        and "financial_admin_commands"."safe_result" is not null
        and case when pg_catalog.jsonb_typeof(
          "financial_admin_commands"."safe_result"
        ) = 'object' then (
          ("financial_admin_commands"."kind" = 'refund_draft_save' and
            "financial_admin_commands"."safe_result_code" = 'draft_saved' and
            "financial_admin_commands"."safe_result" ?& array['refundId', 'draftVersion', 'changed']::text[] and
            "financial_admin_commands"."safe_result" - 'refundId' - 'draftVersion' - 'changed' = '{}'::jsonb and
            pg_catalog.jsonb_typeof("financial_admin_commands"."safe_result" -> 'refundId') = 'string' and
            case when pg_catalog.pg_input_is_valid("financial_admin_commands"."safe_result" ->> 'refundId', 'uuid')
              then ("financial_admin_commands"."safe_result" ->> 'refundId')::uuid::text = "financial_admin_commands"."safe_result" ->> 'refundId'
              else false end and
            pg_catalog.jsonb_typeof("financial_admin_commands"."safe_result" -> 'draftVersion') = 'number' and
            case when pg_catalog.pg_input_is_valid("financial_admin_commands"."safe_result" ->> 'draftVersion', 'integer')
              then ("financial_admin_commands"."safe_result" ->> 'draftVersion')::integer between 1 and 2147483647
              else false end and
            pg_catalog.jsonb_typeof("financial_admin_commands"."safe_result" -> 'changed') = 'boolean')
          or ("financial_admin_commands"."kind" = 'refund_draft_discard' and
            "financial_admin_commands"."safe_result_code" = 'draft_discarded' and
            "financial_admin_commands"."safe_result" ?& array['refundId', 'draftVersion', 'changed']::text[] and
            "financial_admin_commands"."safe_result" - 'refundId' - 'draftVersion' - 'changed' = '{}'::jsonb and
            pg_catalog.jsonb_typeof("financial_admin_commands"."safe_result" -> 'refundId') = 'string' and
            case when pg_catalog.pg_input_is_valid("financial_admin_commands"."safe_result" ->> 'refundId', 'uuid')
              then ("financial_admin_commands"."safe_result" ->> 'refundId')::uuid::text = "financial_admin_commands"."safe_result" ->> 'refundId'
              else false end and
            pg_catalog.jsonb_typeof("financial_admin_commands"."safe_result" -> 'draftVersion') = 'number' and
            case when pg_catalog.pg_input_is_valid("financial_admin_commands"."safe_result" ->> 'draftVersion', 'integer')
              then ("financial_admin_commands"."safe_result" ->> 'draftVersion')::integer between 1 and 2147483647
              else false end and
            pg_catalog.jsonb_typeof("financial_admin_commands"."safe_result" -> 'changed') = 'boolean')
          or ("financial_admin_commands"."kind" = 'refund_allocation_finalize' and
            "financial_admin_commands"."safe_result_code" = 'allocation_finalized' and
            "financial_admin_commands"."safe_result" ?& array['refundId', 'finalizedDraftVersion', 'accessChanged', 'emailQueued']::text[] and
            "financial_admin_commands"."safe_result" - 'refundId' - 'finalizedDraftVersion' -
              'accessChanged' - 'emailQueued' = '{}'::jsonb and
            pg_catalog.jsonb_typeof("financial_admin_commands"."safe_result" -> 'refundId') = 'string' and
            case when pg_catalog.pg_input_is_valid("financial_admin_commands"."safe_result" ->> 'refundId', 'uuid')
              then ("financial_admin_commands"."safe_result" ->> 'refundId')::uuid::text = "financial_admin_commands"."safe_result" ->> 'refundId'
              else false end and
            pg_catalog.jsonb_typeof("financial_admin_commands"."safe_result" -> 'finalizedDraftVersion') = 'number' and
            case when pg_catalog.pg_input_is_valid("financial_admin_commands"."safe_result" ->> 'finalizedDraftVersion', 'integer')
              then ("financial_admin_commands"."safe_result" ->> 'finalizedDraftVersion')::integer between 1 and 2147483647
              else false end and
            pg_catalog.jsonb_typeof("financial_admin_commands"."safe_result" -> 'accessChanged') = 'boolean' and
            pg_catalog.jsonb_typeof("financial_admin_commands"."safe_result" -> 'emailQueued') = 'boolean')
          or ("financial_admin_commands"."kind" = 'refund_reporting_correction_create' and
            "financial_admin_commands"."safe_result_code" = 'correction_created' and
            "financial_admin_commands"."safe_result" ?& array['refundId', 'correctionSetId', 'correctionVersion']::text[] and
            "financial_admin_commands"."safe_result" - 'refundId' - 'correctionSetId' -
              'correctionVersion' = '{}'::jsonb and
            pg_catalog.jsonb_typeof("financial_admin_commands"."safe_result" -> 'refundId') = 'string' and
            case when pg_catalog.pg_input_is_valid("financial_admin_commands"."safe_result" ->> 'refundId', 'uuid')
              then ("financial_admin_commands"."safe_result" ->> 'refundId')::uuid::text = "financial_admin_commands"."safe_result" ->> 'refundId'
              else false end and
            pg_catalog.jsonb_typeof("financial_admin_commands"."safe_result" -> 'correctionSetId') = 'string' and
            case when pg_catalog.pg_input_is_valid("financial_admin_commands"."safe_result" ->> 'correctionSetId', 'uuid')
              then ("financial_admin_commands"."safe_result" ->> 'correctionSetId')::uuid::text =
                "financial_admin_commands"."safe_result" ->> 'correctionSetId'
              else false end and
            pg_catalog.jsonb_typeof("financial_admin_commands"."safe_result" -> 'correctionVersion') = 'number' and
            case when pg_catalog.pg_input_is_valid("financial_admin_commands"."safe_result" ->> 'correctionVersion', 'integer')
              then ("financial_admin_commands"."safe_result" ->> 'correctionVersion')::integer between 1 and 2147483647
              else false end)
          or ("financial_admin_commands"."kind" = 'administrative_recovery_activate' and
            "financial_admin_commands"."safe_result_code" = 'recovery_activated' and
            "financial_admin_commands"."safe_result" ?& array['recoveryGrantId', 'accessChanged', 'emailQueued']::text[] and
            "financial_admin_commands"."safe_result" - 'recoveryGrantId' - 'accessChanged' -
              'emailQueued' = '{}'::jsonb and
            pg_catalog.jsonb_typeof("financial_admin_commands"."safe_result" -> 'recoveryGrantId') = 'string' and
            case when pg_catalog.pg_input_is_valid("financial_admin_commands"."safe_result" ->> 'recoveryGrantId', 'uuid')
              then ("financial_admin_commands"."safe_result" ->> 'recoveryGrantId')::uuid::text =
                "financial_admin_commands"."safe_result" ->> 'recoveryGrantId'
              else false end and
            pg_catalog.jsonb_typeof("financial_admin_commands"."safe_result" -> 'accessChanged') = 'boolean' and
            pg_catalog.jsonb_typeof("financial_admin_commands"."safe_result" -> 'emailQueued') = 'boolean')
          or ("financial_admin_commands"."kind" = 'administrative_recovery_deactivate' and
            "financial_admin_commands"."safe_result_code" = 'recovery_deactivated' and
            "financial_admin_commands"."safe_result" ?& array['recoveryGrantId', 'accessChanged', 'emailQueued']::text[] and
            "financial_admin_commands"."safe_result" - 'recoveryGrantId' - 'accessChanged' -
              'emailQueued' = '{}'::jsonb and
            pg_catalog.jsonb_typeof("financial_admin_commands"."safe_result" -> 'recoveryGrantId') = 'string' and
            case when pg_catalog.pg_input_is_valid("financial_admin_commands"."safe_result" ->> 'recoveryGrantId', 'uuid')
              then ("financial_admin_commands"."safe_result" ->> 'recoveryGrantId')::uuid::text =
                "financial_admin_commands"."safe_result" ->> 'recoveryGrantId'
              else false end and
            pg_catalog.jsonb_typeof("financial_admin_commands"."safe_result" -> 'accessChanged') = 'boolean' and
            pg_catalog.jsonb_typeof("financial_admin_commands"."safe_result" -> 'emailQueued') = 'boolean')
        ) else false end
      ) or (
        "financial_admin_commands"."status" = 'denied'
        and "financial_admin_commands"."safe_result_code" = 'capability_revoked'
        and "financial_admin_commands"."safe_result" is null
        and "financial_admin_commands"."completed_at" is not null
      ) or (
        "financial_admin_commands"."status" = 'conflict'
        and "financial_admin_commands"."safe_result_code" in ('stale_state', 'not_eligible')
        and "financial_admin_commands"."safe_result" is null
        and "financial_admin_commands"."completed_at" is not null
      ) or (
        "financial_admin_commands"."status" = 'failed'
        and "financial_admin_commands"."safe_result_code" in ('invalid_command', 'command_failed')
        and "financial_admin_commands"."safe_result" is null
        and "financial_admin_commands"."completed_at" is not null
      )
      )) is true)
);
--> statement-breakpoint
DO $plan6bii_input_constraint$
DECLARE
  item_index integer;
  other_index integer;
  item_predicate text := $items$
    CASE WHEN pg_catalog.jsonb_typeof(private_input -> 'items') = 'array' THEN (
      pg_catalog.jsonb_array_length(private_input -> 'items') BETWEEN 1 AND 25
  $items$;
  input_predicate text;
BEGIN
  FOR item_index IN 0..24 LOOP
    item_predicate := item_predicate || pg_catalog.format($item$
      AND (
        pg_catalog.jsonb_array_length(private_input -> 'items') <= %1$s OR
        CASE WHEN pg_catalog.jsonb_typeof(
          private_input -> 'items' -> %1$s
        ) = 'object' THEN (
          (private_input -> 'items' -> %1$s) ?&
            ARRAY['orderItemId','totalPresentmentMinor']::text[] AND
          (private_input -> 'items' -> %1$s) -
            ARRAY['orderItemId','totalPresentmentMinor']::text[] = '{}'::jsonb AND
          pg_catalog.jsonb_typeof(
            private_input -> 'items' -> %1$s -> 'orderItemId'
          ) = 'string' AND
          CASE WHEN pg_catalog.pg_input_is_valid(
              private_input -> 'items' -> %1$s ->> 'orderItemId', 'uuid'
            ) THEN (private_input -> 'items' -> %1$s ->> 'orderItemId')::uuid::text =
              private_input -> 'items' -> %1$s ->> 'orderItemId'
            ELSE false END AND
          pg_catalog.jsonb_typeof(
            private_input -> 'items' -> %1$s -> 'totalPresentmentMinor'
          ) = 'number' AND
          CASE WHEN pg_catalog.pg_input_is_valid(
              private_input -> 'items' -> %1$s ->> 'totalPresentmentMinor', 'integer'
            ) THEN (private_input -> 'items' -> %1$s ->> 'totalPresentmentMinor')::integer
              BETWEEN 0 AND 99999999
            ELSE false END
        ) ELSE false END
      )
    $item$, item_index);
    FOR other_index IN (item_index + 1)..24 LOOP
      item_predicate := item_predicate || pg_catalog.format($unique$
        AND (
          pg_catalog.jsonb_array_length(private_input -> 'items') <= %2$s OR
          private_input -> 'items' -> %1$s ->> 'orderItemId' IS DISTINCT FROM
            private_input -> 'items' -> %2$s ->> 'orderItemId'
        )
      $unique$, item_index, other_index);
    END LOOP;
  END LOOP;
  item_predicate := item_predicate || ') ELSE false END';

  input_predicate := pg_catalog.format($input$
    (CASE WHEN pg_catalog.jsonb_typeof(private_input) = 'object' THEN ((
      kind = 'refund_draft_save' AND
      private_input ?& ARRAY['kind','refundId','expectedVersion','items']::text[] AND
      private_input - ARRAY['kind','refundId','expectedVersion','items']::text[] =
        '{}'::jsonb AND
      pg_catalog.jsonb_typeof(private_input -> 'kind') = 'string' AND
      private_input ->> 'kind' = 'refund_draft_save' AND
      pg_catalog.jsonb_typeof(private_input -> 'refundId') = 'string' AND
      CASE WHEN pg_catalog.pg_input_is_valid(private_input ->> 'refundId', 'uuid')
        THEN (private_input ->> 'refundId')::uuid::text = private_input ->> 'refundId'
        ELSE false END AND
      (
        pg_catalog.jsonb_typeof(private_input -> 'expectedVersion') = 'null' OR (
          pg_catalog.jsonb_typeof(private_input -> 'expectedVersion') = 'number' AND
          CASE WHEN pg_catalog.pg_input_is_valid(
              private_input ->> 'expectedVersion', 'integer'
            ) THEN (private_input ->> 'expectedVersion')::integer
              BETWEEN 1 AND 2147483647
            ELSE false END
        )
      ) AND
      (%1$s)
    ) OR (
      kind = 'refund_draft_discard' AND
      private_input ?&
        ARRAY['kind','refundId','expectedActiveDraftVersion']::text[] AND
      private_input -
        ARRAY['kind','refundId','expectedActiveDraftVersion']::text[] = '{}'::jsonb AND
      pg_catalog.jsonb_typeof(private_input -> 'kind') = 'string' AND
      private_input ->> 'kind' = 'refund_draft_discard' AND
      pg_catalog.jsonb_typeof(private_input -> 'refundId') = 'string' AND
      CASE WHEN pg_catalog.pg_input_is_valid(private_input ->> 'refundId', 'uuid')
        THEN (private_input ->> 'refundId')::uuid::text = private_input ->> 'refundId'
        ELSE false END AND
      pg_catalog.jsonb_typeof(private_input -> 'expectedActiveDraftVersion') = 'number' AND
      CASE WHEN pg_catalog.pg_input_is_valid(
          private_input ->> 'expectedActiveDraftVersion', 'integer'
        ) THEN (private_input ->> 'expectedActiveDraftVersion')::integer
          BETWEEN 1 AND 2147483647
        ELSE false END
    ) OR (
      kind = 'refund_allocation_finalize' AND
      private_input ?& ARRAY[
        'kind','refundId','expectedActiveDraftVersion','previewFingerprint','confirmation'
      ]::text[] AND
      private_input - ARRAY[
        'kind','refundId','expectedActiveDraftVersion','previewFingerprint','confirmation'
      ]::text[] = '{}'::jsonb AND
      pg_catalog.jsonb_typeof(private_input -> 'kind') = 'string' AND
      private_input ->> 'kind' = 'refund_allocation_finalize' AND
      pg_catalog.jsonb_typeof(private_input -> 'refundId') = 'string' AND
      CASE WHEN pg_catalog.pg_input_is_valid(private_input ->> 'refundId', 'uuid')
        THEN (private_input ->> 'refundId')::uuid::text = private_input ->> 'refundId'
        ELSE false END AND
      pg_catalog.jsonb_typeof(private_input -> 'expectedActiveDraftVersion') = 'number' AND
      CASE WHEN pg_catalog.pg_input_is_valid(
          private_input ->> 'expectedActiveDraftVersion', 'integer'
        ) THEN (private_input ->> 'expectedActiveDraftVersion')::integer
          BETWEEN 1 AND 2147483647
        ELSE false END AND
      pg_catalog.jsonb_typeof(private_input -> 'previewFingerprint') = 'string' AND
      private_input ->> 'previewFingerprint' ~ '^[a-f0-9]{64}$' AND
      pg_catalog.jsonb_typeof(private_input -> 'confirmation') = 'string' AND
      private_input ->> 'confirmation' = 'finalize_refund_allocation'
    ) OR (
      kind = 'refund_reporting_correction_create' AND
      private_input ?& ARRAY[
        'kind','refundId','reason','expectedNextCorrectionVersion',
        'expectedBaseAllocationSetId','expectedSourceFingerprint','items',
        'previewFingerprint','confirmation'
      ]::text[] AND
      private_input - ARRAY[
        'kind','refundId','reason','expectedNextCorrectionVersion',
        'expectedBaseAllocationSetId','expectedSourceFingerprint','items',
        'previewFingerprint','confirmation'
      ]::text[] = '{}'::jsonb AND
      pg_catalog.jsonb_typeof(private_input -> 'kind') = 'string' AND
      private_input ->> 'kind' = 'refund_reporting_correction_create' AND
      pg_catalog.jsonb_typeof(private_input -> 'refundId') = 'string' AND
      CASE WHEN pg_catalog.pg_input_is_valid(private_input ->> 'refundId', 'uuid')
        THEN (private_input ->> 'refundId')::uuid::text = private_input ->> 'refundId'
        ELSE false END AND
      pg_catalog.jsonb_typeof(private_input -> 'reason') = 'string' AND
      private_input ->> 'reason' = 'allocation_attribution_correction' AND
      pg_catalog.jsonb_typeof(private_input -> 'expectedNextCorrectionVersion') = 'number' AND
      CASE WHEN pg_catalog.pg_input_is_valid(
          private_input ->> 'expectedNextCorrectionVersion', 'integer'
        ) THEN (private_input ->> 'expectedNextCorrectionVersion')::integer
          BETWEEN 1 AND 2147483647
        ELSE false END AND
      pg_catalog.jsonb_typeof(private_input -> 'expectedBaseAllocationSetId') = 'string' AND
      CASE WHEN pg_catalog.pg_input_is_valid(
          private_input ->> 'expectedBaseAllocationSetId', 'uuid'
        ) THEN (private_input ->> 'expectedBaseAllocationSetId')::uuid::text =
          private_input ->> 'expectedBaseAllocationSetId'
        ELSE false END AND
      pg_catalog.jsonb_typeof(private_input -> 'expectedSourceFingerprint') = 'string' AND
      private_input ->> 'expectedSourceFingerprint' ~ '^[a-f0-9]{64}$' AND
      (%2$s) AND
      pg_catalog.jsonb_typeof(private_input -> 'previewFingerprint') = 'string' AND
      private_input ->> 'previewFingerprint' ~ '^[a-f0-9]{64}$' AND
      pg_catalog.jsonb_typeof(private_input -> 'confirmation') = 'string' AND
      private_input ->> 'confirmation' = 'create_reporting_correction'
    ) OR (
      kind = 'administrative_recovery_activate' AND
      private_input ?& ARRAY[
        'kind','refundId','finalizationEffectId','orderItemId',
        'expectedCorrectionSetId','expectedCorrectionVersion',
        'expectedSourceFingerprint','previewFingerprint','confirmation'
      ]::text[] AND
      private_input - ARRAY[
        'kind','refundId','finalizationEffectId','orderItemId',
        'expectedCorrectionSetId','expectedCorrectionVersion',
        'expectedSourceFingerprint','previewFingerprint','confirmation'
      ]::text[] = '{}'::jsonb AND
      pg_catalog.jsonb_typeof(private_input -> 'kind') = 'string' AND
      private_input ->> 'kind' = 'administrative_recovery_activate' AND
      pg_catalog.jsonb_typeof(private_input -> 'refundId') = 'string' AND
      CASE WHEN pg_catalog.pg_input_is_valid(private_input ->> 'refundId', 'uuid')
        THEN (private_input ->> 'refundId')::uuid::text = private_input ->> 'refundId'
        ELSE false END AND
      pg_catalog.jsonb_typeof(private_input -> 'finalizationEffectId') = 'string' AND
      CASE WHEN pg_catalog.pg_input_is_valid(
          private_input ->> 'finalizationEffectId', 'uuid'
        ) THEN (private_input ->> 'finalizationEffectId')::uuid::text =
          private_input ->> 'finalizationEffectId'
        ELSE false END AND
      pg_catalog.jsonb_typeof(private_input -> 'orderItemId') = 'string' AND
      CASE WHEN pg_catalog.pg_input_is_valid(private_input ->> 'orderItemId', 'uuid')
        THEN (private_input ->> 'orderItemId')::uuid::text = private_input ->> 'orderItemId'
        ELSE false END AND
      pg_catalog.jsonb_typeof(private_input -> 'expectedCorrectionSetId') = 'string' AND
      CASE WHEN pg_catalog.pg_input_is_valid(
          private_input ->> 'expectedCorrectionSetId', 'uuid'
        ) THEN (private_input ->> 'expectedCorrectionSetId')::uuid::text =
          private_input ->> 'expectedCorrectionSetId'
        ELSE false END AND
      pg_catalog.jsonb_typeof(private_input -> 'expectedCorrectionVersion') = 'number' AND
      CASE WHEN pg_catalog.pg_input_is_valid(
          private_input ->> 'expectedCorrectionVersion', 'integer'
        ) THEN (private_input ->> 'expectedCorrectionVersion')::integer
          BETWEEN 1 AND 2147483647
        ELSE false END AND
      pg_catalog.jsonb_typeof(private_input -> 'expectedSourceFingerprint') = 'string' AND
      private_input ->> 'expectedSourceFingerprint' ~ '^[a-f0-9]{64}$' AND
      pg_catalog.jsonb_typeof(private_input -> 'previewFingerprint') = 'string' AND
      private_input ->> 'previewFingerprint' ~ '^[a-f0-9]{64}$' AND
      pg_catalog.jsonb_typeof(private_input -> 'confirmation') = 'string' AND
      private_input ->> 'confirmation' = 'activate_persistent_recovery'
    ) OR (
      kind = 'administrative_recovery_deactivate' AND
      private_input ?& ARRAY[
        'kind','recoveryGrantId','recoveryReferenceId','expectedStateChangedAt','confirmation'
      ]::text[] AND
      private_input - ARRAY[
        'kind','recoveryGrantId','recoveryReferenceId','expectedStateChangedAt','confirmation'
      ]::text[] = '{}'::jsonb AND
      pg_catalog.jsonb_typeof(private_input -> 'kind') = 'string' AND
      private_input ->> 'kind' = 'administrative_recovery_deactivate' AND
      pg_catalog.jsonb_typeof(private_input -> 'recoveryGrantId') = 'string' AND
      CASE WHEN pg_catalog.pg_input_is_valid(private_input ->> 'recoveryGrantId', 'uuid')
        THEN (private_input ->> 'recoveryGrantId')::uuid::text =
          private_input ->> 'recoveryGrantId'
        ELSE false END AND
      pg_catalog.jsonb_typeof(private_input -> 'recoveryReferenceId') = 'string' AND
      CASE WHEN pg_catalog.pg_input_is_valid(
          private_input ->> 'recoveryReferenceId', 'uuid'
        ) THEN (private_input ->> 'recoveryReferenceId')::uuid::text =
          private_input ->> 'recoveryReferenceId'
        ELSE false END AND
      pg_catalog.jsonb_typeof(private_input -> 'expectedStateChangedAt') = 'string' AND
      private_input ->> 'expectedStateChangedAt' ~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' AND
      CASE WHEN pg_catalog.pg_input_is_valid(
          private_input ->> 'expectedStateChangedAt', 'timestamp with time zone'
        ) THEN pg_catalog.to_char(
          pg_catalog.timezone(
            'UTC', (private_input ->> 'expectedStateChangedAt')::timestamptz
          ),
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) = private_input ->> 'expectedStateChangedAt'
        ELSE false END AND
      pg_catalog.jsonb_typeof(private_input -> 'confirmation') = 'string' AND
      private_input ->> 'confirmation' = 'deactivate_persistent_recovery'
    )) ELSE false END) IS TRUE
  $input$, item_predicate, item_predicate);

  EXECUTE 'ALTER TABLE "public"."financial_admin_commands" ADD CONSTRAINT ' ||
    '"financial_admin_commands_input_kind_consistent" CHECK (' ||
    input_predicate || ')';
END;
$plan6bii_input_constraint$;--> statement-breakpoint
CREATE TABLE "financial_admin_job_claims" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"generation" integer NOT NULL,
	"attempt" integer NOT NULL,
	"capability_sha256" text NOT NULL,
	"lease_duration_ms" integer NOT NULL,
	"state" varchar(16) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"renewed_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	CONSTRAINT "financial_admin_job_claims_generation_positive" CHECK (("financial_admin_job_claims"."generation" between 1 and 2147483647) is true),
	CONSTRAINT "financial_admin_job_claims_attempt_positive" CHECK (("financial_admin_job_claims"."attempt" between 1 and 2147483647) is true),
	CONSTRAINT "financial_admin_job_claims_capability_sha256_valid" CHECK (("financial_admin_job_claims"."capability_sha256" ~ '^[a-f0-9]{64}$') is true),
	CONSTRAINT "financial_admin_job_claims_lease_duration_bounded" CHECK (("financial_admin_job_claims"."lease_duration_ms" between 1 and 86400000) is true),
	CONSTRAINT "financial_admin_job_claims_lifecycle_consistent" CHECK (((
        "financial_admin_job_claims"."state" = 'active'
        and "financial_admin_job_claims"."invalidated_at" is null
        and ("financial_admin_job_claims"."renewed_at" is null or "financial_admin_job_claims"."renewed_at" >= "financial_admin_job_claims"."issued_at")
        and "financial_admin_job_claims"."expires_at" > COALESCE("financial_admin_job_claims"."renewed_at", "financial_admin_job_claims"."issued_at")
      ) or (
        "financial_admin_job_claims"."state" = 'invalidated'
        and "financial_admin_job_claims"."invalidated_at" is not null
        and ("financial_admin_job_claims"."renewed_at" is null or "financial_admin_job_claims"."renewed_at" >= "financial_admin_job_claims"."issued_at")
        and "financial_admin_job_claims"."invalidated_at" >= COALESCE("financial_admin_job_claims"."renewed_at", "financial_admin_job_claims"."issued_at")
      )) is true)
);
--> statement-breakpoint
REVOKE ALL ON TABLE "public"."financial_admin_commands", "public"."financial_admin_job_claims" FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
ALTER TABLE "financial_admin_commands" ADD CONSTRAINT "financial_admin_commands_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_admin_job_claims" ADD CONSTRAINT "financial_admin_job_claims_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "financial_admin_commands" ADD CONSTRAINT "financial_admin_commands_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE restrict DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
CREATE UNIQUE INDEX "financial_admin_commands_actor_idempotency_unique" ON "financial_admin_commands" USING btree ("actor_user_id","idempotency_key_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_admin_commands_job_unique" ON "financial_admin_commands" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "financial_admin_commands_status_created_idx" ON "financial_admin_commands" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE FUNCTION "public"."plan6bii_assert_financial_admin_job_lease"(uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $financial_admin_lease_assertion$
DECLARE
  requested_job_id uuid := $1;
  supplied_capability text;
  supplied_digest text;
  authority_count integer;
BEGIN
  supplied_capability := pg_catalog.current_setting(
    'pale_orbit.plan6bii_financial_admin_job_capability', true
  );
  IF requested_job_id IS NULL OR supplied_capability IS NULL OR
    supplied_capability !~ '^[A-Za-z0-9_-]{43}$' THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'financial administrator job lease authority is not current';
  END IF;

  supplied_digest := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(supplied_capability, 'UTF8')),
    'hex'
  );
  SELECT pg_catalog.count(*)::integer
  INTO authority_count
  FROM "public"."financial_admin_job_claims" claim
  JOIN "public"."jobs" job ON job.id = claim.job_id
  JOIN "public"."financial_admin_commands" command ON command.job_id = job.id
  WHERE claim.job_id = requested_job_id
    AND claim.capability_sha256 = supplied_digest
    AND claim.generation BETWEEN 1 AND 2147483647
    AND claim.attempt BETWEEN 1 AND 2147483647
    AND claim.state = 'active'
    AND claim.invalidated_at IS NULL
    AND claim.expires_at > pg_catalog.clock_timestamp()
    AND job.type = 'commerce.financial-admin-command'
    AND job.status = 'running'
    AND job.attempts = claim.attempt
    AND job.locked_at IS NOT NULL
    AND job.locked_by IS NOT NULL
    AND job.payload IS NOT DISTINCT FROM
      pg_catalog.jsonb_build_object('commandId', command.id)
    AND job.deduplication_key IS NOT DISTINCT FROM
      'commerce:financial-admin-command:' || command.id::text || ':v1'
    AND job.max_attempts = 8;
  IF authority_count IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'financial administrator job lease authority is not current';
  END IF;
END;
$financial_admin_lease_assertion$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."plan6bii_assert_financial_admin_job_lease"(uuid) FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
CREATE FUNCTION "public"."plan6bii_guard_financial_admin_job_lease"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $financial_admin_lease_guard$
DECLARE
  supplied_capability text;
  supplied_duration_text text;
  supplied_duration integer;
  supplied_digest text;
  lease_now timestamptz;
  lease_expires_at timestamptz;
  prior_claim "public"."financial_admin_job_claims"%ROWTYPE;
  prior_claim_exists boolean;
  linked_command "public"."financial_admin_commands"%ROWTYPE;
BEGIN
  IF OLD.type IS DISTINCT FROM 'commerce.financial-admin-command' AND
    NEW.type IS DISTINCT FROM 'commerce.financial-admin-command' THEN
    RETURN NEW;
  END IF;
  IF OLD.type IS DISTINCT FROM 'commerce.financial-admin-command' OR
    NEW.type IS DISTINCT FROM 'commerce.financial-admin-command' OR
    NEW.id IS DISTINCT FROM OLD.id OR NEW.type IS DISTINCT FROM OLD.type OR
    NEW.payload IS DISTINCT FROM OLD.payload OR
    NEW.deduplication_key IS DISTINCT FROM OLD.deduplication_key OR
    NEW.max_attempts IS DISTINCT FROM OLD.max_attempts OR
    NEW.created_at IS DISTINCT FROM OLD.created_at OR
    NEW.max_attempts <> 8 OR
    pg_catalog.jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object' OR
    NOT (NEW.payload ?& ARRAY['commandId']::text[]) OR
    NEW.payload - 'commandId' IS DISTINCT FROM '{}'::jsonb OR
    pg_catalog.jsonb_typeof(NEW.payload -> 'commandId') IS DISTINCT FROM 'string' OR
    NOT pg_catalog.pg_input_is_valid(NEW.payload ->> 'commandId', 'uuid') OR
    NEW.deduplication_key IS DISTINCT FROM
      'commerce:financial-admin-command:' || (NEW.payload ->> 'commandId') || ':v1' THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'invalid financial administrator job transition';
  END IF;

  supplied_capability := pg_catalog.current_setting(
    'pale_orbit.plan6bii_financial_admin_job_capability', true
  );
  IF supplied_capability IS NULL OR
    supplied_capability !~ '^[A-Za-z0-9_-]{43}$' THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'financial administrator job lease authority is not current';
  END IF;
  supplied_digest := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(supplied_capability, 'UTF8')),
    'hex'
  );
  lease_now := pg_catalog.clock_timestamp();

  IF OLD.status = 'pending' AND NEW.status = 'running' THEN
    supplied_duration_text := pg_catalog.current_setting(
      'pale_orbit.plan6bii_financial_admin_job_lease_duration_ms', true
    );
    IF supplied_duration_text IS NULL OR
      supplied_duration_text !~ '^[1-9][0-9]{0,7}$' OR
      NOT pg_catalog.pg_input_is_valid(supplied_duration_text, 'integer') THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'financial administrator job lease authority is not current';
    END IF;
    supplied_duration := supplied_duration_text::integer;
    IF supplied_duration NOT BETWEEN 1 AND 86400000 OR
      NEW.attempts NOT BETWEEN 1 AND NEW.max_attempts OR
      NEW.locked_at IS NULL OR NEW.locked_by IS NULL OR
      NEW.completed_at IS NOT NULL OR NEW.rerun_requested_at IS NOT NULL OR
      NEW.attempts IS DISTINCT FROM OLD.attempts + 1 THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'invalid financial administrator job transition';
    END IF;
    lease_expires_at := lease_now +
      (supplied_duration::double precision * interval '1 millisecond');
    NEW.locked_at := lease_now;
    NEW.updated_at := lease_now;
    NEW.run_at := lease_expires_at;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'pale-orbit:plan6bii-financial-admin-job-lease:' || NEW.id::text, 0
    ));
    SELECT * INTO prior_claim
    FROM "public"."financial_admin_job_claims" claim
    WHERE claim.job_id = NEW.id
    FOR UPDATE;
    prior_claim_exists := FOUND;
    IF prior_claim_exists AND (
      prior_claim.state <> 'active' OR
      prior_claim.expires_at > lease_now OR
      prior_claim.generation >= 2147483647 OR
      prior_claim.capability_sha256 = supplied_digest
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'financial administrator job lease authority is not current';
    END IF;
    SELECT * INTO linked_command
    FROM "public"."financial_admin_commands" command
    WHERE command.job_id = NEW.id
      AND command.id::text = NEW.payload ->> 'commandId';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'invalid financial administrator job transition';
    END IF;
    IF prior_claim_exists THEN
      UPDATE "public"."financial_admin_job_claims"
      SET generation = prior_claim.generation + 1,
        attempt = NEW.attempts,
        capability_sha256 = supplied_digest,
        lease_duration_ms = supplied_duration,
        state = 'active',
        expires_at = lease_expires_at,
        issued_at = lease_now,
        renewed_at = NULL,
        invalidated_at = NULL
      WHERE job_id = NEW.id;
    ELSE
      INSERT INTO "public"."financial_admin_job_claims" (
        job_id, generation, attempt, capability_sha256, lease_duration_ms,
        state, expires_at, issued_at, renewed_at, invalidated_at
      ) VALUES (
        NEW.id, 1, NEW.attempts, supplied_digest, supplied_duration,
        'active',
        lease_expires_at,
        lease_now, NULL, NULL
      );
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'running' AND NEW.status = 'running' THEN
    supplied_duration_text := pg_catalog.current_setting(
      'pale_orbit.plan6bii_financial_admin_job_lease_duration_ms', true
    );
    IF supplied_duration_text IS NULL OR supplied_duration_text = '' THEN
      PERFORM pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(
        'pale-orbit:plan6bii-financial-admin-job-lease:' || NEW.id::text, 0
      ));
      SELECT * INTO prior_claim
      FROM "public"."financial_admin_job_claims" claim
      WHERE claim.job_id = NEW.id
      FOR UPDATE;
      IF NOT FOUND OR prior_claim.expires_at <= lease_now OR
        prior_claim.state <> 'active' OR
        prior_claim.attempt IS DISTINCT FROM OLD.attempts OR
        prior_claim.capability_sha256 <> supplied_digest OR
        NEW.attempts IS DISTINCT FROM OLD.attempts OR
        NEW.locked_by IS DISTINCT FROM OLD.locked_by OR
        NEW.status IS DISTINCT FROM OLD.status OR
        NEW.run_at IS DISTINCT FROM OLD.run_at OR
        NEW.last_error IS DISTINCT FROM OLD.last_error OR
        NEW.rerun_requested_at IS DISTINCT FROM OLD.rerun_requested_at OR
        NEW.completed_at IS DISTINCT FROM OLD.completed_at OR
        NEW.locked_at IS NULL OR NEW.locked_at < OLD.locked_at OR
        NEW.updated_at < OLD.updated_at THEN
        RAISE EXCEPTION USING ERRCODE = '55000',
          MESSAGE = 'invalid financial administrator job transition';
      END IF;
      lease_expires_at := lease_now +
        (prior_claim.lease_duration_ms::double precision * interval '1 millisecond');
      NEW.locked_at := lease_now;
      NEW.updated_at := lease_now;
      NEW.run_at := lease_expires_at;
      UPDATE "public"."financial_admin_job_claims"
      SET renewed_at = lease_now,
        expires_at = lease_expires_at
      WHERE job_id = NEW.id AND generation = prior_claim.generation
        AND attempt = prior_claim.attempt AND state = 'active';
      RETURN NEW;
    END IF;

    IF supplied_duration_text !~ '^[1-9][0-9]{0,7}$' OR
      NOT pg_catalog.pg_input_is_valid(supplied_duration_text, 'integer') THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'financial administrator job lease authority is not current';
    END IF;
    supplied_duration := supplied_duration_text::integer;
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'pale-orbit:plan6bii-financial-admin-job-lease:' || NEW.id::text, 0
    ));
    SELECT * INTO prior_claim
    FROM "public"."financial_admin_job_claims" claim
    WHERE claim.job_id = NEW.id
    FOR UPDATE;
    IF NOT FOUND OR prior_claim.expires_at > lease_now OR
      prior_claim.state <> 'active' OR
      prior_claim.attempt IS DISTINCT FROM OLD.attempts OR
      prior_claim.capability_sha256 = supplied_digest OR
      prior_claim.generation >= 2147483647 OR
      supplied_duration NOT BETWEEN 1 AND 86400000 OR
      NEW.attempts NOT BETWEEN 1 AND NEW.max_attempts OR
      NOT (
        (OLD.rerun_requested_at IS NULL AND
          (
            (OLD.attempts < OLD.max_attempts AND
              NEW.attempts = OLD.attempts + 1) OR
            (OLD.attempts = OLD.max_attempts AND
              NEW.attempts = OLD.attempts)
          ) AND
          NEW.last_error IS NOT DISTINCT FROM OLD.last_error) OR
        (OLD.rerun_requested_at IS NOT NULL AND
          OLD.attempts BETWEEN 1 AND OLD.max_attempts AND
          NEW.attempts = 1 AND NEW.last_error IS NULL)
      ) OR
      NEW.locked_at IS NULL OR NEW.locked_by IS NULL OR
      NEW.locked_at < OLD.locked_at OR
      NEW.run_at IS DISTINCT FROM OLD.run_at OR
      NEW.completed_at IS NOT NULL OR NEW.rerun_requested_at IS NOT NULL OR
      NEW.updated_at < OLD.updated_at THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'invalid financial administrator job transition';
    END IF;
    lease_expires_at := lease_now +
      (supplied_duration::double precision * interval '1 millisecond');
    NEW.locked_at := lease_now;
    NEW.updated_at := lease_now;
    NEW.run_at := lease_expires_at;
    SELECT * INTO linked_command
    FROM "public"."financial_admin_commands" command
    WHERE command.job_id = NEW.id
      AND command.id::text = NEW.payload ->> 'commandId';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'invalid financial administrator job transition';
    END IF;
    UPDATE "public"."financial_admin_job_claims"
    SET generation = prior_claim.generation + 1,
      attempt = NEW.attempts,
      capability_sha256 = supplied_digest,
      lease_duration_ms = supplied_duration,
      state = 'active',
      expires_at = lease_expires_at,
      issued_at = lease_now,
      renewed_at = NULL,
      invalidated_at = NULL
    WHERE job_id = NEW.id AND generation = prior_claim.generation
      AND state = 'active';
    RETURN NEW;
  END IF;

  IF OLD.status = 'running' AND NEW.status = 'pending' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'pale-orbit:plan6bii-financial-admin-job-lease:' || NEW.id::text, 0
    ));
    PERFORM "public"."plan6bii_assert_financial_admin_job_lease"(NEW.id);
    IF NEW.locked_at IS NOT NULL OR NEW.locked_by IS NOT NULL OR
      NEW.completed_at IS NOT NULL OR NEW.rerun_requested_at IS NOT NULL OR
      NOT (
        (OLD.rerun_requested_at IS NOT NULL AND NEW.attempts = 0 AND
          NEW.last_error IS NULL) OR
        (OLD.rerun_requested_at IS NULL AND NEW.attempts = OLD.attempts AND
          NEW.last_error IS NOT NULL AND NEW.run_at > lease_now AND
          NEW.run_at <= lease_now + interval '1 day')
      ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'invalid financial administrator job transition';
    END IF;
    IF OLD.rerun_requested_at IS NOT NULL THEN
      NEW.run_at := lease_now;
    END IF;
    NEW.updated_at := lease_now;
    UPDATE "public"."financial_admin_job_claims"
    SET expires_at = lease_now
    WHERE job_id = NEW.id AND state = 'active';
    RETURN NEW;
  END IF;

  IF OLD.status = 'running' AND NEW.status IN ('succeeded', 'failed') THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'pale-orbit:plan6bii-financial-admin-job-lease:' || NEW.id::text, 0
    ));
    PERFORM "public"."plan6bii_assert_financial_admin_job_lease"(NEW.id);
    IF NEW.locked_at IS NOT NULL OR NEW.locked_by IS NOT NULL OR
      NEW.completed_at IS NULL OR NEW.rerun_requested_at IS NOT NULL OR
      NEW.attempts IS DISTINCT FROM OLD.attempts OR
      NEW.run_at IS DISTINCT FROM OLD.run_at OR
      NOT (
        (NEW.status = 'succeeded' AND NEW.last_error IS NULL) OR
        (NEW.status = 'failed' AND NEW.last_error IS NOT NULL)
      ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'invalid financial administrator job transition';
    END IF;
    NEW.completed_at := lease_now;
    NEW.updated_at := lease_now;
    UPDATE "public"."financial_admin_job_claims"
    SET state = 'invalidated', invalidated_at = lease_now
    WHERE job_id = NEW.id AND state = 'active';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'financial administrator job lease authority is not current';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING ERRCODE = '55000',
    MESSAGE = 'invalid financial administrator job transition';
END;
$financial_admin_lease_guard$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."plan6bii_guard_financial_admin_job_lease"() FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
CREATE TRIGGER "jobs_plan6bii_financial_admin_lease_guard"
BEFORE UPDATE ON "public"."jobs"
FOR EACH ROW EXECUTE FUNCTION "public"."plan6bii_guard_financial_admin_job_lease"();--> statement-breakpoint
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
REVOKE ALL ON FUNCTION "public"."plan6b_guard_job_insert"() FROM PUBLIC, "pale_orbit_runtime";--> statement-breakpoint
CREATE FUNCTION "public"."submit_financial_admin_command"(uuid,text,text,text,text,jsonb)
RETURNS TABLE (
  command_id uuid,
  command_kind "public"."financial_admin_command_kind",
  command_status "public"."financial_admin_command_status",
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $submit_financial_admin_command$
DECLARE
  requested_actor uuid := $1;
  requested_correlation text := $2;
  requested_kind text := $3;
  requested_idempotency_hash text := $4;
  requested_fingerprint text := $5;
  requested_input jsonb := $6;
  command_uuid uuid;
  job_uuid uuid;
  command_row "public"."financial_admin_commands"%ROWTYPE;
  valid_input boolean := false;
BEGIN
  IF NOT (
    pg_catalog.pg_has_role(session_user, 'pale_orbit_runtime', 'MEMBER')
    AND NOT pg_catalog.pg_has_role(session_user, 'pale_orbit_financial_worker', 'MEMBER')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'financial administrator command submission is not permitted';
  END IF;
  IF requested_actor IS NULL OR requested_correlation IS NULL OR
    requested_correlation !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$' OR
    requested_kind NOT IN (
      'refund_draft_save', 'refund_draft_discard',
      'refund_allocation_finalize', 'refund_reporting_correction_create',
      'administrative_recovery_activate', 'administrative_recovery_deactivate'
    ) OR requested_idempotency_hash IS NULL OR
    requested_idempotency_hash !~ '^[a-f0-9]{64}$' OR
    requested_fingerprint IS NULL OR requested_fingerprint !~ '^[a-f0-9]{64}$' OR
    pg_catalog.jsonb_typeof(requested_input) IS DISTINCT FROM 'object' OR
    pg_catalog.pg_column_size(requested_input) > 8192 THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid financial administrator command';
  END IF;

  IF requested_kind = 'refund_draft_save' THEN
    SELECT (
      requested_input ?& ARRAY['kind','refundId','expectedVersion','items']::text[] AND
      requested_input - 'kind' - 'refundId' - 'expectedVersion' - 'items' = '{}'::jsonb AND
      requested_input ->> 'kind' = requested_kind AND
      pg_catalog.jsonb_typeof(requested_input -> 'kind') = 'string' AND
      pg_catalog.jsonb_typeof(requested_input -> 'refundId') = 'string' AND
      pg_catalog.pg_input_is_valid(requested_input ->> 'refundId', 'uuid') AND
      CASE WHEN pg_catalog.pg_input_is_valid(requested_input ->> 'refundId', 'uuid')
        THEN (requested_input ->> 'refundId')::uuid::text = requested_input ->> 'refundId'
        ELSE false END AND
      (
        pg_catalog.jsonb_typeof(requested_input -> 'expectedVersion') = 'null' OR
        (
          pg_catalog.jsonb_typeof(requested_input -> 'expectedVersion') = 'number' AND
          CASE WHEN pg_catalog.pg_input_is_valid(
              requested_input ->> 'expectedVersion', 'integer'
            ) THEN (requested_input ->> 'expectedVersion')::integer BETWEEN 1 AND 2147483647
            ELSE false END
        )
      ) AND
      CASE WHEN pg_catalog.jsonb_typeof(requested_input -> 'items') = 'array' THEN (
        pg_catalog.jsonb_array_length(requested_input -> 'items') BETWEEN 1 AND 25 AND
        NOT EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements(requested_input -> 'items') item(value)
          WHERE NOT ((CASE WHEN pg_catalog.jsonb_typeof(item.value) = 'object' THEN (
            item.value ?& ARRAY['orderItemId','totalPresentmentMinor']::text[] AND
            item.value - 'orderItemId' - 'totalPresentmentMinor' = '{}'::jsonb AND
            pg_catalog.jsonb_typeof(item.value -> 'orderItemId') = 'string' AND
            CASE WHEN pg_catalog.pg_input_is_valid(item.value ->> 'orderItemId', 'uuid')
              THEN (item.value ->> 'orderItemId')::uuid::text = item.value ->> 'orderItemId'
              ELSE false END AND
            pg_catalog.jsonb_typeof(item.value -> 'totalPresentmentMinor') = 'number' AND
            CASE WHEN pg_catalog.pg_input_is_valid(
                item.value ->> 'totalPresentmentMinor', 'integer'
              ) THEN (item.value ->> 'totalPresentmentMinor')::integer
                BETWEEN 0 AND 99999999
              ELSE false END
          ) ELSE false END) IS TRUE)
        ) AND
        (
          SELECT pg_catalog.count(*) =
            pg_catalog.count(DISTINCT item.value ->> 'orderItemId')
          FROM pg_catalog.jsonb_array_elements(requested_input -> 'items') item(value)
        )
      ) ELSE false END
    ) IS TRUE INTO valid_input;
  ELSIF requested_kind = 'refund_draft_discard' THEN
    SELECT (
      requested_input ?& ARRAY[
        'kind','refundId','expectedActiveDraftVersion'
      ]::text[] AND
      requested_input - 'kind' - 'refundId' - 'expectedActiveDraftVersion' = '{}'::jsonb AND
      pg_catalog.jsonb_typeof(requested_input -> 'kind') = 'string' AND
      requested_input ->> 'kind' = requested_kind AND
      pg_catalog.jsonb_typeof(requested_input -> 'refundId') = 'string' AND
      CASE WHEN pg_catalog.pg_input_is_valid(requested_input ->> 'refundId', 'uuid')
        THEN (requested_input ->> 'refundId')::uuid::text = requested_input ->> 'refundId'
        ELSE false END AND
      pg_catalog.jsonb_typeof(requested_input -> 'expectedActiveDraftVersion') = 'number' AND
      CASE WHEN pg_catalog.pg_input_is_valid(
          requested_input ->> 'expectedActiveDraftVersion', 'integer'
        ) THEN (requested_input ->> 'expectedActiveDraftVersion')::integer
          BETWEEN 1 AND 2147483647 ELSE false END
    ) IS TRUE INTO valid_input;
  ELSIF requested_kind = 'refund_allocation_finalize' THEN
    SELECT (
      requested_input ?& ARRAY[
        'kind','refundId','expectedActiveDraftVersion','previewFingerprint','confirmation'
      ]::text[] AND
      requested_input - 'kind' - 'refundId' - 'expectedActiveDraftVersion' -
        'previewFingerprint' - 'confirmation' = '{}'::jsonb AND
      pg_catalog.jsonb_typeof(requested_input -> 'kind') = 'string' AND
      requested_input ->> 'kind' = requested_kind AND
      pg_catalog.jsonb_typeof(requested_input -> 'refundId') = 'string' AND
      CASE WHEN pg_catalog.pg_input_is_valid(requested_input ->> 'refundId', 'uuid')
        THEN (requested_input ->> 'refundId')::uuid::text = requested_input ->> 'refundId'
        ELSE false END AND
      pg_catalog.jsonb_typeof(requested_input -> 'expectedActiveDraftVersion') = 'number' AND
      CASE WHEN pg_catalog.pg_input_is_valid(
          requested_input ->> 'expectedActiveDraftVersion', 'integer'
        ) THEN (requested_input ->> 'expectedActiveDraftVersion')::integer
          BETWEEN 1 AND 2147483647 ELSE false END AND
      pg_catalog.jsonb_typeof(requested_input -> 'previewFingerprint') = 'string' AND
      requested_input ->> 'previewFingerprint' ~ '^[a-f0-9]{64}$' AND
      pg_catalog.jsonb_typeof(requested_input -> 'confirmation') = 'string' AND
      requested_input ->> 'confirmation' = 'finalize_refund_allocation'
    ) IS TRUE INTO valid_input;
  ELSIF requested_kind = 'refund_reporting_correction_create' THEN
    SELECT (
      requested_input ?& ARRAY[
        'kind','refundId','reason','expectedNextCorrectionVersion',
        'expectedBaseAllocationSetId','expectedSourceFingerprint','items',
        'previewFingerprint','confirmation'
      ]::text[] AND
      requested_input - 'kind' - 'refundId' - 'reason' -
        'expectedNextCorrectionVersion' - 'expectedBaseAllocationSetId' -
        'expectedSourceFingerprint' - 'items' - 'previewFingerprint' -
        'confirmation' = '{}'::jsonb AND
      pg_catalog.jsonb_typeof(requested_input -> 'kind') = 'string' AND
      requested_input ->> 'kind' = requested_kind AND
      pg_catalog.jsonb_typeof(requested_input -> 'refundId') = 'string' AND
      CASE WHEN pg_catalog.pg_input_is_valid(requested_input ->> 'refundId', 'uuid')
        THEN (requested_input ->> 'refundId')::uuid::text = requested_input ->> 'refundId'
        ELSE false END AND
      pg_catalog.jsonb_typeof(requested_input -> 'reason') = 'string' AND
      requested_input ->> 'reason' = 'allocation_attribution_correction' AND
      pg_catalog.jsonb_typeof(requested_input -> 'expectedNextCorrectionVersion') = 'number' AND
      CASE WHEN pg_catalog.pg_input_is_valid(
          requested_input ->> 'expectedNextCorrectionVersion', 'integer'
        ) THEN (requested_input ->> 'expectedNextCorrectionVersion')::integer
          BETWEEN 1 AND 2147483647 ELSE false END AND
      pg_catalog.jsonb_typeof(requested_input -> 'expectedBaseAllocationSetId') = 'string' AND
      CASE WHEN pg_catalog.pg_input_is_valid(
          requested_input ->> 'expectedBaseAllocationSetId', 'uuid'
        ) THEN (requested_input ->> 'expectedBaseAllocationSetId')::uuid::text =
          requested_input ->> 'expectedBaseAllocationSetId' ELSE false END AND
      pg_catalog.jsonb_typeof(requested_input -> 'expectedSourceFingerprint') = 'string' AND
      requested_input ->> 'expectedSourceFingerprint' ~ '^[a-f0-9]{64}$' AND
      pg_catalog.jsonb_typeof(requested_input -> 'previewFingerprint') = 'string' AND
      requested_input ->> 'previewFingerprint' ~ '^[a-f0-9]{64}$' AND
      pg_catalog.jsonb_typeof(requested_input -> 'confirmation') = 'string' AND
      requested_input ->> 'confirmation' = 'create_reporting_correction' AND
      CASE WHEN pg_catalog.jsonb_typeof(requested_input -> 'items') = 'array' THEN (
        pg_catalog.jsonb_array_length(requested_input -> 'items') BETWEEN 1 AND 25 AND
        NOT EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_array_elements(requested_input -> 'items') item(value)
          WHERE NOT ((CASE WHEN pg_catalog.jsonb_typeof(item.value) = 'object' THEN (
            item.value ?& ARRAY['orderItemId','totalPresentmentMinor']::text[] AND
            item.value - 'orderItemId' - 'totalPresentmentMinor' = '{}'::jsonb AND
            pg_catalog.jsonb_typeof(item.value -> 'orderItemId') = 'string' AND
            CASE WHEN pg_catalog.pg_input_is_valid(item.value ->> 'orderItemId', 'uuid')
              THEN (item.value ->> 'orderItemId')::uuid::text = item.value ->> 'orderItemId'
              ELSE false END AND
            pg_catalog.jsonb_typeof(item.value -> 'totalPresentmentMinor') = 'number' AND
            CASE WHEN pg_catalog.pg_input_is_valid(
                item.value ->> 'totalPresentmentMinor', 'integer'
              ) THEN (item.value ->> 'totalPresentmentMinor')::integer
                BETWEEN 0 AND 99999999
              ELSE false END
          ) ELSE false END) IS TRUE)
        ) AND
        (
          SELECT pg_catalog.count(*) =
            pg_catalog.count(DISTINCT item.value ->> 'orderItemId')
          FROM pg_catalog.jsonb_array_elements(requested_input -> 'items') item(value)
        )
      ) ELSE false END
    ) IS TRUE INTO valid_input;
  ELSIF requested_kind = 'administrative_recovery_activate' THEN
    SELECT (
      requested_input ?& ARRAY[
        'kind','refundId','finalizationEffectId','orderItemId',
        'expectedCorrectionSetId','expectedCorrectionVersion',
        'expectedSourceFingerprint','previewFingerprint','confirmation'
      ]::text[] AND
      requested_input - 'kind' - 'refundId' - 'finalizationEffectId' -
        'orderItemId' - 'expectedCorrectionSetId' - 'expectedCorrectionVersion' -
        'expectedSourceFingerprint' - 'previewFingerprint' - 'confirmation' = '{}'::jsonb AND
      pg_catalog.jsonb_typeof(requested_input -> 'kind') = 'string' AND
      requested_input ->> 'kind' = requested_kind AND
      pg_catalog.jsonb_typeof(requested_input -> 'refundId') = 'string' AND
      CASE WHEN pg_catalog.pg_input_is_valid(requested_input ->> 'refundId', 'uuid')
        THEN (requested_input ->> 'refundId')::uuid::text = requested_input ->> 'refundId'
        ELSE false END AND
      pg_catalog.jsonb_typeof(requested_input -> 'finalizationEffectId') = 'string' AND
      CASE WHEN pg_catalog.pg_input_is_valid(
          requested_input ->> 'finalizationEffectId', 'uuid'
        ) THEN (requested_input ->> 'finalizationEffectId')::uuid::text =
          requested_input ->> 'finalizationEffectId' ELSE false END AND
      pg_catalog.jsonb_typeof(requested_input -> 'orderItemId') = 'string' AND
      CASE WHEN pg_catalog.pg_input_is_valid(requested_input ->> 'orderItemId', 'uuid')
        THEN (requested_input ->> 'orderItemId')::uuid::text = requested_input ->> 'orderItemId'
        ELSE false END AND
      pg_catalog.jsonb_typeof(requested_input -> 'expectedCorrectionSetId') = 'string' AND
      CASE WHEN pg_catalog.pg_input_is_valid(
          requested_input ->> 'expectedCorrectionSetId', 'uuid'
        ) THEN (requested_input ->> 'expectedCorrectionSetId')::uuid::text =
          requested_input ->> 'expectedCorrectionSetId' ELSE false END AND
      pg_catalog.jsonb_typeof(requested_input -> 'expectedCorrectionVersion') = 'number' AND
      CASE WHEN pg_catalog.pg_input_is_valid(
          requested_input ->> 'expectedCorrectionVersion', 'integer'
        ) THEN (requested_input ->> 'expectedCorrectionVersion')::integer
          BETWEEN 1 AND 2147483647 ELSE false END AND
      pg_catalog.jsonb_typeof(requested_input -> 'expectedSourceFingerprint') = 'string' AND
      requested_input ->> 'expectedSourceFingerprint' ~ '^[a-f0-9]{64}$' AND
      pg_catalog.jsonb_typeof(requested_input -> 'previewFingerprint') = 'string' AND
      requested_input ->> 'previewFingerprint' ~ '^[a-f0-9]{64}$' AND
      pg_catalog.jsonb_typeof(requested_input -> 'confirmation') = 'string' AND
      requested_input ->> 'confirmation' = 'activate_persistent_recovery'
    ) IS TRUE INTO valid_input;
  ELSIF requested_kind = 'administrative_recovery_deactivate' THEN
    SELECT (
      requested_input ?& ARRAY[
        'kind','recoveryGrantId','recoveryReferenceId','expectedStateChangedAt','confirmation'
      ]::text[] AND
      requested_input - 'kind' - 'recoveryGrantId' - 'recoveryReferenceId' -
        'expectedStateChangedAt' - 'confirmation' = '{}'::jsonb AND
      pg_catalog.jsonb_typeof(requested_input -> 'kind') = 'string' AND
      requested_input ->> 'kind' = requested_kind AND
      pg_catalog.jsonb_typeof(requested_input -> 'recoveryGrantId') = 'string' AND
      CASE WHEN pg_catalog.pg_input_is_valid(requested_input ->> 'recoveryGrantId', 'uuid')
        THEN (requested_input ->> 'recoveryGrantId')::uuid::text =
          requested_input ->> 'recoveryGrantId' ELSE false END AND
      pg_catalog.jsonb_typeof(requested_input -> 'recoveryReferenceId') = 'string' AND
      CASE WHEN pg_catalog.pg_input_is_valid(requested_input ->> 'recoveryReferenceId', 'uuid')
        THEN (requested_input ->> 'recoveryReferenceId')::uuid::text =
          requested_input ->> 'recoveryReferenceId' ELSE false END AND
      pg_catalog.jsonb_typeof(requested_input -> 'expectedStateChangedAt') = 'string' AND
      requested_input ->> 'expectedStateChangedAt' ~
        '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' AND
      pg_catalog.pg_input_is_valid(
        requested_input ->> 'expectedStateChangedAt', 'timestamp with time zone'
      ) AND
      CASE WHEN pg_catalog.pg_input_is_valid(
          requested_input ->> 'expectedStateChangedAt', 'timestamp with time zone'
        ) THEN pg_catalog.to_char(
          pg_catalog.timezone(
            'UTC', (requested_input ->> 'expectedStateChangedAt')::timestamptz
          ),
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) = requested_input ->> 'expectedStateChangedAt'
        ELSE false END AND
      pg_catalog.jsonb_typeof(requested_input -> 'confirmation') = 'string' AND
      requested_input ->> 'confirmation' = 'deactivate_persistent_recovery'
    ) IS TRUE INTO valid_input;
  END IF;

  IF valid_input IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid financial administrator command';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('pale-orbit:user-roles:admin')
  );
  IF NOT EXISTS (
    SELECT 1 FROM "public"."user_roles" role_row
    WHERE role_row.user_id = requested_actor AND role_row.role = 'admin'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'financial administrator capability is not current';
  END IF;

  SELECT * INTO command_row
  FROM "public"."financial_admin_commands" command
  WHERE command.actor_user_id = requested_actor
    AND command.idempotency_key_sha256 = requested_idempotency_hash
  FOR UPDATE;
  IF FOUND THEN
    IF command_row.kind::text IS DISTINCT FROM requested_kind OR
      command_row.input_fingerprint_sha256 IS DISTINCT FROM requested_fingerprint OR
      command_row.private_input IS DISTINCT FROM requested_input THEN
      RAISE EXCEPTION USING ERRCODE = '40900',
        MESSAGE = 'financial administrator command idempotency conflict';
    END IF;
    RETURN QUERY SELECT command_row.id, command_row.kind, command_row.status,
      command_row.created_at;
    RETURN;
  END IF;

  command_uuid := pg_catalog.gen_random_uuid();
  job_uuid := pg_catalog.gen_random_uuid();
  INSERT INTO "public"."financial_admin_commands" (
    id, kind, actor_user_id, correlation_id, idempotency_key_sha256,
    input_fingerprint_sha256, private_input, job_id
  ) VALUES (
    command_uuid, requested_kind::"public"."financial_admin_command_kind",
    requested_actor, requested_correlation, requested_idempotency_hash,
    requested_fingerprint, requested_input, job_uuid
  ) RETURNING * INTO command_row;

  INSERT INTO "public"."jobs" (
    id, type, payload, deduplication_key, max_attempts
  ) VALUES (
    job_uuid, 'commerce.financial-admin-command',
    pg_catalog.jsonb_build_object('commandId', command_uuid),
    'commerce:financial-admin-command:' || command_uuid::text || ':v1', 8
  );

  RETURN QUERY SELECT command_row.id, command_row.kind, command_row.status,
    command_row.created_at;
END;
$submit_financial_admin_command$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."submit_financial_admin_command"(uuid,text,text,text,text,jsonb) FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
CREATE FUNCTION "public"."financial_admin_command_status"(uuid,uuid)
RETURNS TABLE (
  command_id uuid,
  command_kind "public"."financial_admin_command_kind",
  command_status "public"."financial_admin_command_status",
  safe_result_code varchar(100),
  safe_result jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  completed_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $financial_admin_command_status$
DECLARE
  requested_actor uuid := $1;
  requested_command uuid := $2;
BEGIN
  IF NOT (
    pg_catalog.pg_has_role(session_user, 'pale_orbit_runtime', 'MEMBER')
    AND NOT pg_catalog.pg_has_role(session_user, 'pale_orbit_financial_worker', 'MEMBER')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'financial administrator command status is not permitted';
  END IF;
  IF requested_actor IS NULL OR requested_command IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid financial administrator command status request';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('pale-orbit:user-roles:admin')
  );
  IF NOT EXISTS (
    SELECT 1 FROM "public"."user_roles" role_row
    WHERE role_row.user_id = requested_actor AND role_row.role = 'admin'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'financial administrator capability is not current';
  END IF;
  RETURN QUERY
  SELECT command.id, command.kind, command.status, command.safe_result_code,
    command.safe_result, command.created_at, command.updated_at, command.completed_at
  FROM "public"."financial_admin_commands" command
  WHERE command.id = requested_command AND command.actor_user_id = requested_actor;
END;
$financial_admin_command_status$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."financial_admin_command_status"(uuid,uuid) FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
CREATE FUNCTION "public"."append_financial_issue_view_audit"(uuid,uuid,text,text,text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $financial_issue_view_audit$
DECLARE
  requested_actor uuid := $1;
  requested_issue uuid := $2;
  requested_correlation text := $3;
  requested_method text := $4;
  requested_route text := $5;
BEGIN
  IF NOT (pg_catalog.pg_has_role(session_user, 'pale_orbit_runtime', 'MEMBER') AND
    NOT pg_catalog.pg_has_role(session_user, 'pale_orbit_financial_worker', 'MEMBER')) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'financial audit is not permitted';
  END IF;
  IF requested_actor IS NULL OR requested_issue IS NULL OR
    requested_correlation IS NULL OR requested_method IS NULL OR
    requested_route IS NULL OR
    requested_correlation !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$' OR
    requested_method IS DISTINCT FROM 'GET' OR
    requested_route IS DISTINCT FROM '/admin/sales/issues/' || requested_issue::text THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid financial audit request';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pale-orbit:user-roles:admin'));
  IF NOT EXISTS (SELECT 1 FROM "public"."user_roles" role_row
    WHERE role_row.user_id = requested_actor AND role_row.role = 'admin') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'financial administrator capability is not current';
  END IF;
  PERFORM pg_catalog.set_config(
    'pale_orbit.plan6bii_financial_read_audit_action', 'financial.issue.view', true
  );
  INSERT INTO "public"."audit_events" (
    actor_type, actor_id, action, outcome, resource_type, resource_id,
    correlation_id, request_metadata
  ) VALUES (
    'user'::"public"."audit_actor_type", requested_actor::text,
    'financial.issue.view', 'succeeded'::"public"."audit_outcome",
    'financial_issue', requested_issue::text, requested_correlation,
    pg_catalog.jsonb_build_object('method', requested_method, 'route', requested_route)
  );
END;
$financial_issue_view_audit$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."append_financial_issue_view_audit"(uuid,uuid,text,text,text) FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
CREATE FUNCTION "public"."append_financial_refund_review_view_audit"(uuid,uuid,text,text,text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $financial_refund_review_view_audit$
DECLARE
  requested_actor uuid := $1;
  requested_refund uuid := $2;
  requested_correlation text := $3;
  requested_method text := $4;
  requested_route text := $5;
BEGIN
  IF NOT (pg_catalog.pg_has_role(session_user, 'pale_orbit_runtime', 'MEMBER') AND
    NOT pg_catalog.pg_has_role(session_user, 'pale_orbit_financial_worker', 'MEMBER')) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'financial audit is not permitted';
  END IF;
  IF requested_actor IS NULL OR requested_refund IS NULL OR
    requested_correlation IS NULL OR requested_method IS NULL OR
    requested_route IS NULL OR
    requested_correlation !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$' OR
    requested_method IS DISTINCT FROM 'GET' OR
    requested_route IS DISTINCT FROM '/admin/sales/refunds/' || requested_refund::text THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid financial audit request';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pale-orbit:user-roles:admin'));
  IF NOT EXISTS (SELECT 1 FROM "public"."user_roles" role_row
    WHERE role_row.user_id = requested_actor AND role_row.role = 'admin') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'financial administrator capability is not current';
  END IF;
  PERFORM pg_catalog.set_config(
    'pale_orbit.plan6bii_financial_read_audit_action', 'financial.refund_review.view', true
  );
  INSERT INTO "public"."audit_events" (
    actor_type, actor_id, action, outcome, resource_type, resource_id,
    correlation_id, request_metadata
  ) VALUES (
    'user'::"public"."audit_actor_type", requested_actor::text,
    'financial.refund_review.view', 'succeeded'::"public"."audit_outcome",
    'refund', requested_refund::text, requested_correlation,
    pg_catalog.jsonb_build_object('method', requested_method, 'route', requested_route)
  );
END;
$financial_refund_review_view_audit$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."append_financial_refund_review_view_audit"(uuid,uuid,text,text,text) FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
CREATE FUNCTION "public"."append_financial_payout_view_audit"(uuid,uuid,text,text,text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $financial_payout_view_audit$
DECLARE
  requested_actor uuid := $1;
  requested_payout uuid := $2;
  requested_correlation text := $3;
  requested_method text := $4;
  requested_route text := $5;
BEGIN
  IF NOT (pg_catalog.pg_has_role(session_user, 'pale_orbit_runtime', 'MEMBER') AND
    NOT pg_catalog.pg_has_role(session_user, 'pale_orbit_financial_worker', 'MEMBER')) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'financial audit is not permitted';
  END IF;
  IF requested_actor IS NULL OR requested_payout IS NULL OR
    requested_correlation IS NULL OR requested_method IS NULL OR
    requested_route IS NULL OR
    requested_correlation !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$' OR
    requested_method IS DISTINCT FROM 'GET' OR
    requested_route IS DISTINCT FROM '/admin/sales/payouts/' || requested_payout::text THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid financial audit request';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pale-orbit:user-roles:admin'));
  IF NOT EXISTS (SELECT 1 FROM "public"."user_roles" role_row
    WHERE role_row.user_id = requested_actor AND role_row.role = 'admin') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'financial administrator capability is not current';
  END IF;
  PERFORM pg_catalog.set_config(
    'pale_orbit.plan6bii_financial_read_audit_action', 'financial.payout.view', true
  );
  INSERT INTO "public"."audit_events" (
    actor_type, actor_id, action, outcome, resource_type, resource_id,
    correlation_id, request_metadata
  ) VALUES (
    'user'::"public"."audit_actor_type", requested_actor::text,
    'financial.payout.view', 'succeeded'::"public"."audit_outcome",
    'payout', requested_payout::text, requested_correlation,
    pg_catalog.jsonb_build_object('method', requested_method, 'route', requested_route)
  );
END;
$financial_payout_view_audit$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."append_financial_payout_view_audit"(uuid,uuid,text,text,text) FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
CREATE FUNCTION "public"."append_financial_sales_export_audit"(uuid,text,text,integer,integer,integer,text,text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $financial_sales_export_audit$
DECLARE
  requested_actor uuid := $1;
  filter_fingerprint text := $2;
  requested_correlation text := $3;
  row_count integer := $4;
  byte_count integer := $5;
  currency_pair_count integer := $6;
  requested_method text := $7;
  requested_route text := $8;
BEGIN
  IF NOT (pg_catalog.pg_has_role(session_user, 'pale_orbit_runtime', 'MEMBER') AND
    NOT pg_catalog.pg_has_role(session_user, 'pale_orbit_financial_worker', 'MEMBER')) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'financial audit is not permitted';
  END IF;
  IF requested_actor IS NULL OR filter_fingerprint IS NULL OR
    requested_correlation IS NULL OR row_count IS NULL OR byte_count IS NULL OR
    currency_pair_count IS NULL OR requested_method IS NULL OR requested_route IS NULL OR
    filter_fingerprint !~ '^[a-f0-9]{64}$' OR
    requested_correlation !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$' OR
    row_count NOT BETWEEN 0 AND 2147483647 OR byte_count NOT BETWEEN 0 AND 2147483647 OR
    currency_pair_count NOT BETWEEN 0 AND 2147483647 OR
    requested_method IS DISTINCT FROM 'GET' OR
    requested_route IS DISTINCT FROM '/admin/sales/export.csv' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid financial audit request';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pale-orbit:user-roles:admin'));
  IF NOT EXISTS (SELECT 1 FROM "public"."user_roles" role_row
    WHERE role_row.user_id = requested_actor AND role_row.role = 'admin') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'financial administrator capability is not current';
  END IF;
  PERFORM pg_catalog.set_config(
    'pale_orbit.plan6bii_financial_read_audit_action', 'financial.sales_export', true
  );
  INSERT INTO "public"."audit_events" (
    actor_type, actor_id, action, outcome, resource_type, resource_id,
    correlation_id, request_metadata
  ) VALUES (
    'user'::"public"."audit_actor_type", requested_actor::text,
    'financial.sales_export', 'succeeded'::"public"."audit_outcome",
    'financial_sales_export', filter_fingerprint, requested_correlation,
    pg_catalog.jsonb_build_object(
      'filterFingerprint', filter_fingerprint, 'rowCount', row_count,
      'byteCount', byte_count, 'currencyPairCount', currency_pair_count,
      'method', requested_method, 'route', requested_route
    )
  );
END;
$financial_sales_export_audit$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."append_financial_sales_export_audit"(uuid,text,text,integer,integer,integer,text,text) FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
CREATE FUNCTION "public"."plan6bii_guard_financial_admin_command_update"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $financial_admin_command_update_guard$
DECLARE
  valid_transition boolean := false;
  sync_owner name;
  sync_transition boolean := false;
  audit_action text;
  audit_outcome "public"."audit_outcome";
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'financial administrator command history is immutable';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.kind IS DISTINCT FROM OLD.kind OR
    NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id OR
    NEW.correlation_id IS DISTINCT FROM OLD.correlation_id OR
    NEW.idempotency_key_sha256 IS DISTINCT FROM OLD.idempotency_key_sha256 OR
    NEW.input_fingerprint_sha256 IS DISTINCT FROM OLD.input_fingerprint_sha256 OR
    NEW.private_input IS DISTINCT FROM OLD.private_input OR
    NEW.job_id IS DISTINCT FROM OLD.job_id OR
    NEW.created_at IS DISTINCT FROM OLD.created_at OR
    NEW.status = 'pending' OR NOT pg_catalog.isfinite(NEW.updated_at) OR
    NOT pg_catalog.isfinite(NEW.completed_at) OR NEW.updated_at < OLD.updated_at OR
    NEW.updated_at < NEW.created_at OR NEW.completed_at IS NULL OR
    NEW.completed_at < NEW.updated_at THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'invalid financial administrator command transition';
  END IF;

  valid_transition := ((
    NEW.status = 'succeeded' AND
    CASE WHEN pg_catalog.jsonb_typeof(NEW.safe_result) = 'object' THEN (
      pg_catalog.pg_column_size(NEW.safe_result) <= 4096 AND (
      (
        NEW.kind = 'refund_draft_save' AND NEW.safe_result_code = 'draft_saved' AND
        NEW.safe_result ?& ARRAY['refundId','draftVersion','changed']::text[] AND
        NEW.safe_result - 'refundId' - 'draftVersion' - 'changed' = '{}'::jsonb AND
        pg_catalog.jsonb_typeof(NEW.safe_result -> 'refundId') = 'string' AND
        CASE WHEN pg_catalog.pg_input_is_valid(NEW.safe_result ->> 'refundId', 'uuid')
          THEN (NEW.safe_result ->> 'refundId')::uuid::text = NEW.safe_result ->> 'refundId'
          ELSE false END AND
        pg_catalog.jsonb_typeof(NEW.safe_result -> 'draftVersion') = 'number' AND
        CASE WHEN pg_catalog.pg_input_is_valid(NEW.safe_result ->> 'draftVersion', 'integer')
          THEN (NEW.safe_result ->> 'draftVersion')::integer BETWEEN 1 AND 2147483647
          ELSE false END AND
        pg_catalog.jsonb_typeof(NEW.safe_result -> 'changed') = 'boolean'
      ) OR (
        NEW.kind = 'refund_draft_discard' AND NEW.safe_result_code = 'draft_discarded' AND
        NEW.safe_result ?& ARRAY['refundId','draftVersion','changed']::text[] AND
        NEW.safe_result - 'refundId' - 'draftVersion' - 'changed' = '{}'::jsonb AND
        pg_catalog.jsonb_typeof(NEW.safe_result -> 'refundId') = 'string' AND
        CASE WHEN pg_catalog.pg_input_is_valid(NEW.safe_result ->> 'refundId', 'uuid')
          THEN (NEW.safe_result ->> 'refundId')::uuid::text = NEW.safe_result ->> 'refundId'
          ELSE false END AND
        pg_catalog.jsonb_typeof(NEW.safe_result -> 'draftVersion') = 'number' AND
        CASE WHEN pg_catalog.pg_input_is_valid(NEW.safe_result ->> 'draftVersion', 'integer')
          THEN (NEW.safe_result ->> 'draftVersion')::integer BETWEEN 1 AND 2147483647
          ELSE false END AND
        pg_catalog.jsonb_typeof(NEW.safe_result -> 'changed') = 'boolean'
      ) OR (
        NEW.kind = 'refund_allocation_finalize' AND
        NEW.safe_result_code = 'allocation_finalized' AND
        NEW.safe_result ?& ARRAY[
          'refundId','finalizedDraftVersion','accessChanged','emailQueued'
        ]::text[] AND
        NEW.safe_result - 'refundId' - 'finalizedDraftVersion' -
          'accessChanged' - 'emailQueued' = '{}'::jsonb AND
        pg_catalog.jsonb_typeof(NEW.safe_result -> 'refundId') = 'string' AND
        CASE WHEN pg_catalog.pg_input_is_valid(NEW.safe_result ->> 'refundId', 'uuid')
          THEN (NEW.safe_result ->> 'refundId')::uuid::text = NEW.safe_result ->> 'refundId'
          ELSE false END AND
        pg_catalog.jsonb_typeof(NEW.safe_result -> 'finalizedDraftVersion') = 'number' AND
        CASE WHEN pg_catalog.pg_input_is_valid(
            NEW.safe_result ->> 'finalizedDraftVersion', 'integer'
          ) THEN (NEW.safe_result ->> 'finalizedDraftVersion')::integer
            BETWEEN 1 AND 2147483647 ELSE false END AND
        pg_catalog.jsonb_typeof(NEW.safe_result -> 'accessChanged') = 'boolean' AND
        pg_catalog.jsonb_typeof(NEW.safe_result -> 'emailQueued') = 'boolean'
      ) OR (
        NEW.kind = 'refund_reporting_correction_create' AND
        NEW.safe_result_code = 'correction_created' AND
        NEW.safe_result ?& ARRAY[
          'refundId','correctionSetId','correctionVersion'
        ]::text[] AND
        NEW.safe_result - 'refundId' - 'correctionSetId' -
          'correctionVersion' = '{}'::jsonb AND
        pg_catalog.jsonb_typeof(NEW.safe_result -> 'refundId') = 'string' AND
        CASE WHEN pg_catalog.pg_input_is_valid(NEW.safe_result ->> 'refundId', 'uuid')
          THEN (NEW.safe_result ->> 'refundId')::uuid::text = NEW.safe_result ->> 'refundId'
          ELSE false END AND
        pg_catalog.jsonb_typeof(NEW.safe_result -> 'correctionSetId') = 'string' AND
        CASE WHEN pg_catalog.pg_input_is_valid(NEW.safe_result ->> 'correctionSetId', 'uuid')
          THEN (NEW.safe_result ->> 'correctionSetId')::uuid::text =
            NEW.safe_result ->> 'correctionSetId' ELSE false END AND
        pg_catalog.jsonb_typeof(NEW.safe_result -> 'correctionVersion') = 'number' AND
        CASE WHEN pg_catalog.pg_input_is_valid(
            NEW.safe_result ->> 'correctionVersion', 'integer'
          ) THEN (NEW.safe_result ->> 'correctionVersion')::integer
            BETWEEN 1 AND 2147483647 ELSE false END
      ) OR (
        NEW.kind = 'administrative_recovery_activate' AND
        NEW.safe_result_code = 'recovery_activated' AND
        NEW.safe_result ?& ARRAY['recoveryGrantId','accessChanged','emailQueued']::text[] AND
        NEW.safe_result - 'recoveryGrantId' - 'accessChanged' - 'emailQueued' = '{}'::jsonb AND
        pg_catalog.jsonb_typeof(NEW.safe_result -> 'recoveryGrantId') = 'string' AND
        CASE WHEN pg_catalog.pg_input_is_valid(NEW.safe_result ->> 'recoveryGrantId', 'uuid')
          THEN (NEW.safe_result ->> 'recoveryGrantId')::uuid::text =
            NEW.safe_result ->> 'recoveryGrantId' ELSE false END AND
        pg_catalog.jsonb_typeof(NEW.safe_result -> 'accessChanged') = 'boolean' AND
        pg_catalog.jsonb_typeof(NEW.safe_result -> 'emailQueued') = 'boolean'
      ) OR (
        NEW.kind = 'administrative_recovery_deactivate' AND
        NEW.safe_result_code = 'recovery_deactivated' AND
        NEW.safe_result ?& ARRAY['recoveryGrantId','accessChanged','emailQueued']::text[] AND
        NEW.safe_result - 'recoveryGrantId' - 'accessChanged' - 'emailQueued' = '{}'::jsonb AND
        pg_catalog.jsonb_typeof(NEW.safe_result -> 'recoveryGrantId') = 'string' AND
        CASE WHEN pg_catalog.pg_input_is_valid(NEW.safe_result ->> 'recoveryGrantId', 'uuid')
          THEN (NEW.safe_result ->> 'recoveryGrantId')::uuid::text =
            NEW.safe_result ->> 'recoveryGrantId' ELSE false END AND
        pg_catalog.jsonb_typeof(NEW.safe_result -> 'accessChanged') = 'boolean' AND
        pg_catalog.jsonb_typeof(NEW.safe_result -> 'emailQueued') = 'boolean'
      )
    )) ELSE false END
  ) OR (
    NEW.status = 'denied' AND NEW.safe_result_code = 'capability_revoked' AND
    NEW.safe_result IS NULL
  ) OR (
    NEW.status = 'conflict' AND NEW.safe_result_code IN ('stale_state','not_eligible') AND
    NEW.safe_result IS NULL
  ) OR (
    NEW.status = 'failed' AND NEW.safe_result_code IN ('invalid_command','command_failed') AND
    NEW.safe_result IS NULL
  )) IS TRUE;
  IF valid_transition IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'invalid financial administrator command transition';
  END IF;

  SELECT pg_catalog.pg_get_userbyid(routine.proowner)
  INTO sync_owner
  FROM pg_catalog.pg_proc routine
  WHERE routine.oid = pg_catalog.to_regprocedure(
    'public.plan6bii_sync_failed_financial_admin_command()'
  );
  sync_transition := pg_catalog.pg_trigger_depth() = 2 AND
    current_user = sync_owner AND
    pg_catalog.current_setting(
      'pale_orbit.plan6bii_financial_admin_terminal_sync_command_id', true
    ) = OLD.id::text AND
    NEW.status = 'failed' AND NEW.safe_result_code = 'command_failed' AND
    EXISTS (
      SELECT 1
      FROM "public"."financial_admin_job_claims" claim
      JOIN "public"."jobs" persisted_job ON persisted_job.id = claim.job_id
      WHERE claim.job_id = OLD.job_id
        AND claim.state = 'invalidated'
        AND claim.invalidated_at IS NOT NULL
        AND claim.invalidated_at >=
          COALESCE(claim.renewed_at, claim.issued_at)
        AND claim.attempt = persisted_job.attempts
        AND persisted_job.status = 'running'
        AND persisted_job.attempts BETWEEN 1 AND persisted_job.max_attempts
        AND persisted_job.locked_at IS NOT NULL
        AND persisted_job.locked_by IS NOT NULL
        AND persisted_job.type = 'commerce.financial-admin-command'
        AND persisted_job.payload IS NOT DISTINCT FROM
          pg_catalog.jsonb_build_object('commandId', OLD.id)
        AND persisted_job.deduplication_key IS NOT DISTINCT FROM
          'commerce:financial-admin-command:' || OLD.id::text || ':v1'
        AND persisted_job.max_attempts = 8
    );
  IF sync_transition IS DISTINCT FROM TRUE THEN
    IF NEW.status = 'failed' AND NEW.safe_result_code = 'command_failed' THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'financial administrator command terminal synchronization is reserved';
    END IF;
    IF NOT pg_catalog.pg_has_role(
      session_user, 'pale_orbit_financial_worker', 'MEMBER'
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'financial administrator command transition requires worker authority';
    END IF;
    PERFORM "public"."plan6bii_assert_financial_admin_job_lease"(OLD.job_id);
  END IF;

  IF NEW.status IN ('denied','conflict','failed') THEN
    audit_action := 'financial.admin_command.' || NEW.status::text;
    audit_outcome := CASE WHEN NEW.status = 'denied'
      THEN 'denied'::"public"."audit_outcome"
      ELSE 'failed'::"public"."audit_outcome" END;
    INSERT INTO "public"."audit_events" (
      actor_type, actor_id, action, outcome, resource_type, resource_id,
      correlation_id, after
    ) VALUES (
      'user'::"public"."audit_actor_type", NEW.actor_user_id::text,
      audit_action, audit_outcome, 'financial_admin_command', NEW.id::text,
      NEW.correlation_id, pg_catalog.jsonb_build_object(
        'commandKind', NEW.kind::text, 'safeResultCode', NEW.safe_result_code
      )
    );
  END IF;
  RETURN NEW;
END;
$financial_admin_command_update_guard$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."plan6bii_guard_financial_admin_command_update"() FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
CREATE TRIGGER "financial_admin_commands_plan6bii_update_guard"
BEFORE UPDATE ON "public"."financial_admin_commands"
FOR EACH ROW EXECUTE FUNCTION "public"."plan6bii_guard_financial_admin_command_update"();--> statement-breakpoint
CREATE FUNCTION "public"."plan6bii_guard_financial_admin_command_delete"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $financial_admin_command_delete_guard$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000',
    MESSAGE = 'financial administrator command history cannot be deleted';
END;
$financial_admin_command_delete_guard$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."plan6bii_guard_financial_admin_command_delete"() FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
CREATE TRIGGER "financial_admin_commands_plan6bii_delete_guard"
BEFORE DELETE ON "public"."financial_admin_commands"
FOR EACH ROW EXECUTE FUNCTION "public"."plan6bii_guard_financial_admin_command_delete"();--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."plan6b_guard_audit_insert"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = 'pg_catalog'
AS $plan6bii_audit_insert_guard$
DECLARE
  claim_owner name;
  expected_owner name;
  expected_signature text;
BEGIN
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
CREATE FUNCTION "public"."resolve_financial_issue_after_admin_command"(uuid,uuid)
RETURNS SETOF "public"."financial_reconciliation_issues"
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $admin_financial_issue_resolution$
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
  command_refund_id uuid;
  allowlisted_issue boolean := false;
BEGIN
  IF NOT pg_catalog.pg_has_role(
    session_user, 'pale_orbit_financial_worker', 'MEMBER'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'financial administrator issue transition is not permitted';
  END IF;
  IF requested_command_id IS NULL OR requested_issue_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid financial administrator issue transition';
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
    AND command.kind = 'refund_allocation_finalize'
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
    AND command.kind = 'refund_allocation_finalize'
    AND command.actor_user_id = locked_actor_user_id
    AND command.correlation_id = locked_correlation_id
    AND command.status = locked_command_status;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'invalid financial administrator issue command';
  END IF;
  IF NOT ((
    pg_catalog.jsonb_typeof(command_row.private_input) = 'object' AND
    command_row.private_input ?& ARRAY[
      'kind','refundId','expectedActiveDraftVersion','previewFingerprint','confirmation'
    ]::text[] AND
    command_row.private_input - 'kind' - 'refundId' - 'expectedActiveDraftVersion' -
      'previewFingerprint' - 'confirmation' = '{}'::jsonb AND
    pg_catalog.jsonb_typeof(command_row.private_input -> 'kind') = 'string' AND
    command_row.private_input ->> 'kind' = 'refund_allocation_finalize' AND
    pg_catalog.jsonb_typeof(command_row.private_input -> 'refundId') = 'string' AND
    CASE WHEN pg_catalog.pg_input_is_valid(
        command_row.private_input ->> 'refundId', 'uuid'
      ) THEN (command_row.private_input ->> 'refundId')::uuid::text =
        command_row.private_input ->> 'refundId' ELSE false END AND
    pg_catalog.jsonb_typeof(
      command_row.private_input -> 'expectedActiveDraftVersion'
    ) = 'number' AND
    CASE WHEN pg_catalog.pg_input_is_valid(
        command_row.private_input ->> 'expectedActiveDraftVersion', 'integer'
      ) THEN (command_row.private_input ->> 'expectedActiveDraftVersion')::integer
        BETWEEN 1 AND 2147483647 ELSE false END AND
    pg_catalog.jsonb_typeof(command_row.private_input -> 'previewFingerprint') = 'string' AND
    command_row.private_input ->> 'previewFingerprint' ~ '^[a-f0-9]{64}$' AND
    pg_catalog.jsonb_typeof(command_row.private_input -> 'confirmation') = 'string' AND
    command_row.private_input ->> 'confirmation' = 'finalize_refund_allocation'
  ) IS TRUE) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'invalid financial administrator issue command';
  END IF;
  command_refund_id := (command_row.private_input ->> 'refundId')::uuid;

  SELECT * INTO issue_row
  FROM "public"."financial_reconciliation_issues" issue
  WHERE issue.id = requested_issue_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'financial issue is outside the administrator command scope';
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
    issue_row.state = 'open' AND
    issue_row.safe_code IN (
      'allocation_fork', 'allocation_incomplete', 'allocation_mismatch',
      'classification_fork', 'correction_rebase_required', 'currency_mismatch',
      'immutable_mismatch', 'missing_source', 'source_linkage_mismatch'
    ) AND EXISTS (
      SELECT 1 FROM "public"."refunds" refund
      WHERE refund.id = command_refund_id
    ) AND (
      (issue_row.resource_type = 'refund' AND
        issue_row.resource_id = command_refund_id) OR
      (issue_row.resource_type = 'allocation_set' AND EXISTS (
        SELECT 1
        FROM current_selected_set_lineage lineage
        JOIN current_refund_sets current_set ON current_set.id = lineage.id
      ))
    )
  ) IS TRUE INTO allowlisted_issue;
  IF allowlisted_issue IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'financial issue is outside the administrator command scope';
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
$admin_financial_issue_resolution$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."resolve_financial_issue_after_admin_command"(uuid,uuid) FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."plan6b_validate_issue_transition"() RETURNS trigger
LANGUAGE plpgsql AS $plan6bii_issue_transition$
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
      pg_catalog.current_setting('pale_orbit.financial_worker_issue_resolution', true) =
        OLD.id::text AND
      current_user = (
        SELECT pg_catalog.pg_get_userbyid(worker_resolver.proowner)
        FROM pg_catalog.pg_proc worker_resolver
        WHERE worker_resolver.oid =
          'public.resolve_financial_issue_after_worker_recompute(uuid,text)'::pg_catalog.regprocedure
      ) AND NEW.resolved_by_admin_id IS NULL AND NEW.resolved_at IS NOT NULL AND
      NEW.occurrence_count = OLD.occurrence_count AND
      NEW.last_observed_at IS NOT DISTINCT FROM OLD.last_observed_at;
    admin_resolution :=
      pg_catalog.current_setting(
        'pale_orbit.plan6bii_financial_admin_issue_resolution_issue_id', true
      ) = OLD.id::text AND
      pg_catalog.current_setting(
        'pale_orbit.plan6bii_financial_admin_issue_resolution_command_id', true
      ) ~ '^[0-9a-f-]{36}$' AND
      pg_catalog.current_setting(
        'pale_orbit.plan6bii_financial_admin_issue_resolution_actor_id', true
      ) = NEW.resolved_by_admin_id::text AND
      current_user = (
        SELECT pg_catalog.pg_get_userbyid(admin_resolver.proowner)
        FROM pg_catalog.pg_proc admin_resolver
        WHERE admin_resolver.oid =
          'public.resolve_financial_issue_after_admin_command(uuid,uuid)'::pg_catalog.regprocedure
      ) AND NEW.resolved_by_admin_id IS NOT NULL AND NEW.resolved_at IS NOT NULL AND
      NEW.occurrence_count = OLD.occurrence_count AND
      NEW.last_observed_at IS NOT DISTINCT FROM OLD.last_observed_at;
    IF NOT (worker_resolution OR admin_resolution) THEN
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
$plan6bii_issue_transition$;--> statement-breakpoint
CREATE FUNCTION "public"."plan6bii_sync_failed_financial_admin_command"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $financial_admin_terminal_sync$
DECLARE
  command_row "public"."financial_admin_commands"%ROWTYPE;
  claim_row "public"."financial_admin_job_claims"%ROWTYPE;
  terminal_at timestamptz;
BEGIN
  IF OLD.type IS DISTINCT FROM 'commerce.financial-admin-command' AND
    NEW.type IS DISTINCT FROM 'commerce.financial-admin-command' THEN
    RETURN NEW;
  END IF;
  IF NEW.status NOT IN ('succeeded','failed') THEN
    RETURN NEW;
  END IF;
  IF OLD.status <> 'running' OR
    OLD.locked_at IS NULL OR
    OLD.locked_by IS NULL OR
    NEW.locked_at IS NOT NULL OR NEW.locked_by IS NOT NULL OR
    NEW.completed_at IS NULL OR NEW.attempts IS DISTINCT FROM OLD.attempts OR
    NEW.type IS DISTINCT FROM OLD.type OR NEW.payload IS DISTINCT FROM OLD.payload OR
    NEW.deduplication_key IS DISTINCT FROM OLD.deduplication_key OR
    NEW.max_attempts IS DISTINCT FROM OLD.max_attempts THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'invalid financial administrator job terminal transition';
  END IF;
  SELECT * INTO claim_row
  FROM "public"."financial_admin_job_claims" claim
  WHERE claim.job_id = NEW.id;
  IF NOT FOUND OR claim_row.state <> 'invalidated' OR
    claim_row.invalidated_at IS NULL OR claim_row.attempt <> NEW.attempts THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'financial administrator job lease was not invalidated';
  END IF;
  SELECT * INTO command_row
  FROM "public"."financial_admin_commands" command
  WHERE command.job_id = NEW.id
    AND NEW.payload IS NOT DISTINCT FROM
      pg_catalog.jsonb_build_object('commandId', command.id)
    AND NEW.deduplication_key IS NOT DISTINCT FROM
      'commerce:financial-admin-command:' || command.id::text || ':v1'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'financial administrator job has no linked command';
  END IF;
  IF NEW.status = 'succeeded' THEN
    IF command_row.status <> 'succeeded' THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'financial administrator job cannot succeed before its command';
    END IF;
    RETURN NEW;
  END IF;
  IF command_row.status = 'succeeded' THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'successful financial administrator command cannot fail its job';
  END IF;
  IF command_row.status = 'pending' THEN
    terminal_at := pg_catalog.clock_timestamp();
    PERFORM pg_catalog.set_config(
      'pale_orbit.plan6bii_financial_admin_terminal_sync_command_id',
      command_row.id::text, true
    );
    UPDATE "public"."financial_admin_commands"
    SET status = 'failed', safe_result_code = 'command_failed', safe_result = NULL,
      updated_at = terminal_at, completed_at = terminal_at
    WHERE id = command_row.id AND status = 'pending';
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'financial administrator command terminal synchronization failed';
    END IF;
  END IF;
  RETURN NEW;
END;
$financial_admin_terminal_sync$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."plan6bii_sync_failed_financial_admin_command"() FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
CREATE TRIGGER "jobs_plan6bii_financial_admin_terminal_sync"
BEFORE UPDATE ON "public"."jobs"
FOR EACH ROW EXECUTE FUNCTION "public"."plan6bii_sync_failed_financial_admin_command"();--> statement-breakpoint
CREATE FUNCTION "public"."plan6bii_guard_administrative_grant_transition"()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = 'pg_catalog'
AS $administrative_grant_guard$
DECLARE
  transition_owner name;
  command_identity text;
  job_identity text;
  reference_identity text;
  command_kind "public"."financial_admin_command_kind";
  command_input jsonb;
  guarded_row "public"."entitlement_grants"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    guarded_row := OLD;
  ELSE
    guarded_row := NEW;
  END IF;
  IF (TG_OP = 'INSERT' AND NEW.source <> 'administrative') OR
    (TG_OP = 'DELETE' AND OLD.source <> 'administrative') OR
    (TG_OP = 'UPDATE' AND OLD.source <> 'administrative' AND
      NEW.source <> 'administrative') THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' OR
    (TG_OP = 'UPDATE' AND NEW.source IS DISTINCT FROM OLD.source) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'administrative entitlement transition is reserved';
  END IF;
  SELECT pg_catalog.pg_get_userbyid(routine.proowner)
  INTO transition_owner
  FROM pg_catalog.pg_proc routine
  WHERE routine.oid = pg_catalog.to_regprocedure(
    'public.transition_administrative_recovery_grant_after_admin_command(uuid)'
  );
  command_identity := pg_catalog.current_setting(
    'pale_orbit.plan6bii_administrative_grant_command_id', true
  );
  job_identity := pg_catalog.current_setting(
    'pale_orbit.plan6bii_administrative_grant_job_id', true
  );
  reference_identity := pg_catalog.current_setting(
    'pale_orbit.plan6bii_administrative_grant_reference_id', true
  );
  IF current_user IS DISTINCT FROM transition_owner OR
    command_identity IS NULL OR
    NOT pg_catalog.pg_input_is_valid(command_identity, 'uuid') OR
    job_identity IS NULL OR NOT pg_catalog.pg_input_is_valid(job_identity, 'uuid') OR
    reference_identity IS NULL OR
    NOT pg_catalog.pg_input_is_valid(reference_identity, 'uuid') OR
    guarded_row.source IS DISTINCT FROM 'administrative' OR
    guarded_row.state_reason IS DISTINCT FROM 'refund_allocation_recovery' OR
    guarded_row.order_item_id IS NOT NULL OR guarded_row.user_id IS NULL OR
    guarded_row.title_id IS NULL OR
    guarded_row.recovery_refund_allocation_id::text IS DISTINCT FROM reference_identity THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'administrative entitlement transition is reserved';
  END IF;
  SELECT command.kind, command.private_input
  INTO command_kind, command_input
  FROM "public"."financial_admin_commands" command
  WHERE command.id::text = command_identity
    AND command.job_id::text = job_identity
    AND command.status = 'pending'
    AND (
      command.kind = 'administrative_recovery_activate' OR
      command.kind = 'administrative_recovery_deactivate'
    );
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'administrative entitlement transition is reserved';
  END IF;

  IF command_kind = 'administrative_recovery_activate' THEN
    IF NOT ((
      pg_catalog.jsonb_typeof(command_input) = 'object' AND
      pg_catalog.jsonb_typeof(command_input -> 'finalizationEffectId') = 'string' AND
      pg_catalog.jsonb_typeof(command_input -> 'orderItemId') = 'string' AND
      CASE WHEN pg_catalog.pg_input_is_valid(
          command_input ->> 'finalizationEffectId', 'uuid'
        ) THEN EXISTS (
          SELECT 1
          FROM "public"."refund_allocation_finalization_effects" effect
          JOIN "public"."entitlement_grants" purchase
            ON purchase.id = effect.purchase_grant_id
           AND purchase.order_item_id = effect.order_item_id
          WHERE effect.id = (command_input ->> 'finalizationEffectId')::uuid
            AND effect.order_item_id::text = command_input ->> 'orderItemId'
            AND effect.refund_allocation_id =
              guarded_row.recovery_refund_allocation_id
            AND effect.transition = 'revoked_by_finalization'
            AND purchase.source = 'purchase'
            AND purchase.user_id = guarded_row.user_id
            AND purchase.title_id = guarded_row.title_id
        ) ELSE false END AND
      guarded_row.state IS DISTINCT FROM 'revoked' AND
      guarded_row.state IS NOT DISTINCT FROM 'active' AND
      (
        (TG_OP = 'INSERT' AND guarded_row.revoked_at IS NULL) OR
        (TG_OP = 'UPDATE' AND OLD.state = 'revoked' AND
          OLD.id = NEW.id AND OLD.user_id = NEW.user_id AND
          OLD.title_id = NEW.title_id AND
          OLD.recovery_refund_allocation_id =
            NEW.recovery_refund_allocation_id AND
          NEW.revoked_at IS NULL)
      )
    ) IS TRUE) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'administrative entitlement transition is reserved';
    END IF;
  ELSE
    IF NOT ((
      TG_OP = 'UPDATE' AND OLD.id = NEW.id AND OLD.state = 'active' AND
      guarded_row.state IS DISTINCT FROM 'active' AND
      guarded_row.state IS NOT DISTINCT FROM 'revoked' AND
      guarded_row.revoked_at IS NOT NULL AND
      guarded_row.revoked_at = guarded_row.updated_at AND
      pg_catalog.jsonb_typeof(command_input) = 'object' AND
      pg_catalog.jsonb_typeof(command_input -> 'recoveryGrantId') = 'string' AND
      command_input ->> 'recoveryGrantId' = guarded_row.id::text AND
      pg_catalog.jsonb_typeof(command_input -> 'recoveryReferenceId') = 'string' AND
      command_input ->> 'recoveryReferenceId' =
        guarded_row.recovery_refund_allocation_id::text AND
      pg_catalog.jsonb_typeof(command_input -> 'expectedStateChangedAt') = 'string' AND
      pg_catalog.pg_input_is_valid(
        command_input ->> 'expectedStateChangedAt', 'timestamp with time zone'
      ) AND
      OLD.updated_at =
        (command_input ->> 'expectedStateChangedAt')::timestamptz
    ) IS TRUE) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'administrative entitlement transition is reserved';
    END IF;
  END IF;
  PERFORM "public"."plan6bii_assert_financial_admin_job_lease"(job_identity::uuid);
  RETURN NEW;
END;
$administrative_grant_guard$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."plan6bii_guard_administrative_grant_transition"() FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
CREATE TRIGGER "entitlement_grants_plan6bii_administrative_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "public"."entitlement_grants"
FOR EACH ROW EXECUTE FUNCTION "public"."plan6bii_guard_administrative_grant_transition"();--> statement-breakpoint
CREATE FUNCTION "public"."transition_administrative_recovery_grant_after_admin_command"(uuid)
RETURNS TABLE (
  recovery_grant_id uuid,
  recovery_user_id uuid,
  recovery_title_id uuid,
  previous_state "public"."entitlement_grant_status",
  next_state "public"."entitlement_grant_status",
  state_changed_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $administrative_recovery$
DECLARE
  requested_command_id uuid := $1;
  command_job_id uuid;
  locked_command_id uuid;
  locked_command_kind "public"."financial_admin_command_kind";
  locked_actor_user_id uuid;
  locked_correlation_id text;
  locked_command_status "public"."financial_admin_command_status";
  command_input jsonb;
  projection_row "public"."financial_projection_versions"%ROWTYPE;
  effect_row "public"."refund_allocation_finalization_effects"%ROWTYPE;
  allocation_row "public"."refund_allocations"%ROWTYPE;
  allocation_component_row "public"."refund_allocation_components"%ROWTYPE;
  refund_row "public"."refunds"%ROWTYPE;
  payment_row "public"."payments"%ROWTYPE;
  order_row "public"."orders"%ROWTYPE;
  order_item_row "public"."order_items"%ROWTYPE;
  purchase_row "public"."entitlement_grants"%ROWTYPE;
  draft_row "public"."refund_allocation_drafts"%ROWTYPE;
  correction_row "public"."refund_reporting_correction_sets"%ROWTYPE;
  base_set_row "public"."financial_allocation_sets"%ROWTYPE;
  source_balance_row "public"."stripe_balance_transactions"%ROWTYPE;
  recovery_row "public"."entitlement_grants"%ROWTYPE;
  input_refund_id uuid;
  input_effect_id uuid;
  input_order_item_id uuid;
  input_correction_id uuid;
  input_correction_version integer;
  input_source_fingerprint text;
  input_preview_fingerprint text;
  input_recovery_grant_id uuid;
  input_recovery_reference_id uuid;
  input_expected_state_changed_at timestamptz;
  discovered_payment_id uuid;
  discovered_order_id uuid;
  discovered_effect_id uuid;
  discovered_purchase_grant_id uuid;
  discovered_order_item_id uuid;
  discovered_user_id uuid;
  discovered_title_id uuid;
  source_balance_transaction_id uuid;
  refund_ids uuid[];
  draft_ids uuid[];
  correction_ids uuid[];
  dispute_ids uuid[];
  payout_ids uuid[];
  fee_detail_ids uuid[];
  active_balance_transaction_ids uuid[];
  rediscovered_balance_transaction_ids uuid[];
  discovered_payout_generations jsonb;
  rediscovered_payout_generations jsonb;
  discovered_financial_memberships jsonb;
  rediscovered_financial_memberships jsonb;
  allocation_set_ids uuid[];
  projection_head_count bigint;
  projection_head_distinct_basis_count bigint;
  projection_head_serialized_count bigint;
  projection_heads_valid boolean;
  projection_head_lines text;
  projection_item_count bigint;
  projection_item_distinct_count bigint;
  projection_item_serialized_count bigint;
  projection_items_valid boolean;
  projection_item_lines text;
  succeeded_refund_count bigint;
  presentment_evidence_count bigint;
  presentment_resolved_count bigint;
  presentment_serialized_count bigint;
  presentment_evidence_valid boolean;
  presentment_evidence_lines text;
  projection_implementation jsonb;
  cumulative_refund_subtotal_minor bigint;
  cumulative_refund_tax_minor bigint;
  corrected_presentment_total bigint;
  remaining_unrefunded_minor bigint;
  existing_recovery_state_changed_text text;
  effective_access_before boolean;
  effective_access_after boolean;
  predicted_access_changed boolean;
  predicted_email_queued boolean;
  preview_preimage text;
  computed_preview_fingerprint text;
  transition_at timestamptz;
  prior_state "public"."entitlement_grant_status";
  purchase_order_item_count bigint;
  purchase_order_item_total_minor bigint;
  purchase_order_items_valid boolean;
  lock_id uuid;
  financial_issue_lock_key record;
  entitlement_scope record;
BEGIN
  IF NOT pg_catalog.pg_has_role(
    session_user, 'pale_orbit_financial_worker', 'MEMBER'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'administrative recovery transition is not permitted';
  END IF;
  IF requested_command_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023',
      MESSAGE = 'invalid administrative recovery command';
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
  SELECT command.id, command.kind, command.actor_user_id,
    command.correlation_id, command.status
  INTO locked_command_id, locked_command_kind, locked_actor_user_id,
    locked_correlation_id, locked_command_status
  FROM "public"."financial_admin_commands" command
  WHERE command.id = requested_command_id
    AND command.job_id = command_job_id
    AND command.kind IN (
      'administrative_recovery_activate',
      'administrative_recovery_deactivate'
    )
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
  SELECT command.private_input INTO command_input
  FROM "public"."financial_admin_commands" command
  WHERE command.id = locked_command_id
    AND command.job_id = command_job_id
    AND command.kind = locked_command_kind
    AND command.actor_user_id = locked_actor_user_id
    AND command.correlation_id = locked_correlation_id
    AND command.status = locked_command_status;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'invalid administrative recovery command';
  END IF;

  IF locked_command_kind = 'administrative_recovery_activate' THEN
    IF NOT ((
      pg_catalog.jsonb_typeof(command_input) = 'object' AND
      command_input ?& ARRAY[
        'kind','refundId','finalizationEffectId','orderItemId',
        'expectedCorrectionSetId','expectedCorrectionVersion',
        'expectedSourceFingerprint','previewFingerprint','confirmation'
      ]::text[] AND
      command_input - 'kind' - 'refundId' - 'finalizationEffectId' -
        'orderItemId' - 'expectedCorrectionSetId' - 'expectedCorrectionVersion' -
        'expectedSourceFingerprint' - 'previewFingerprint' - 'confirmation' = '{}'::jsonb AND
      pg_catalog.jsonb_typeof(command_input -> 'kind') = 'string' AND
      command_input ->> 'kind' = 'administrative_recovery_activate' AND
      pg_catalog.jsonb_typeof(command_input -> 'refundId') = 'string' AND
      CASE WHEN pg_catalog.pg_input_is_valid(command_input ->> 'refundId', 'uuid')
        THEN (command_input ->> 'refundId')::uuid::text =
          command_input ->> 'refundId' ELSE false END AND
      pg_catalog.jsonb_typeof(command_input -> 'finalizationEffectId') = 'string' AND
      CASE WHEN pg_catalog.pg_input_is_valid(
          command_input ->> 'finalizationEffectId', 'uuid'
        ) THEN (command_input ->> 'finalizationEffectId')::uuid::text =
          command_input ->> 'finalizationEffectId' ELSE false END AND
      pg_catalog.jsonb_typeof(command_input -> 'orderItemId') = 'string' AND
      CASE WHEN pg_catalog.pg_input_is_valid(command_input ->> 'orderItemId', 'uuid')
        THEN (command_input ->> 'orderItemId')::uuid::text =
          command_input ->> 'orderItemId' ELSE false END AND
      pg_catalog.jsonb_typeof(command_input -> 'expectedCorrectionSetId') = 'string' AND
      CASE WHEN pg_catalog.pg_input_is_valid(
          command_input ->> 'expectedCorrectionSetId', 'uuid'
        ) THEN (command_input ->> 'expectedCorrectionSetId')::uuid::text =
          command_input ->> 'expectedCorrectionSetId' ELSE false END AND
      pg_catalog.jsonb_typeof(command_input -> 'expectedCorrectionVersion') = 'number' AND
      CASE WHEN pg_catalog.pg_input_is_valid(
          command_input ->> 'expectedCorrectionVersion', 'integer'
        ) THEN (command_input ->> 'expectedCorrectionVersion')::integer
          BETWEEN 1 AND 2147483647 ELSE false END AND
      pg_catalog.jsonb_typeof(command_input -> 'expectedSourceFingerprint') = 'string' AND
      command_input ->> 'expectedSourceFingerprint' ~ '^[a-f0-9]{64}$' AND
      pg_catalog.jsonb_typeof(command_input -> 'previewFingerprint') = 'string' AND
      command_input ->> 'previewFingerprint' ~ '^[a-f0-9]{64}$' AND
      pg_catalog.jsonb_typeof(command_input -> 'confirmation') = 'string' AND
      command_input ->> 'confirmation' = 'activate_persistent_recovery'
    ) IS TRUE) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'invalid administrative recovery command';
    END IF;

    input_refund_id := (command_input ->> 'refundId')::uuid;
    input_effect_id := (command_input ->> 'finalizationEffectId')::uuid;
    input_order_item_id := (command_input ->> 'orderItemId')::uuid;
    input_correction_id := (command_input ->> 'expectedCorrectionSetId')::uuid;
    input_correction_version :=
      (command_input ->> 'expectedCorrectionVersion')::integer;
    input_source_fingerprint := command_input ->> 'expectedSourceFingerprint';
    input_preview_fingerprint := command_input ->> 'previewFingerprint';

    SELECT * INTO projection_row
    FROM "public"."financial_projection_versions" projection_version
    WHERE projection_version.singleton = true
    FOR UPDATE;
    IF NOT FOUND OR
      projection_row.classifier_version NOT BETWEEN 1 AND 2147483647 OR
      projection_row.allocation_algorithm_version NOT BETWEEN 1 AND 2147483647 OR
      projection_row.pending_classifier_version IS NOT NULL OR
      projection_row.pending_allocation_algorithm_version IS NOT NULL OR
      projection_row.pending_replay_id IS NOT NULL OR
      projection_row.pending_scan_run_id IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'administrative recovery state is stale';
    END IF;
    projection_implementation := pg_catalog.jsonb_build_object(
      'classifierVersion', projection_row.classifier_version,
      'allocationAlgorithmVersion', projection_row.allocation_algorithm_version
    );

    SELECT candidate.payment_id, payment.order_id
    INTO discovered_payment_id, discovered_order_id
    FROM "public"."refunds" candidate
    JOIN "public"."payments" payment ON payment.id = candidate.payment_id
    WHERE candidate.id = input_refund_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'administrative recovery state is stale';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'pale-orbit:commerce:order:' || discovered_order_id::text, 0
    ));
    SELECT * INTO order_row
    FROM "public"."orders" purchase_order
    WHERE purchase_order.id = discovered_order_id
    FOR UPDATE;
    SELECT * INTO payment_row
    FROM "public"."payments" payment
    WHERE payment.id = discovered_payment_id
      AND payment.order_id = discovered_order_id
    FOR UPDATE;
    IF order_row.id IS NULL OR payment_row.id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'administrative recovery state is stale';
    END IF;

    PERFORM 1 FROM "public"."refunds" candidate
    WHERE candidate.payment_id = payment_row.id
    ORDER BY candidate.id FOR UPDATE;
    SELECT COALESCE(
      pg_catalog.array_agg(candidate.id ORDER BY candidate.id),
      ARRAY[]::uuid[]
    ) INTO refund_ids
    FROM "public"."refunds" candidate
    WHERE candidate.payment_id = payment_row.id;

    PERFORM 1 FROM "public"."refund_allocation_drafts" candidate
    WHERE candidate.refund_id = ANY(refund_ids)
    ORDER BY candidate.id FOR UPDATE;
    SELECT COALESCE(
      pg_catalog.array_agg(candidate.id ORDER BY candidate.id),
      ARRAY[]::uuid[]
    ) INTO draft_ids
    FROM "public"."refund_allocation_drafts" candidate
    WHERE candidate.refund_id = ANY(refund_ids);

    PERFORM 1 FROM "public"."refund_allocation_draft_items" candidate
    WHERE candidate.draft_id = ANY(draft_ids)
    ORDER BY candidate.id FOR UPDATE;
    PERFORM 1 FROM "public"."refund_allocations" candidate
    WHERE candidate.refund_id = ANY(refund_ids)
    ORDER BY candidate.id FOR UPDATE;
    PERFORM 1 FROM "public"."refund_allocation_components" candidate
    WHERE candidate.refund_id = ANY(refund_ids)
    ORDER BY candidate.id FOR UPDATE;

    PERFORM 1 FROM "public"."refund_reporting_correction_sets" candidate
    WHERE candidate.refund_id = ANY(refund_ids)
    ORDER BY candidate.id FOR UPDATE;
    SELECT COALESCE(
      pg_catalog.array_agg(candidate.id ORDER BY candidate.id),
      ARRAY[]::uuid[]
    ) INTO correction_ids
    FROM "public"."refund_reporting_correction_sets" candidate
    WHERE candidate.refund_id = ANY(refund_ids);
    PERFORM 1 FROM "public"."refund_reporting_correction_items" candidate
    WHERE candidate.correction_set_id = ANY(correction_ids)
    ORDER BY candidate.id FOR UPDATE;
    PERFORM 1 FROM "public"."disputes" candidate
    WHERE candidate.payment_id = payment_row.id
    ORDER BY candidate.id FOR UPDATE;
    SELECT COALESCE(
      pg_catalog.array_agg(candidate.id ORDER BY candidate.id),
      ARRAY[]::uuid[]
    ) INTO dispute_ids
    FROM "public"."disputes" candidate
    WHERE candidate.payment_id = payment_row.id;
    PERFORM 1 FROM "public"."dispute_item_allocations" candidate
    WHERE candidate.dispute_id = ANY(dispute_ids)
    ORDER BY candidate.id FOR UPDATE;
    PERFORM 1 FROM "public"."order_items" candidate
    WHERE candidate.order_id = order_row.id
    ORDER BY candidate.id FOR UPDATE;
    SELECT pg_catalog.count(*),
      COALESCE(pg_catalog.sum(candidate.total_minor::bigint), 0),
      pg_catalog.bool_and(
        candidate.currency = order_row.currency AND
        candidate.currency = payment_row.currency AND
        candidate.tax_minor IS NOT NULL AND
        candidate.total_minor IS NOT NULL AND
        candidate.unit_subtotal_minor BETWEEN 0 AND 99999999 AND
        candidate.tax_minor BETWEEN 0 AND 99999999 AND
        candidate.total_minor BETWEEN 0 AND 99999999 AND
        candidate.total_minor =
          candidate.unit_subtotal_minor + candidate.tax_minor
      )
    INTO purchase_order_item_count, purchase_order_item_total_minor,
      purchase_order_items_valid
    FROM "public"."order_items" candidate
    WHERE candidate.order_id = order_row.id;
    IF NOT ((
      purchase_order_item_count BETWEEN 1 AND 2147483647 AND
      purchase_order_items_valid AND
      purchase_order_item_total_minor = payment_row.amount_minor::bigint AND
      payment_row.amount_minor = order_row.total_minor AND
      payment_row.currency = order_row.currency
    ) IS TRUE) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'administrative recovery purchase graph is invalid';
    END IF;

    SELECT * INTO refund_row
    FROM "public"."refunds" candidate WHERE candidate.id = input_refund_id;
    SELECT * INTO effect_row
    FROM "public"."refund_allocation_finalization_effects" effect
    WHERE effect.id = input_effect_id;
    SELECT * INTO allocation_row
    FROM "public"."refund_allocations" allocation
    WHERE allocation.id = effect_row.refund_allocation_id
      AND allocation.refund_id = effect_row.refund_id
      AND allocation.order_item_id = effect_row.order_item_id;
    SELECT * INTO allocation_component_row
    FROM "public"."refund_allocation_components" component
    WHERE component.refund_allocation_id = allocation_row.id
      AND component.refund_id = allocation_row.refund_id
      AND component.order_item_id = allocation_row.order_item_id;
    SELECT * INTO order_item_row
    FROM "public"."order_items" item
    WHERE item.id = effect_row.order_item_id AND item.order_id = order_row.id;
    SELECT * INTO draft_row
    FROM "public"."refund_allocation_drafts" draft
    WHERE draft.id = effect_row.draft_id
      AND draft.refund_id = effect_row.refund_id
      AND draft.version = effect_row.draft_version;
    SELECT * INTO correction_row
    FROM "public"."refund_reporting_correction_sets" correction
    WHERE correction.id = input_correction_id;
    SELECT * INTO base_set_row
    FROM "public"."financial_allocation_sets" base_set
    WHERE base_set.id = correction_row.base_allocation_set_id;

    IF effect_row.transition <> 'revoked_by_finalization' THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'administrative recovery state is stale';
    END IF;

    IF NOT ((
      refund_row.id = input_refund_id AND
      effect_row.id = input_effect_id AND
      effect_row.refund_id = input_refund_id AND
      effect_row.order_item_id = input_order_item_id AND
      allocation_row.id = effect_row.refund_allocation_id AND
      allocation_row.source = 'administrative' AND
      allocation_component_row.refund_allocation_id = allocation_row.id AND
      allocation_component_row.total_minor = allocation_row.amount_minor AND
      allocation_component_row.subtotal_minor + allocation_component_row.tax_minor =
        allocation_component_row.total_minor AND
      allocation_component_row.currency = order_item_row.currency AND
      effect_row.transition = 'revoked_by_finalization' AND
      effect_row.before_purchase_grant_state <> 'revoked' AND
      effect_row.after_purchase_grant_state = 'revoked' AND
      draft_row.id = effect_row.draft_id AND draft_row.state = 'finalized' AND
      draft_row.version = effect_row.draft_version AND
      refund_row.payment_id = payment_row.id AND refund_row.status = 'succeeded' AND
      refund_row.allocation_status = 'finalized' AND
      payment_row.status = 'succeeded' AND payment_row.order_id = order_row.id AND
      order_row.status = 'paid' AND
      order_item_row.id = input_order_item_id AND
      order_item_row.title_id IS NOT NULL AND
      order_item_row.tax_minor IS NOT NULL AND order_item_row.total_minor IS NOT NULL AND
      order_item_row.currency ~ '^[A-Z]{3}$' AND
      correction_row.id = input_correction_id AND
      correction_row.refund_id = input_refund_id AND
      correction_row.correction_version = input_correction_version AND
      correction_row.source_fingerprint_sha256 = input_source_fingerprint AND
      correction_row.kind IN (
        'allocation_attribution_correction', 'classifier_rebase'
      ) AND
      base_set_row.id = correction_row.base_allocation_set_id AND
      base_set_row.source_kind = 'refund' AND
      base_set_row.source_internal_id = input_refund_id AND
      base_set_row.source_fingerprint_sha256 = input_source_fingerprint AND
      base_set_row.classifier_version = projection_row.classifier_version AND
      base_set_row.algorithm_version = projection_row.allocation_algorithm_version AND
      NOT EXISTS (
        SELECT 1 FROM "public"."refund_reporting_correction_sets" successor
        WHERE successor.predecessor_correction_set_id = correction_row.id
      )
    ) IS TRUE) THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'administrative recovery state is stale';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'pale-orbit:financial:replay-enrollment', 0
    ));
    source_balance_transaction_id := base_set_row.balance_transaction_id;

    SELECT COALESCE(
      pg_catalog.array_agg(
        DISTINCT allocation_set.balance_transaction_id
        ORDER BY allocation_set.balance_transaction_id
      ), ARRAY[]::uuid[]
    ) INTO active_balance_transaction_ids
    FROM "public"."refunds" succeeded_refund
    JOIN "public"."financial_allocation_sets" allocation_set
      ON allocation_set.source_kind = 'refund'
     AND allocation_set.source_internal_id = succeeded_refund.id
     AND allocation_set.classifier_version = projection_row.classifier_version
     AND allocation_set.algorithm_version =
       projection_row.allocation_algorithm_version
     AND NOT EXISTS (
       SELECT 1 FROM "public"."financial_allocation_sets" successor
       WHERE successor.supersedes_set_id = allocation_set.id
     )
    WHERE succeeded_refund.payment_id = payment_row.id
      AND succeeded_refund.status = 'succeeded';
    IF NOT ((
      pg_catalog.cardinality(active_balance_transaction_ids)
        BETWEEN 1 AND 2147483647 AND
      source_balance_transaction_id = ANY(active_balance_transaction_ids) AND
      (
        SELECT pg_catalog.count(DISTINCT allocation_set.balance_transaction_id)
        FROM "public"."financial_allocation_sets" allocation_set
        WHERE allocation_set.source_kind = 'refund'
          AND allocation_set.source_internal_id = input_refund_id
          AND allocation_set.classifier_version = projection_row.classifier_version
          AND allocation_set.algorithm_version =
            projection_row.allocation_algorithm_version
          AND NOT EXISTS (
            SELECT 1 FROM "public"."financial_allocation_sets" successor
            WHERE successor.supersedes_set_id = allocation_set.id
          )
      ) = 1
    ) IS TRUE) THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'administrative recovery projection_incomplete';
    END IF;

    SELECT COALESCE(
      pg_catalog.array_agg(discovered_payout.id ORDER BY discovered_payout.id),
      ARRAY[]::uuid[]
    ), COALESCE(
      pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'payoutId', discovered_payout.id,
        'generation', discovered_payout.financial_generation
      ) ORDER BY discovered_payout.id), '[]'::jsonb
    )
    INTO payout_ids, discovered_payout_generations
    FROM (
      SELECT DISTINCT payout.id, payout.financial_generation
      FROM "public"."stripe_payout_balance_transactions" membership
      JOIN "public"."stripe_payouts" payout ON payout.id = membership.payout_id
      WHERE membership.balance_transaction_id =
        ANY(active_balance_transaction_ids)
    ) discovered_payout;
    SELECT COALESCE(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'payoutId', membership.payout_id,
        'balanceTransactionId', membership.balance_transaction_id
      ) ORDER BY membership.payout_id, membership.balance_transaction_id
    ), '[]'::jsonb)
    INTO discovered_financial_memberships
    FROM "public"."stripe_payout_balance_transactions" membership
    WHERE membership.balance_transaction_id = ANY(active_balance_transaction_ids)
      OR membership.payout_id = ANY(payout_ids);

    FOREACH lock_id IN ARRAY payout_ids LOOP
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'pale-orbit:financial:payout:' || lock_id::text, 0
      ));
    END LOOP;
    PERFORM 1 FROM "public"."stripe_payouts" payout
    WHERE payout.id = ANY(payout_ids)
    ORDER BY payout.id FOR UPDATE;

    FOREACH lock_id IN ARRAY active_balance_transaction_ids LOOP
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'pale-orbit:financial:balance-transaction:' || lock_id::text, 0
      ));
    END LOOP;
    PERFORM 1 FROM "public"."stripe_balance_transactions" balance
    WHERE balance.id = ANY(active_balance_transaction_ids)
    ORDER BY balance.id FOR UPDATE;
    PERFORM 1 FROM "public"."stripe_payout_balance_transactions" membership
    WHERE membership.balance_transaction_id = ANY(active_balance_transaction_ids)
      OR membership.payout_id = ANY(payout_ids)
    ORDER BY membership.payout_id, membership.balance_transaction_id FOR UPDATE;

    SELECT COALESCE(
      pg_catalog.array_agg(
        DISTINCT allocation_set.balance_transaction_id
        ORDER BY allocation_set.balance_transaction_id
      ), ARRAY[]::uuid[]
    ) INTO rediscovered_balance_transaction_ids
    FROM "public"."refunds" succeeded_refund
    JOIN "public"."financial_allocation_sets" allocation_set
      ON allocation_set.source_kind = 'refund'
     AND allocation_set.source_internal_id = succeeded_refund.id
     AND allocation_set.classifier_version = projection_row.classifier_version
     AND allocation_set.algorithm_version =
       projection_row.allocation_algorithm_version
     AND NOT EXISTS (
       SELECT 1 FROM "public"."financial_allocation_sets" successor
       WHERE successor.supersedes_set_id = allocation_set.id
     )
    WHERE succeeded_refund.payment_id = payment_row.id
      AND succeeded_refund.status = 'succeeded';
    SELECT COALESCE(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'payoutId', payout.id, 'generation', payout.financial_generation
      ) ORDER BY payout.id
    ), '[]'::jsonb)
    INTO rediscovered_payout_generations
    FROM "public"."stripe_payouts" payout
    WHERE payout.id = ANY(payout_ids);
    SELECT COALESCE(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'payoutId', membership.payout_id,
        'balanceTransactionId', membership.balance_transaction_id
      ) ORDER BY membership.payout_id, membership.balance_transaction_id
    ), '[]'::jsonb)
    INTO rediscovered_financial_memberships
    FROM "public"."stripe_payout_balance_transactions" membership
    WHERE membership.balance_transaction_id = ANY(active_balance_transaction_ids)
      OR membership.payout_id = ANY(payout_ids);
    IF rediscovered_balance_transaction_ids IS DISTINCT FROM
        active_balance_transaction_ids OR
      rediscovered_payout_generations IS DISTINCT FROM
        discovered_payout_generations OR
      rediscovered_financial_memberships IS DISTINCT FROM
        discovered_financial_memberships OR
      EXISTS (
        SELECT 1
        FROM "public"."stripe_payout_balance_transactions" membership
        WHERE (
          membership.balance_transaction_id = ANY(active_balance_transaction_ids) OR
          membership.payout_id = ANY(payout_ids)
        ) AND (
          NOT membership.balance_transaction_id = ANY(active_balance_transaction_ids) OR
          NOT membership.payout_id = ANY(payout_ids)
        )
      ) OR EXISTS (
        SELECT 1 FROM "public"."stripe_payouts" payout
        WHERE payout.id = ANY(payout_ids)
          AND payout.financial_generation NOT BETWEEN 0 AND 2147483647
      ) THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'administrative recovery state is stale';
    END IF;

    SELECT * INTO source_balance_row
    FROM "public"."stripe_balance_transactions" balance
    WHERE balance.id = source_balance_transaction_id
      AND balance.id = ANY(active_balance_transaction_ids);
    PERFORM 1 FROM "public"."stripe_balance_transaction_fee_details" detail
    WHERE detail.balance_transaction_id = ANY(active_balance_transaction_ids)
    ORDER BY detail.balance_transaction_id, detail.ordinal FOR UPDATE;
    SELECT COALESCE(
      pg_catalog.array_agg(
        detail.id ORDER BY detail.balance_transaction_id, detail.ordinal
      ),
      ARRAY[]::uuid[]
    ) INTO fee_detail_ids
    FROM "public"."stripe_balance_transaction_fee_details" detail
    WHERE detail.balance_transaction_id = ANY(active_balance_transaction_ids);

    FOREACH lock_id IN ARRAY active_balance_transaction_ids LOOP
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'pale-orbit:financial:classification:balance_transaction:' ||
          lock_id::text, 0
      ));
    END LOOP;
    FOREACH lock_id IN ARRAY fee_detail_ids LOOP
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'pale-orbit:financial:classification:fee_detail:' || lock_id::text, 0
      ));
    END LOOP;
    PERFORM 1 FROM "public"."financial_classification_versions" classification
    WHERE classification.classifier_version = projection_row.classifier_version
      AND (
        (classification.subject_type = 'balance_transaction' AND
          classification.subject_id = ANY(active_balance_transaction_ids)) OR
        (classification.subject_type = 'fee_detail' AND
          classification.subject_id = ANY(fee_detail_ids))
      )
    ORDER BY classification.subject_type, classification.subject_id,
      classification.classifier_version FOR UPDATE;

    FOREACH lock_id IN ARRAY active_balance_transaction_ids LOOP
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'pale-orbit:financial:allocation:' ||
          lock_id::text || ':gross_amount', 0
      ));
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'pale-orbit:financial:allocation:' || lock_id::text || ':fee', 0
      ));
    END LOOP;
    PERFORM 1 FROM "public"."financial_allocation_sets" allocation_set
    WHERE allocation_set.balance_transaction_id = ANY(active_balance_transaction_ids)
    ORDER BY allocation_set.balance_transaction_id, allocation_set.id FOR UPDATE;
    SELECT COALESCE(
      pg_catalog.array_agg(
        allocation_set.id ORDER BY allocation_set.balance_transaction_id,
          allocation_set.id
      ),
      ARRAY[]::uuid[]
    ) INTO allocation_set_ids
    FROM "public"."financial_allocation_sets" allocation_set
    WHERE allocation_set.balance_transaction_id = ANY(active_balance_transaction_ids);
    PERFORM 1 FROM "public"."financial_item_allocations" item
    WHERE item.allocation_set_id = ANY(allocation_set_ids)
    ORDER BY item.allocation_set_id, item.id FOR UPDATE;

    FOR financial_issue_lock_key IN
      WITH financial_issue_codes(safe_code) AS (
        VALUES ('allocation_fork'), ('allocation_incomplete'),
          ('allocation_mismatch'), ('classification_fork'),
          ('correction_rebase_required'), ('currency_mismatch'),
          ('generation_exhausted'), ('immutable_mismatch'), ('missing_source'),
          ('payout_incomplete'), ('payout_membership_conflict'),
          ('payout_reversal_incomplete'), ('source_linkage_mismatch'),
          ('unsupported_category')
      ), financial_issue_resources(resource_type, resource_id) AS (
        SELECT 'payment'::text, payment_row.id
        UNION SELECT 'refund', succeeded_refund.id
        FROM "public"."refunds" succeeded_refund
        WHERE succeeded_refund.payment_id = payment_row.id
          AND succeeded_refund.status = 'succeeded'
        UNION SELECT 'payout', payout_row.payout_id
          FROM pg_catalog.unnest(payout_ids) AS payout_row(payout_id)
        UNION SELECT 'balance_transaction', balance_row.balance_transaction_id
          FROM pg_catalog.unnest(active_balance_transaction_ids)
            AS balance_row(balance_transaction_id)
        UNION SELECT 'allocation_set', allocation_key.allocation_set_id
          FROM pg_catalog.unnest(allocation_set_ids)
            AS allocation_key(allocation_set_id)
        UNION SELECT 'correction_set', correction_key.correction_set_id
          FROM pg_catalog.unnest(correction_ids)
            AS correction_key(correction_set_id)
      ), financial_issue_lock_keys AS (
        SELECT resource.resource_type, resource.resource_id, code.safe_code
        FROM financial_issue_resources resource
        CROSS JOIN financial_issue_codes code
      )
      SELECT resource_type, resource_id, safe_code
      FROM financial_issue_lock_keys
      ORDER BY resource_type COLLATE "C", resource_id::text COLLATE "C",
        safe_code COLLATE "C"
    LOOP
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(
        'pale-orbit:financial:issue:' ||
          financial_issue_lock_key.resource_type || ':' ||
          financial_issue_lock_key.resource_id::text || ':' ||
          financial_issue_lock_key.safe_code
      ));
    END LOOP;
    PERFORM 1 FROM "public"."financial_reconciliation_issues" issue
    WHERE (issue.resource_type = 'payment' AND issue.resource_id = payment_row.id)
      OR (issue.resource_type = 'refund' AND issue.resource_id = ANY(refund_ids))
      OR (issue.resource_type = 'payout' AND issue.resource_id = ANY(payout_ids))
      OR (issue.resource_type = 'balance_transaction' AND
        issue.resource_id = ANY(active_balance_transaction_ids))
      OR (issue.resource_type = 'allocation_set' AND
        issue.resource_id = ANY(allocation_set_ids))
      OR (issue.resource_type = 'correction_set' AND
        issue.resource_id = ANY(correction_ids))
    ORDER BY issue.resource_type, issue.resource_id, issue.safe_code, issue.id
    FOR UPDATE;

    SELECT * INTO effect_row
    FROM "public"."refund_allocation_finalization_effects" effect
    WHERE effect.id = input_effect_id
      AND effect.refund_id = input_refund_id
      AND effect.order_item_id = input_order_item_id;
    SELECT * INTO allocation_row
    FROM "public"."refund_allocations" allocation
    WHERE allocation.id = effect_row.refund_allocation_id
      AND allocation.refund_id = effect_row.refund_id
      AND allocation.order_item_id = effect_row.order_item_id;
    SELECT * INTO correction_row
    FROM "public"."refund_reporting_correction_sets" correction
    WHERE correction.id = input_correction_id
      AND correction.refund_id = input_refund_id;
    SELECT * INTO base_set_row
    FROM "public"."financial_allocation_sets" base_set
    WHERE base_set.id = correction_row.base_allocation_set_id;
    IF NOT ((
      effect_row.id = input_effect_id AND
      effect_row.refund_id = input_refund_id AND
      effect_row.order_item_id = input_order_item_id AND
      effect_row.transition = 'revoked_by_finalization' AND
      effect_row.before_purchase_grant_state <> 'revoked' AND
      effect_row.after_purchase_grant_state = 'revoked' AND
      allocation_row.id = effect_row.refund_allocation_id AND
      allocation_row.refund_id = effect_row.refund_id AND
      allocation_row.order_item_id = effect_row.order_item_id AND
      allocation_row.source = 'administrative' AND
      correction_row.id = input_correction_id AND
      correction_row.refund_id = input_refund_id AND
      correction_row.correction_version = input_correction_version AND
      correction_row.source_fingerprint_sha256 = input_source_fingerprint AND
      source_balance_row.id = source_balance_transaction_id AND
      source_balance_row.source_family = 'refund' AND
      source_balance_row.source_id = refund_row.stripe_refund_id AND
      source_balance_row.fingerprint_sha256 = input_source_fingerprint AND
      base_set_row.balance_transaction_id = source_balance_transaction_id AND
      base_set_row.source_fingerprint_sha256 = source_balance_row.fingerprint_sha256 AND
      NOT EXISTS (
        SELECT 1 FROM "public"."financial_allocation_sets" successor
        WHERE successor.supersedes_set_id = base_set_row.id
      )
    ) IS TRUE) THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'administrative recovery state is stale';
    END IF;

    SELECT candidate.user_id, candidate.title_id
    INTO discovered_user_id, discovered_title_id
    FROM "public"."entitlement_grants" candidate
    WHERE candidate.id = effect_row.purchase_grant_id
      AND candidate.order_item_id = effect_row.order_item_id
      AND candidate.source = 'purchase';
    IF discovered_user_id IS NULL OR discovered_title_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'administrative recovery is not eligible';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "public"."entitlement_grants" candidate
      WHERE (
        candidate.id = effect_row.purchase_grant_id OR
        (
          candidate.source = 'administrative' AND
          candidate.recovery_refund_allocation_id = allocation_row.id
        )
      ) AND (candidate.user_id IS NULL OR candidate.title_id IS NULL)
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'administrative recovery is not eligible';
    END IF;
    FOR entitlement_scope IN
      WITH candidate_entitlement_scopes AS (
        SELECT DISTINCT candidate.user_id, candidate.title_id
        FROM "public"."entitlement_grants" candidate
        WHERE candidate.id = effect_row.purchase_grant_id OR
          (
            candidate.source = 'administrative' AND
            candidate.recovery_refund_allocation_id = allocation_row.id
          )
      )
      SELECT scope.user_id, scope.title_id
      FROM candidate_entitlement_scopes scope
      ORDER BY scope.user_id::text COLLATE "C", scope.title_id::text COLLATE "C"
    LOOP
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'pale-orbit:commerce:entitlement:' || entitlement_scope.user_id::text ||
          ':' || entitlement_scope.title_id::text, 0
      ));
    END LOOP;
    PERFORM 1 FROM "public"."entitlement_grants" candidate
    WHERE candidate.id = effect_row.purchase_grant_id OR
      (
        candidate.source = 'administrative' AND
        candidate.recovery_refund_allocation_id = allocation_row.id
      ) OR EXISTS (
        SELECT 1 FROM "public"."entitlement_grants" scoped_candidate
        WHERE (
          scoped_candidate.id = effect_row.purchase_grant_id OR
          (
            scoped_candidate.source = 'administrative' AND
            scoped_candidate.recovery_refund_allocation_id = allocation_row.id
          )
        ) AND scoped_candidate.user_id = candidate.user_id
          AND scoped_candidate.title_id = candidate.title_id
      )
    ORDER BY candidate.id FOR UPDATE;
    SELECT * INTO purchase_row
    FROM "public"."entitlement_grants" purchase
    WHERE purchase.id = effect_row.purchase_grant_id
      AND purchase.order_item_id = effect_row.order_item_id;
    SELECT * INTO recovery_row
    FROM "public"."entitlement_grants" recovery
    WHERE recovery.source = 'administrative'
      AND recovery.recovery_refund_allocation_id = allocation_row.id;

    IF NOT ((
      purchase_row.id = effect_row.purchase_grant_id AND
      purchase_row.source = 'purchase' AND
      purchase_row.state = effect_row.after_purchase_grant_state AND
      purchase_row.state = 'revoked' AND
      purchase_row.user_id = discovered_user_id AND
      purchase_row.title_id = order_item_row.title_id AND
      purchase_row.title_id = discovered_title_id AND
      (
        recovery_row.id IS NULL OR (
          recovery_row.source = 'administrative' AND
          recovery_row.state = 'revoked' AND
          recovery_row.state_reason = 'refund_allocation_recovery' AND
          recovery_row.order_item_id IS NULL AND
          recovery_row.user_id = purchase_row.user_id AND
          recovery_row.title_id = purchase_row.title_id AND
          recovery_row.recovery_refund_allocation_id = allocation_row.id AND
          recovery_row.updated_at =
            pg_catalog.date_trunc('milliseconds', recovery_row.updated_at)
        )
      )
    ) IS TRUE) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'administrative recovery is not eligible';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM "public"."refunds" candidate
      WHERE candidate.payment_id = payment_row.id
        AND candidate.status = 'succeeded'
        AND (
          candidate.allocation_status <> 'finalized' OR
          candidate.financial_evidence_status = 'exception' OR
          EXISTS (
            SELECT 1 FROM "public"."refund_allocation_drafts" active_draft
            WHERE active_draft.refund_id = candidate.id
              AND active_draft.state = 'active'
          ) OR
          (
            SELECT COALESCE(
              pg_catalog.sum(allocation.amount_minor::bigint), 0::numeric
            )::bigint
            FROM "public"."refund_allocations" allocation
            WHERE allocation.refund_id = candidate.id
          ) <> candidate.amount_minor::bigint OR
          EXISTS (
            SELECT 1
            FROM "public"."refund_allocations" allocation
            LEFT JOIN "public"."order_items" allocation_order_item
              ON allocation_order_item.id = allocation.order_item_id
            LEFT JOIN "public"."refund_allocation_components" allocation_component
              ON allocation_component.refund_allocation_id = allocation.id
             AND allocation_component.refund_id = allocation.refund_id
             AND allocation_component.order_item_id = allocation.order_item_id
            WHERE allocation.refund_id = candidate.id
              AND (
                allocation_order_item.order_id IS DISTINCT FROM order_row.id OR
                allocation.amount_minor NOT BETWEEN 0 AND 99999999 OR
                allocation_component.refund_allocation_id IS NULL OR
                allocation_component.total_minor IS DISTINCT FROM
                  allocation.amount_minor OR
                allocation_component.total_minor IS DISTINCT FROM
                  allocation_component.subtotal_minor + allocation_component.tax_minor OR
                allocation_component.currency IS DISTINCT FROM candidate.currency OR
                allocation_component.currency IS DISTINCT FROM
                  allocation_order_item.currency OR
                allocation_component.subtotal_minor NOT BETWEEN 0 AND
                  allocation_order_item.unit_subtotal_minor OR
                allocation_component.tax_minor NOT BETWEEN 0 AND
                  allocation_order_item.tax_minor OR
                allocation_component.total_minor NOT BETWEEN 0 AND
                  allocation_order_item.total_minor OR
                (
                  SELECT pg_catalog.count(*)
                  FROM "public"."refund_allocation_components" component
                  WHERE component.refund_allocation_id = allocation.id
                    AND component.refund_id = allocation.refund_id
                    AND component.order_item_id = allocation.order_item_id
                    AND component.total_minor = allocation.amount_minor
                    AND component.currency = candidate.currency
                ) <> 1
              )
          )
        )
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'administrative recovery projection_incomplete';
    END IF;

    WITH target_heads AS MATERIALIZED (
      SELECT projection_head.balance_transaction_id, projection_head.basis,
        projection_head.base_set_id, projection_head.compatible_correction_tip_id,
        projection_head.scope, projection_head.currency,
        projection_head.expected_effect_minor, projection_head.is_complete,
        projection_head.missing_source_count, projection_head.proposed_issue_code,
        allocation_set.source_kind, allocation_set.source_internal_id,
        allocation_set.classifier_version, allocation_set.algorithm_version,
        allocation_set.source_fingerprint_sha256
      FROM "public"."current_financial_projection_heads" projection_head
      JOIN "public"."financial_allocation_sets" allocation_set
        ON allocation_set.id = projection_head.base_set_id
      WHERE projection_head.balance_transaction_id = source_balance_transaction_id
    ), serialized_heads AS (
      SELECT target_head.*,
        CASE WHEN (
          target_head.basis IN ('gross_amount','fee') AND
          target_head.base_set_id IS NOT NULL AND
          target_head.compatible_correction_tip_id = correction_row.id AND
          target_head.scope IN ('title','account') AND
          target_head.currency ~ '^[A-Z]{3}$' AND
          target_head.expected_effect_minor BETWEEN -99999999 AND 99999999 AND
          target_head.is_complete AND target_head.missing_source_count = 0 AND
          target_head.proposed_issue_code IS NULL AND
          target_head.source_kind = 'refund' AND
          target_head.source_internal_id = input_refund_id AND
          target_head.classifier_version = projection_row.classifier_version AND
          target_head.algorithm_version = projection_row.allocation_algorithm_version AND
          target_head.source_fingerprint_sha256 = input_source_fingerprint
        ) IS TRUE THEN
          'projection_head=' || target_head.basis::text || '|' ||
          target_head.base_set_id::text || '|' ||
          target_head.compatible_correction_tip_id::text || '|' ||
          target_head.scope::text || '|' || target_head.currency || '|' ||
          target_head.expected_effect_minor::text || '|1|0|-'
        ELSE NULL END AS serialized_line
      FROM target_heads target_head
    )
    SELECT pg_catalog.count(*),
      pg_catalog.count(DISTINCT basis),
      pg_catalog.count(serialized_line),
      pg_catalog.bool_and(serialized_line IS NOT NULL),
      pg_catalog.string_agg(
        serialized_line, E'\n' ORDER BY
          CASE basis WHEN 'gross_amount' THEN 1 WHEN 'fee' THEN 2 ELSE 3 END
      )
    INTO projection_head_count, projection_head_distinct_basis_count,
      projection_head_serialized_count, projection_heads_valid,
      projection_head_lines
    FROM serialized_heads;
    IF NOT ((
      projection_head_count = 2 AND
      projection_head_distinct_basis_count = 2 AND
      projection_head_serialized_count = 2 AND projection_heads_valid AND
      projection_head_lines IS NOT NULL
    ) IS TRUE) THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'administrative recovery projection_incomplete';
    END IF;

    WITH target_items AS MATERIALIZED (
      SELECT projection_item.balance_transaction_id, projection_item.basis,
        projection_item.base_set_id,
        projection_item.compatible_correction_tip_id,
        projection_item.order_item_id, projection_item.component,
        projection_item.effect_minor, projection_item.currency,
        allocation_set.source_kind, allocation_set.source_internal_id,
        allocation_set.classifier_version, allocation_set.algorithm_version,
        allocation_set.source_fingerprint_sha256
      FROM "public"."current_financial_projection_items" projection_item
      JOIN "public"."financial_allocation_sets" allocation_set
        ON allocation_set.id = projection_item.base_set_id
      WHERE projection_item.balance_transaction_id = source_balance_transaction_id
    ), serialized_items AS (
      SELECT target_item.*,
        CASE WHEN (
          target_item.basis IN ('gross_amount','fee') AND
          target_item.base_set_id IS NOT NULL AND
          target_item.compatible_correction_tip_id = correction_row.id AND
          target_item.order_item_id IS NOT NULL AND
          target_item.component IN (
            'refund_subtotal','refund_tax','refund_fee'
          ) AND
          target_item.effect_minor BETWEEN -99999999 AND 99999999 AND
          target_item.currency ~ '^[A-Z]{3}$' AND
          target_item.source_kind = 'refund' AND
          target_item.source_internal_id = input_refund_id AND
          target_item.classifier_version = projection_row.classifier_version AND
          target_item.algorithm_version = projection_row.allocation_algorithm_version AND
          target_item.source_fingerprint_sha256 = input_source_fingerprint
        ) IS TRUE THEN
          'projection_item=' || target_item.basis::text || '|' ||
          target_item.base_set_id::text || '|' ||
          target_item.compatible_correction_tip_id::text || '|' ||
          target_item.order_item_id::text || '|' ||
          target_item.component::text || '|' ||
          target_item.effect_minor::text || '|' || target_item.currency
        ELSE NULL END AS serialized_line
      FROM target_items target_item
    )
    SELECT pg_catalog.count(*),
      pg_catalog.count(DISTINCT ROW(
        basis, base_set_id, compatible_correction_tip_id, order_item_id,
        component, effect_minor, currency
      )),
      pg_catalog.count(serialized_line),
      pg_catalog.bool_and(serialized_line IS NOT NULL),
      pg_catalog.string_agg(
        serialized_line, E'\n' ORDER BY
          CASE basis WHEN 'gross_amount' THEN 1 WHEN 'fee' THEN 2 ELSE 3 END,
          order_item_id::text COLLATE "C",
          CASE component
            WHEN 'refund_subtotal' THEN 1
            WHEN 'refund_tax' THEN 2
            WHEN 'refund_fee' THEN 3
            ELSE 4
          END,
          currency COLLATE "C", effect_minor
      )
    INTO projection_item_count, projection_item_distinct_count,
      projection_item_serialized_count, projection_items_valid,
      projection_item_lines
    FROM serialized_items;
    IF NOT ((
      projection_item_count = projection_item_distinct_count AND
      projection_item_count = projection_item_serialized_count AND
      (projection_item_count = 0 OR projection_items_valid)
    ) IS TRUE) THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'administrative recovery projection_incomplete';
    END IF;

    WITH succeeded_refunds AS MATERIALIZED (
      SELECT candidate.id, candidate.amount_minor, candidate.currency
      FROM "public"."refunds" candidate
      WHERE candidate.payment_id = payment_row.id
        AND candidate.status = 'succeeded'
    ), active_head_rows AS MATERIALIZED (
      SELECT succeeded_refund.id AS refund_id,
        projection_head.balance_transaction_id, projection_head.basis,
        projection_head.base_set_id,
        projection_head.compatible_correction_tip_id,
        projection_head.is_complete, projection_head.missing_source_count,
        projection_head.proposed_issue_code,
        allocation_set.source_fingerprint_sha256
      FROM succeeded_refunds succeeded_refund
      JOIN "public"."financial_allocation_sets" allocation_set
        ON allocation_set.source_kind = 'refund'
       AND allocation_set.source_internal_id = succeeded_refund.id
       AND allocation_set.classifier_version = projection_row.classifier_version
       AND allocation_set.algorithm_version =
         projection_row.allocation_algorithm_version
       AND NOT EXISTS (
         SELECT 1 FROM "public"."financial_allocation_sets" successor
         WHERE successor.supersedes_set_id = allocation_set.id
       )
      JOIN "public"."current_financial_projection_heads" projection_head
        ON projection_head.balance_transaction_id =
             allocation_set.balance_transaction_id
       AND projection_head.basis = allocation_set.basis
       AND projection_head.base_set_id = allocation_set.id
    ), head_rollup AS MATERIALIZED (
      SELECT succeeded_refund.id AS refund_id,
        pg_catalog.count(active_head.refund_id) AS head_count,
        pg_catalog.count(DISTINCT active_head.basis) AS basis_count,
        pg_catalog.count(DISTINCT active_head.balance_transaction_id)
          AS balance_transaction_count,
        pg_catalog.count(DISTINCT active_head.base_set_id) AS base_set_count,
        pg_catalog.count(DISTINCT active_head.source_fingerprint_sha256)
          AS source_fingerprint_count,
        pg_catalog.max(active_head.source_fingerprint_sha256)
          AS source_fingerprint_sha256,
        pg_catalog.count(active_head.compatible_correction_tip_id) AS tip_count,
        pg_catalog.count(DISTINCT active_head.compatible_correction_tip_id)
          AS distinct_tip_count,
        CASE
          WHEN pg_catalog.count(active_head.compatible_correction_tip_id) = 2 AND
            pg_catalog.count(DISTINCT active_head.compatible_correction_tip_id) = 1
          THEN pg_catalog.max(
            active_head.compatible_correction_tip_id::text
          )::uuid
          ELSE NULL
        END AS correction_tip_id,
        pg_catalog.bool_and(
          active_head.is_complete AND
          active_head.missing_source_count = 0 AND
          active_head.proposed_issue_code IS NULL
        ) AS heads_complete
      FROM succeeded_refunds succeeded_refund
      LEFT JOIN active_head_rows active_head
        ON active_head.refund_id = succeeded_refund.id
      GROUP BY succeeded_refund.id
    ), evidence_context AS MATERIALIZED (
      SELECT succeeded_refund.id AS refund_id,
        component_domain.component, component_domain.component_rank,
        head_rollup.head_count, head_rollup.basis_count,
        head_rollup.balance_transaction_count, head_rollup.base_set_count,
        head_rollup.source_fingerprint_count,
        head_rollup.source_fingerprint_sha256,
        head_rollup.tip_count, head_rollup.distinct_tip_count,
        head_rollup.heads_complete,
        head_rollup.correction_tip_id,
        correction_tip.correction_version,
        (
          head_rollup.correction_tip_id IS NOT NULL AND EXISTS (
            SELECT 1
            FROM "public"."refund_reporting_correction_items" presentment_item
            WHERE presentment_item.correction_set_id =
                head_rollup.correction_tip_id
              AND presentment_item.domain = 'presentment'
          )
        ) AS uses_correction,
        base_allocation.id AS base_allocation_id,
        base_component.refund_allocation_id AS base_component_id,
        CASE component_domain.component
          WHEN 'refund_subtotal' THEN base_component.subtotal_minor::bigint
          WHEN 'refund_tax' THEN base_component.tax_minor::bigint
          ELSE NULL
        END AS base_amount_minor,
        base_component.currency AS base_currency,
        correction_candidate.candidate_count,
        correction_candidate.amount_minor AS correction_amount_minor,
        correction_candidate.currency_valid AS correction_currency_valid,
        succeeded_refund.currency AS refund_currency
      FROM succeeded_refunds succeeded_refund
      JOIN head_rollup ON head_rollup.refund_id = succeeded_refund.id
      CROSS JOIN (VALUES
        ('refund_subtotal'::"public"."financial_component", 1),
        ('refund_tax'::"public"."financial_component", 2)
      ) AS component_domain(component, component_rank)
      LEFT JOIN "public"."refund_reporting_correction_sets" correction_tip
        ON correction_tip.id = head_rollup.correction_tip_id
       AND correction_tip.refund_id = succeeded_refund.id
      LEFT JOIN "public"."refund_allocations" base_allocation
        ON base_allocation.refund_id = succeeded_refund.id
       AND base_allocation.order_item_id = order_item_row.id
      LEFT JOIN "public"."refund_allocation_components" base_component
        ON base_component.refund_allocation_id = base_allocation.id
       AND base_component.refund_id = base_allocation.refund_id
       AND base_component.order_item_id = base_allocation.order_item_id
      LEFT JOIN LATERAL (
        SELECT pg_catalog.count(*) AS candidate_count,
          COALESCE(
            pg_catalog.max(correction_item.approved_absolute_minor),
            0
          )::bigint AS amount_minor,
          COALESCE(
            pg_catalog.bool_and(
              correction_item.currency = order_item_row.currency
            ),
            true
          ) AS currency_valid
        FROM "public"."refund_reporting_correction_items" correction_item
        WHERE correction_item.correction_set_id =
            head_rollup.correction_tip_id
          AND correction_item.domain = 'presentment'
          AND correction_item.order_item_id = order_item_row.id
          AND correction_item.component = component_domain.component
      ) correction_candidate ON true
    ), resolved_evidence AS MATERIALIZED (
      SELECT evidence_context.*,
        CASE WHEN evidence_context.uses_correction
          THEN evidence_context.correction_amount_minor
          ELSE COALESCE(evidence_context.base_amount_minor, 0)
        END AS amount_minor,
        (
          evidence_context.refund_id IS NOT NULL AND
          evidence_context.component IN ('refund_subtotal','refund_tax') AND
          evidence_context.refund_currency = order_item_row.currency AND
          evidence_context.head_count = 2 AND
          evidence_context.basis_count = 2 AND
          evidence_context.balance_transaction_count = 1 AND
          evidence_context.base_set_count = 2 AND
          evidence_context.source_fingerprint_count = 1 AND
          evidence_context.heads_complete AND
          evidence_context.source_fingerprint_sha256 ~ '^[a-f0-9]{64}$' AND
          (
            (
              evidence_context.tip_count = 2 AND
              evidence_context.distinct_tip_count = 1 AND
              evidence_context.correction_tip_id IS NOT NULL AND
              evidence_context.correction_version BETWEEN 1 AND 2147483647 AND
              evidence_context.source_fingerprint_sha256 =
                (
                  SELECT tip.source_fingerprint_sha256
                  FROM "public"."refund_reporting_correction_sets" tip
                  WHERE tip.id = evidence_context.correction_tip_id
                    AND tip.refund_id = evidence_context.refund_id
                ) AND
              (
                evidence_context.refund_id <> input_refund_id OR
                evidence_context.correction_tip_id = input_correction_id
              )
            ) OR (
              evidence_context.refund_id <> input_refund_id AND
              evidence_context.tip_count = 0 AND
              evidence_context.distinct_tip_count = 0 AND
              evidence_context.correction_tip_id IS NULL AND
              evidence_context.correction_version IS NULL
            )
          ) AND
          (
            (
              evidence_context.uses_correction AND
              evidence_context.correction_tip_id IS NOT NULL AND
              evidence_context.correction_version BETWEEN 1 AND 2147483647 AND
              evidence_context.candidate_count BETWEEN 0 AND 1 AND
              evidence_context.correction_currency_valid AND
              evidence_context.correction_amount_minor BETWEEN 0 AND 99999999
            ) OR (
              NOT evidence_context.uses_correction AND
              (
                (
                  evidence_context.base_allocation_id IS NULL AND
                  evidence_context.base_component_id IS NULL AND
                  evidence_context.base_amount_minor IS NULL
                ) OR (
                  evidence_context.base_allocation_id IS NOT NULL AND
                  evidence_context.base_component_id =
                    evidence_context.base_allocation_id AND
                  evidence_context.base_currency = evidence_context.refund_currency AND
                  evidence_context.base_amount_minor BETWEEN 0 AND 99999999
                )
              )
            )
          )
        ) IS TRUE AS resolved
      FROM evidence_context
    ), serialized_evidence AS (
      SELECT resolved_evidence.*,
        CASE WHEN resolved_evidence.resolved THEN
          'presentment_evidence=' || resolved_evidence.refund_id::text || '|' ||
          CASE WHEN resolved_evidence.uses_correction
            THEN 'correction' ELSE 'base' END || '|' ||
          CASE WHEN resolved_evidence.uses_correction
            THEN '-' ELSE COALESCE(
              resolved_evidence.base_allocation_id::text, '-'
            ) END || '|' ||
          CASE WHEN resolved_evidence.uses_correction
            THEN resolved_evidence.correction_tip_id::text ELSE '-' END || '|' ||
          CASE WHEN resolved_evidence.uses_correction
            THEN resolved_evidence.correction_version::text ELSE '-' END || '|' ||
          resolved_evidence.component::text || '|' ||
          resolved_evidence.amount_minor::text
        ELSE NULL END AS serialized_line
      FROM resolved_evidence
    )
    SELECT
      (SELECT pg_catalog.count(*) FROM succeeded_refunds),
      pg_catalog.count(*),
      pg_catalog.count(*) FILTER (WHERE resolved),
      pg_catalog.count(serialized_line),
      pg_catalog.bool_and(resolved),
      pg_catalog.string_agg(
        serialized_line, E'\n' ORDER BY
          refund_id::text COLLATE "C", component_rank
      ),
      COALESCE(
        pg_catalog.sum(amount_minor) FILTER (
          WHERE component = 'refund_subtotal'
        ), 0::numeric
      )::bigint,
      COALESCE(
        pg_catalog.sum(amount_minor) FILTER (
          WHERE component = 'refund_tax'
        ), 0::numeric
      )::bigint
    INTO succeeded_refund_count, presentment_evidence_count,
      presentment_resolved_count, presentment_serialized_count,
      presentment_evidence_valid, presentment_evidence_lines,
      cumulative_refund_subtotal_minor, cumulative_refund_tax_minor
    FROM serialized_evidence;

    corrected_presentment_total :=
      cumulative_refund_subtotal_minor + cumulative_refund_tax_minor;
    remaining_unrefunded_minor :=
      order_item_row.total_minor::bigint - corrected_presentment_total;
    IF NOT ((
      succeeded_refund_count BETWEEN 1 AND 100 AND
      presentment_evidence_count = 2 * succeeded_refund_count AND
      presentment_resolved_count = presentment_evidence_count AND
      presentment_serialized_count = presentment_evidence_count AND
      presentment_evidence_valid AND presentment_evidence_lines IS NOT NULL AND
      cumulative_refund_subtotal_minor BETWEEN 0 AND
        order_item_row.unit_subtotal_minor::bigint AND
      cumulative_refund_tax_minor BETWEEN 0 AND
        order_item_row.tax_minor::bigint AND
      corrected_presentment_total =
        cumulative_refund_subtotal_minor + cumulative_refund_tax_minor AND
      corrected_presentment_total <= order_item_row.total_minor
    ) IS TRUE) THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'administrative recovery is not eligible';
    END IF;

    effective_access_before := EXISTS (
      SELECT 1 FROM "public"."entitlement_grants" effective_grant
      WHERE effective_grant.user_id = purchase_row.user_id
        AND effective_grant.title_id = purchase_row.title_id
        AND effective_grant.state = 'active'
    );
    effective_access_after := true;
    predicted_access_changed :=
      effective_access_before IS DISTINCT FROM effective_access_after;
    predicted_email_queued := predicted_access_changed;
    existing_recovery_state_changed_text := CASE
      WHEN recovery_row.id IS NULL THEN '-'
      ELSE pg_catalog.to_char(
        pg_catalog.timezone('UTC', recovery_row.updated_at),
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
    END;

    preview_preimage :=
      E'pale-orbit.admin-recovery-preview.v1\n' ||
      'refund_id=' || refund_row.id::text || E'\n' ||
      'payment_id=' || payment_row.id::text || E'\n' ||
      'order_id=' || order_row.id::text || E'\n' ||
      'finalization_effect_id=' || effect_row.id::text || E'\n' ||
      'recovery_reference_id=' || allocation_row.id::text || E'\n' ||
      'finalization_draft_id=' || effect_row.draft_id::text || E'\n' ||
      'finalization_draft_version=' || effect_row.draft_version::text || E'\n' ||
      'order_item_id=' || order_item_row.id::text || E'\n' ||
      'title_id=' || order_item_row.title_id::text || E'\n' ||
      'purchase_grant_id=' || purchase_row.id::text || E'\n' ||
      'allocation_total_minor=' || allocation_row.amount_minor::text || E'\n' ||
      'allocation_subtotal_minor=' ||
        allocation_component_row.subtotal_minor::text || E'\n' ||
      'allocation_tax_minor=' ||
        allocation_component_row.tax_minor::text || E'\n' ||
      'item_subtotal_minor=' || order_item_row.unit_subtotal_minor::text || E'\n' ||
      'item_tax_minor=' || order_item_row.tax_minor::text || E'\n' ||
      'item_total_minor=' || order_item_row.total_minor::text || E'\n' ||
      'item_currency=' || order_item_row.currency || E'\n' ||
      'existing_recovery_grant_id=' ||
        COALESCE(recovery_row.id::text, '-') || E'\n' ||
      'existing_recovery_grant_state=' ||
        CASE WHEN recovery_row.id IS NULL THEN 'absent' ELSE 'revoked' END || E'\n' ||
      'existing_recovery_grant_state_changed_at=' ||
        existing_recovery_state_changed_text || E'\n' ||
      'correction_set_id=' || correction_row.id::text || E'\n' ||
      'correction_version=' || correction_row.correction_version::text || E'\n' ||
      'correction_kind=' || correction_row.kind::text || E'\n' ||
      'correction_base_set_id=' || correction_row.base_allocation_set_id::text || E'\n' ||
      'correction_predecessor_correction_set_id=' ||
        COALESCE(
          correction_row.predecessor_correction_set_id::text, '-'
        ) || E'\n' ||
      'correction_source_fingerprint_sha256=' ||
        correction_row.source_fingerprint_sha256 || E'\n' ||
      'projection_classifier_version=' ||
        projection_row.classifier_version::text || E'\n' ||
      'projection_allocation_algorithm_version=' ||
        projection_row.allocation_algorithm_version::text || E'\n' ||
      'source_balance_transaction_id=' ||
        source_balance_transaction_id::text || E'\n' ||
      'source_fingerprint_sha256=' ||
        source_balance_row.fingerprint_sha256 || E'\n' ||
      'projection_head_count=2' || E'\n' ||
      projection_head_lines || E'\n' ||
      'projection_item_count=' || projection_item_count::text || E'\n' ||
      CASE WHEN projection_item_count = 0 THEN ''
        ELSE projection_item_lines || E'\n' END ||
      'presentment_evidence_count=' ||
        presentment_evidence_count::text || E'\n' ||
      presentment_evidence_lines || E'\n' ||
      'cumulative_refund_subtotal_minor=' ||
        cumulative_refund_subtotal_minor::text || E'\n' ||
      'cumulative_refund_tax_minor=' ||
        cumulative_refund_tax_minor::text || E'\n' ||
      'cumulative_refund_total_minor=' ||
        corrected_presentment_total::text || E'\n' ||
      'remaining_unrefunded_minor=' ||
        remaining_unrefunded_minor::text || E'\n' ||
      'effective_access_before=' ||
        CASE WHEN effective_access_before THEN '1' ELSE '0' END || E'\n' ||
      'effective_access_after=' ||
        CASE WHEN effective_access_after THEN '1' ELSE '0' END || E'\n' ||
      'access_changed=' ||
        CASE WHEN predicted_access_changed THEN '1' ELSE '0' END || E'\n' ||
      'email_queued=' ||
        CASE WHEN predicted_email_queued THEN '1' ELSE '0' END || E'\n';

    IF preview_preimage IS NULL OR
      preview_preimage !~ '^[\x00-\x7F]*$' THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'administrative recovery is not eligible';
    END IF;
    computed_preview_fingerprint := pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(preview_preimage, 'UTF8')
      ),
      'hex'
    );
    IF computed_preview_fingerprint IS DISTINCT FROM input_preview_fingerprint THEN
      RAISE EXCEPTION USING ERRCODE = '40001',
        MESSAGE = 'administrative recovery state is stale';
    END IF;

    IF corrected_presentment_total >= order_item_row.total_minor THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'administrative recovery is not eligible';
    END IF;

    transition_at :=
      pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
    IF recovery_row.id IS NULL THEN
      recovery_row.id := pg_catalog.gen_random_uuid();
      prior_state := NULL;
    ELSE
      prior_state := recovery_row.state;
      transition_at := GREATEST(
        transition_at,
        pg_catalog.date_trunc('milliseconds', recovery_row.updated_at) +
          interval '1 millisecond'
      );
    END IF;
    PERFORM pg_catalog.set_config(
      'pale_orbit.plan6bii_administrative_grant_command_id',
      locked_command_id::text, true
    );
    PERFORM pg_catalog.set_config(
      'pale_orbit.plan6bii_administrative_grant_job_id',
      command_job_id::text, true
    );
    PERFORM pg_catalog.set_config(
      'pale_orbit.plan6bii_administrative_grant_reference_id',
      allocation_row.id::text, true
    );
    IF prior_state IS NULL THEN
      INSERT INTO "public"."entitlement_grants" (
        id, title_id, user_id, source, order_item_id,
        recovery_refund_allocation_id, state, state_reason,
        granted_at, suspended_at, revoked_at, created_at, updated_at
      ) VALUES (
        recovery_row.id, purchase_row.title_id, purchase_row.user_id,
        'administrative', NULL, allocation_row.id, 'active',
        'refund_allocation_recovery', transition_at, NULL, NULL,
        transition_at, transition_at
      ) RETURNING * INTO recovery_row;
    ELSE
      UPDATE "public"."entitlement_grants"
      SET state = 'active', suspended_at = NULL, revoked_at = NULL,
        updated_at = transition_at
      WHERE id = recovery_row.id AND state = 'revoked'
      RETURNING * INTO recovery_row;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '55000',
          MESSAGE = 'administrative recovery is not eligible';
      END IF;
    END IF;

    INSERT INTO "public"."audit_events" (
      actor_type, actor_id, action, outcome, resource_type, resource_id,
      correlation_id, after
    ) VALUES (
      'user'::"public"."audit_actor_type", locked_actor_user_id::text,
      'financial.recovery_grant.activated', 'succeeded'::"public"."audit_outcome",
      'entitlement_grant', recovery_row.id::text, locked_correlation_id,
      pg_catalog.jsonb_build_object(
        'commandId', locked_command_id, 'recoveryGrantId', recovery_row.id,
        'state', recovery_row.state
      )
    );
    RETURN QUERY SELECT recovery_row.id, recovery_row.user_id, recovery_row.title_id,
      prior_state, recovery_row.state, recovery_row.updated_at;
    RETURN;
  END IF;

  IF NOT ((
    pg_catalog.jsonb_typeof(command_input) = 'object' AND
    command_input ?& ARRAY[
      'kind','recoveryGrantId','recoveryReferenceId',
      'expectedStateChangedAt','confirmation'
    ]::text[] AND
    command_input - 'kind' - 'recoveryGrantId' - 'recoveryReferenceId' -
      'expectedStateChangedAt' - 'confirmation' = '{}'::jsonb AND
    pg_catalog.jsonb_typeof(command_input -> 'kind') = 'string' AND
    command_input ->> 'kind' = 'administrative_recovery_deactivate' AND
    pg_catalog.jsonb_typeof(command_input -> 'recoveryGrantId') = 'string' AND
    CASE WHEN pg_catalog.pg_input_is_valid(
        command_input ->> 'recoveryGrantId', 'uuid'
      ) THEN (command_input ->> 'recoveryGrantId')::uuid::text =
        command_input ->> 'recoveryGrantId' ELSE false END AND
    pg_catalog.jsonb_typeof(command_input -> 'recoveryReferenceId') = 'string' AND
    CASE WHEN pg_catalog.pg_input_is_valid(
        command_input ->> 'recoveryReferenceId', 'uuid'
      ) THEN (command_input ->> 'recoveryReferenceId')::uuid::text =
        command_input ->> 'recoveryReferenceId' ELSE false END AND
    pg_catalog.jsonb_typeof(command_input -> 'expectedStateChangedAt') = 'string' AND
    command_input ->> 'expectedStateChangedAt' ~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' AND
    pg_catalog.pg_input_is_valid(
      command_input ->> 'expectedStateChangedAt', 'timestamp with time zone'
    ) AND
    pg_catalog.jsonb_typeof(command_input -> 'confirmation') = 'string' AND
    command_input ->> 'confirmation' = 'deactivate_persistent_recovery'
  ) IS TRUE) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'invalid administrative recovery command';
  END IF;
  input_recovery_grant_id := (command_input ->> 'recoveryGrantId')::uuid;
  input_recovery_reference_id :=
    (command_input ->> 'recoveryReferenceId')::uuid;
  input_expected_state_changed_at :=
    (command_input ->> 'expectedStateChangedAt')::timestamptz;
  IF input_expected_state_changed_at IS DISTINCT FROM
      pg_catalog.date_trunc('milliseconds', input_expected_state_changed_at) OR
    pg_catalog.to_char(
      pg_catalog.timezone('UTC', input_expected_state_changed_at),
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ) IS DISTINCT FROM command_input ->> 'expectedStateChangedAt' THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'invalid administrative recovery command';
  END IF;

  SELECT effect.id, effect.purchase_grant_id, effect.order_item_id,
    refund.payment_id, payment.order_id, recovery.user_id, recovery.title_id
  INTO discovered_effect_id, discovered_purchase_grant_id,
    discovered_order_item_id, discovered_payment_id, discovered_order_id,
    discovered_user_id, discovered_title_id
  FROM "public"."entitlement_grants" recovery
  JOIN "public"."refund_allocations" allocation
    ON allocation.id = recovery.recovery_refund_allocation_id
  JOIN "public"."refund_allocation_finalization_effects" effect
    ON effect.refund_allocation_id = allocation.id
   AND effect.transition = 'revoked_by_finalization'
  JOIN "public"."refunds" refund ON refund.id = allocation.refund_id
  JOIN "public"."payments" payment ON payment.id = refund.payment_id
  WHERE recovery.id = input_recovery_grant_id
    AND recovery.recovery_refund_allocation_id = input_recovery_reference_id;
  IF NOT FOUND OR discovered_user_id IS NULL OR discovered_title_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'administrative recovery state is stale';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'pale-orbit:commerce:order:' || discovered_order_id::text, 0
  ));
  SELECT * INTO order_row FROM "public"."orders" purchase_order
  WHERE purchase_order.id = discovered_order_id FOR UPDATE;
  SELECT * INTO payment_row FROM "public"."payments" payment
  WHERE payment.id = discovered_payment_id
    AND payment.order_id = discovered_order_id FOR UPDATE;
  IF order_row.id IS NULL OR payment_row.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'administrative recovery state is stale';
  END IF;

  PERFORM 1 FROM "public"."refunds" candidate
  WHERE candidate.payment_id = payment_row.id ORDER BY candidate.id FOR UPDATE;
  SELECT COALESCE(
    pg_catalog.array_agg(candidate.id ORDER BY candidate.id), ARRAY[]::uuid[]
  ) INTO refund_ids FROM "public"."refunds" candidate
  WHERE candidate.payment_id = payment_row.id;
  PERFORM 1 FROM "public"."refund_allocation_drafts" candidate
  WHERE candidate.refund_id = ANY(refund_ids) ORDER BY candidate.id FOR UPDATE;
  SELECT COALESCE(
    pg_catalog.array_agg(candidate.id ORDER BY candidate.id), ARRAY[]::uuid[]
  ) INTO draft_ids FROM "public"."refund_allocation_drafts" candidate
  WHERE candidate.refund_id = ANY(refund_ids);
  PERFORM 1 FROM "public"."refund_allocation_draft_items" candidate
  WHERE candidate.draft_id = ANY(draft_ids) ORDER BY candidate.id FOR UPDATE;
  PERFORM 1 FROM "public"."refund_allocations" candidate
  WHERE candidate.refund_id = ANY(refund_ids) ORDER BY candidate.id FOR UPDATE;
  PERFORM 1 FROM "public"."refund_allocation_components" candidate
  WHERE candidate.refund_id = ANY(refund_ids) ORDER BY candidate.id FOR UPDATE;
  PERFORM 1 FROM "public"."refund_reporting_correction_sets" candidate
  WHERE candidate.refund_id = ANY(refund_ids) ORDER BY candidate.id FOR UPDATE;
  SELECT COALESCE(
    pg_catalog.array_agg(candidate.id ORDER BY candidate.id), ARRAY[]::uuid[]
  ) INTO correction_ids FROM "public"."refund_reporting_correction_sets" candidate
  WHERE candidate.refund_id = ANY(refund_ids);
  PERFORM 1 FROM "public"."refund_reporting_correction_items" candidate
  WHERE candidate.correction_set_id = ANY(correction_ids)
  ORDER BY candidate.id FOR UPDATE;
  PERFORM 1 FROM "public"."disputes" candidate
  WHERE candidate.payment_id = payment_row.id ORDER BY candidate.id FOR UPDATE;
  SELECT COALESCE(
    pg_catalog.array_agg(candidate.id ORDER BY candidate.id), ARRAY[]::uuid[]
  ) INTO dispute_ids FROM "public"."disputes" candidate
  WHERE candidate.payment_id = payment_row.id;
  PERFORM 1 FROM "public"."dispute_item_allocations" candidate
  WHERE candidate.dispute_id = ANY(dispute_ids) ORDER BY candidate.id FOR UPDATE;
  PERFORM 1 FROM "public"."order_items" candidate
  WHERE candidate.order_id = order_row.id ORDER BY candidate.id FOR UPDATE;
  SELECT pg_catalog.count(*),
    COALESCE(pg_catalog.sum(candidate.total_minor::bigint), 0),
    pg_catalog.bool_and(
      candidate.currency = order_row.currency AND
      candidate.currency = payment_row.currency AND
      candidate.tax_minor IS NOT NULL AND candidate.total_minor IS NOT NULL AND
      candidate.unit_subtotal_minor BETWEEN 0 AND 99999999 AND
      candidate.tax_minor BETWEEN 0 AND 99999999 AND
      candidate.total_minor BETWEEN 0 AND 99999999 AND
      candidate.total_minor = candidate.unit_subtotal_minor + candidate.tax_minor
    )
  INTO purchase_order_item_count, purchase_order_item_total_minor,
    purchase_order_items_valid
  FROM "public"."order_items" candidate
  WHERE candidate.order_id = order_row.id;
  IF NOT ((
    purchase_order_item_count BETWEEN 1 AND 2147483647 AND
    purchase_order_items_valid AND
    purchase_order_item_total_minor = payment_row.amount_minor::bigint AND
    payment_row.amount_minor = order_row.total_minor AND
    payment_row.currency = order_row.currency
  ) IS TRUE) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'administrative recovery purchase graph is invalid';
  END IF;

  SELECT * INTO effect_row
  FROM "public"."refund_allocation_finalization_effects" effect
  WHERE effect.id = discovered_effect_id
    AND effect.purchase_grant_id = discovered_purchase_grant_id
    AND effect.order_item_id = discovered_order_item_id
    AND effect.refund_allocation_id = input_recovery_reference_id;
  SELECT * INTO allocation_row
  FROM "public"."refund_allocations" allocation
  WHERE allocation.id = input_recovery_reference_id
    AND allocation.refund_id = effect_row.refund_id
    AND allocation.order_item_id = effect_row.order_item_id;
  IF effect_row.id IS NULL OR allocation_row.id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'administrative recovery state is stale';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "public"."entitlement_grants" candidate
    WHERE (
      candidate.id IN (input_recovery_grant_id, discovered_purchase_grant_id) OR
      (
        candidate.source = 'administrative' AND
        candidate.recovery_refund_allocation_id = input_recovery_reference_id
      )
    ) AND (candidate.user_id IS NULL OR candidate.title_id IS NULL)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'administrative recovery state is stale';
  END IF;
  FOR entitlement_scope IN
    WITH candidate_entitlement_scopes AS (
      SELECT DISTINCT candidate.user_id, candidate.title_id
      FROM "public"."entitlement_grants" candidate
      WHERE candidate.id IN (
        input_recovery_grant_id, discovered_purchase_grant_id
      ) OR (
        candidate.source = 'administrative' AND
        candidate.recovery_refund_allocation_id = input_recovery_reference_id
      )
    )
    SELECT scope.user_id, scope.title_id
    FROM candidate_entitlement_scopes scope
    ORDER BY scope.user_id::text COLLATE "C", scope.title_id::text COLLATE "C"
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'pale-orbit:commerce:entitlement:' || entitlement_scope.user_id::text ||
        ':' || entitlement_scope.title_id::text, 0
    ));
  END LOOP;
  PERFORM 1 FROM "public"."entitlement_grants" candidate
  WHERE candidate.id IN (
    input_recovery_grant_id, discovered_purchase_grant_id
  ) OR (
    candidate.source = 'administrative' AND
    candidate.recovery_refund_allocation_id = input_recovery_reference_id
  ) OR EXISTS (
    SELECT 1 FROM "public"."entitlement_grants" scoped_candidate
    WHERE (
      scoped_candidate.id IN (
        input_recovery_grant_id, discovered_purchase_grant_id
      ) OR (
        scoped_candidate.source = 'administrative' AND
        scoped_candidate.recovery_refund_allocation_id =
          input_recovery_reference_id
      )
    ) AND scoped_candidate.user_id = candidate.user_id
      AND scoped_candidate.title_id = candidate.title_id
  )
  ORDER BY candidate.id FOR UPDATE;
  SELECT * INTO recovery_row
  FROM "public"."entitlement_grants" recovery
  WHERE recovery.id = input_recovery_grant_id;
  SELECT * INTO purchase_row
  FROM "public"."entitlement_grants" purchase
  WHERE purchase.id = discovered_purchase_grant_id
    AND purchase.order_item_id = discovered_order_item_id;

  IF NOT ((
    order_row.status = 'paid' AND payment_row.status = 'succeeded' AND
    (
      SELECT pg_catalog.count(*)
      FROM "public"."refund_allocation_finalization_effects" exact_effect
      WHERE exact_effect.refund_allocation_id = input_recovery_reference_id
        AND exact_effect.transition = 'revoked_by_finalization'
        AND exact_effect.purchase_grant_id = discovered_purchase_grant_id
        AND exact_effect.order_item_id = discovered_order_item_id
    ) = 1 AND
    effect_row.id = discovered_effect_id AND
    effect_row.transition = 'revoked_by_finalization' AND
    effect_row.refund_allocation_id = input_recovery_reference_id AND
    effect_row.purchase_grant_id = discovered_purchase_grant_id AND
    effect_row.order_item_id = discovered_order_item_id AND
    allocation_row.source = 'administrative' AND
    allocation_row.id = input_recovery_reference_id AND
    allocation_row.order_item_id = discovered_order_item_id AND
    EXISTS (
      SELECT 1 FROM "public"."order_items" exact_item
      WHERE exact_item.id = allocation_row.order_item_id
        AND exact_item.order_id = order_row.id
    ) AND
    recovery_row.id = input_recovery_grant_id AND
    recovery_row.source = 'administrative' AND
    recovery_row.state = 'active' AND
    recovery_row.state_reason = 'refund_allocation_recovery' AND
    recovery_row.order_item_id IS NULL AND
    recovery_row.user_id = discovered_user_id AND
    recovery_row.title_id = discovered_title_id AND
    recovery_row.recovery_refund_allocation_id = input_recovery_reference_id AND
    recovery_row.updated_at = input_expected_state_changed_at AND
    recovery_row.updated_at =
      pg_catalog.date_trunc('milliseconds', recovery_row.updated_at) AND
    purchase_row.id = discovered_purchase_grant_id AND
    purchase_row.source = 'purchase' AND
    purchase_row.user_id = recovery_row.user_id AND
    purchase_row.title_id = recovery_row.title_id
  ) IS TRUE) THEN
    RAISE EXCEPTION USING ERRCODE = '40001',
      MESSAGE = 'administrative recovery state is stale';
  END IF;

  transition_at := GREATEST(
    pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp()),
    pg_catalog.date_trunc('milliseconds', recovery_row.updated_at) +
      interval '1 millisecond'
  );
  prior_state := recovery_row.state;
  PERFORM pg_catalog.set_config(
    'pale_orbit.plan6bii_administrative_grant_command_id',
    locked_command_id::text, true
  );
  PERFORM pg_catalog.set_config(
    'pale_orbit.plan6bii_administrative_grant_job_id',
    command_job_id::text, true
  );
  PERFORM pg_catalog.set_config(
    'pale_orbit.plan6bii_administrative_grant_reference_id',
    allocation_row.id::text, true
  );
  UPDATE "public"."entitlement_grants"
  SET state = 'revoked', revoked_at = transition_at, updated_at = transition_at
  WHERE id = recovery_row.id AND state = 'active'
  RETURNING * INTO recovery_row;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'administrative recovery is not eligible';
  END IF;

  INSERT INTO "public"."audit_events" (
    actor_type, actor_id, action, outcome, resource_type, resource_id,
    correlation_id, after
  ) VALUES (
    'user'::"public"."audit_actor_type", locked_actor_user_id::text,
    'financial.recovery_grant.deactivated', 'succeeded'::"public"."audit_outcome",
    'entitlement_grant', recovery_row.id::text, locked_correlation_id,
    pg_catalog.jsonb_build_object(
      'commandId', locked_command_id, 'recoveryGrantId', recovery_row.id,
      'state', recovery_row.state
    )
  );
  RETURN QUERY SELECT recovery_row.id, recovery_row.user_id, recovery_row.title_id,
    prior_state, recovery_row.state, recovery_row.updated_at;
END;
$administrative_recovery$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."transition_administrative_recovery_grant_after_admin_command"(uuid) FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
REVOKE SELECT ON TABLE "public"."jobs" FROM "pale_orbit_runtime";--> statement-breakpoint
GRANT SELECT ("id", "deduplication_key") ON TABLE "public"."jobs" TO "pale_orbit_runtime";--> statement-breakpoint
GRANT SELECT ON TABLE "public"."jobs" TO "pale_orbit_financial_worker";--> statement-breakpoint
REVOKE ALL ON TABLE "public"."financial_admin_commands" FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
GRANT SELECT ON TABLE "public"."financial_admin_commands" TO "pale_orbit_financial_worker";--> statement-breakpoint
GRANT UPDATE ("status", "safe_result_code", "safe_result", "updated_at", "completed_at")
ON TABLE "public"."financial_admin_commands" TO "pale_orbit_financial_worker";--> statement-breakpoint
REVOKE ALL ON TABLE "public"."financial_admin_job_claims" FROM PUBLIC, "pale_orbit_runtime", "pale_orbit_financial_worker", "pale_orbit_storage_cleanup";--> statement-breakpoint
REVOKE UPDATE ("id") ON TABLE "public"."refund_allocation_drafts"
FROM "pale_orbit_financial_worker";--> statement-breakpoint
REVOKE UPDATE ("id") ON TABLE "public"."refund_allocation_draft_items"
FROM "pale_orbit_financial_worker";--> statement-breakpoint
GRANT INSERT ON TABLE
  "public"."refund_allocation_drafts",
  "public"."refund_allocation_draft_items",
  "public"."refund_allocation_finalization_effects"
TO "pale_orbit_financial_worker";--> statement-breakpoint
GRANT UPDATE (
  "state", "version", "updated_by_admin_id", "updated_correlation_id",
  "updated_at", "finalized_at", "discarded_at"
) ON TABLE "public"."refund_allocation_drafts"
TO "pale_orbit_financial_worker";--> statement-breakpoint
GRANT UPDATE ("proposed_total_presentment_minor", "updated_at")
ON TABLE "public"."refund_allocation_draft_items"
TO "pale_orbit_financial_worker";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."submit_financial_admin_command"(uuid,text,text,text,text,jsonb) TO "pale_orbit_runtime";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."financial_admin_command_status"(uuid,uuid) TO "pale_orbit_runtime";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."append_financial_issue_view_audit"(uuid,uuid,text,text,text) TO "pale_orbit_runtime";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."append_financial_refund_review_view_audit"(uuid,uuid,text,text,text) TO "pale_orbit_runtime";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."append_financial_payout_view_audit"(uuid,uuid,text,text,text) TO "pale_orbit_runtime";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."append_financial_sales_export_audit"(uuid,text,text,integer,integer,integer,text,text) TO "pale_orbit_runtime";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."resolve_financial_issue_after_admin_command"(uuid,uuid) TO "pale_orbit_financial_worker";--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."transition_administrative_recovery_grant_after_admin_command"(uuid) TO "pale_orbit_financial_worker";--> statement-breakpoint
DO $plan6bii_postflight$
DECLARE
  database_owner oid;
BEGIN
  SELECT database_row.datdba INTO database_owner
  FROM pg_catalog.pg_database database_row
  WHERE database_row.datname = pg_catalog.current_database();
  IF EXISTS (
    WITH protected_relation(relation_name) AS (VALUES
      ('jobs'::text), ('financial_admin_commands'::text),
      ('financial_admin_job_claims'::text),
      ('refund_allocation_drafts'::text),
      ('refund_allocation_draft_items'::text),
      ('refund_allocation_finalization_effects'::text)
    ), actual_acl AS (
      SELECT relation_row.relname::text AS relation_name,
        privilege.grantee, privilege.grantor,
        privilege.privilege_type::text, privilege.is_grantable
      FROM pg_catalog.pg_class relation_row
      JOIN pg_catalog.pg_namespace namespace_row
        ON namespace_row.oid = relation_row.relnamespace
      JOIN protected_relation protected
        ON protected.relation_name = relation_row.relname
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(
        relation_row.relacl, pg_catalog.acldefault('r', relation_row.relowner)
      )) privilege
      WHERE namespace_row.nspname = 'public'
    ), expected_acl(
      relation_name, grantee, grantor, privilege_type, is_grantable
    ) AS (
      SELECT protected.relation_name, database_owner, database_owner,
        owner_privilege.privilege_type, false
      FROM protected_relation protected
      CROSS JOIN (VALUES
        ('INSERT'), ('SELECT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
        ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')
      ) owner_privilege(privilege_type)
      UNION ALL
      SELECT expected.relation_name, role_row.oid, database_owner,
        expected.privilege_type, false
      FROM (VALUES
        ('jobs','pale_orbit_financial_worker','SELECT'),
        ('jobs','pale_orbit_financial_worker','UPDATE'),
        ('financial_admin_commands','pale_orbit_financial_worker','SELECT'),
        ('refund_allocation_drafts','pale_orbit_runtime','SELECT'),
        ('refund_allocation_drafts','pale_orbit_financial_worker','INSERT'),
        ('refund_allocation_draft_items','pale_orbit_runtime','SELECT'),
        ('refund_allocation_draft_items','pale_orbit_financial_worker','INSERT'),
        ('refund_allocation_finalization_effects','pale_orbit_runtime','SELECT'),
        ('refund_allocation_finalization_effects','pale_orbit_financial_worker','INSERT')
      ) expected(relation_name, role_name, privilege_type)
      JOIN pg_catalog.pg_roles role_row ON role_row.rolname = expected.role_name
    ), acl_delta AS (
      (SELECT * FROM actual_acl EXCEPT SELECT * FROM expected_acl)
      UNION ALL
      (SELECT * FROM expected_acl EXCEPT SELECT * FROM actual_acl)
    )
    SELECT 1 FROM acl_delta
  ) OR EXISTS (
    WITH protected_relation(relation_name) AS (VALUES
      ('jobs'::text), ('financial_admin_commands'::text),
      ('financial_admin_job_claims'::text),
      ('refund_allocation_drafts'::text),
      ('refund_allocation_draft_items'::text),
      ('refund_allocation_finalization_effects'::text)
    ), actual_acl AS (
      SELECT relation_row.relname::text AS relation_name,
        attribute_row.attname::text AS column_name,
        privilege.grantee, privilege.grantor,
        privilege.privilege_type::text, privilege.is_grantable
      FROM pg_catalog.pg_attribute attribute_row
      JOIN pg_catalog.pg_class relation_row ON relation_row.oid = attribute_row.attrelid
      JOIN pg_catalog.pg_namespace namespace_row
        ON namespace_row.oid = relation_row.relnamespace
      JOIN protected_relation protected
        ON protected.relation_name = relation_row.relname
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute_row.attacl) privilege
      WHERE namespace_row.nspname = 'public' AND attribute_row.attnum > 0
        AND NOT attribute_row.attisdropped
    ), expected_acl(
      relation_name, column_name, grantee, grantor, privilege_type, is_grantable
    ) AS (
      SELECT expected.relation_name, expected.column_name,
        role_row.oid, database_owner, expected.privilege_type, false
      FROM (VALUES
        ('jobs','type','pale_orbit_runtime','INSERT'),
        ('jobs','payload','pale_orbit_runtime','INSERT'),
        ('jobs','deduplication_key','pale_orbit_runtime','INSERT'),
        ('jobs','run_at','pale_orbit_runtime','INSERT'),
        ('jobs','max_attempts','pale_orbit_runtime','INSERT'),
        ('jobs','id','pale_orbit_runtime','SELECT'),
        ('jobs','deduplication_key','pale_orbit_runtime','SELECT'),
        ('financial_admin_commands','status','pale_orbit_financial_worker','UPDATE'),
        ('financial_admin_commands','safe_result_code','pale_orbit_financial_worker','UPDATE'),
        ('financial_admin_commands','safe_result','pale_orbit_financial_worker','UPDATE'),
        ('financial_admin_commands','updated_at','pale_orbit_financial_worker','UPDATE'),
        ('financial_admin_commands','completed_at','pale_orbit_financial_worker','UPDATE'),
        ('refund_allocation_drafts','state','pale_orbit_financial_worker','UPDATE'),
        ('refund_allocation_drafts','version','pale_orbit_financial_worker','UPDATE'),
        ('refund_allocation_drafts','updated_by_admin_id','pale_orbit_financial_worker','UPDATE'),
        ('refund_allocation_drafts','updated_correlation_id','pale_orbit_financial_worker','UPDATE'),
        ('refund_allocation_drafts','updated_at','pale_orbit_financial_worker','UPDATE'),
        ('refund_allocation_drafts','finalized_at','pale_orbit_financial_worker','UPDATE'),
        ('refund_allocation_drafts','discarded_at','pale_orbit_financial_worker','UPDATE'),
        ('refund_allocation_draft_items','proposed_total_presentment_minor',
          'pale_orbit_financial_worker','UPDATE'),
        ('refund_allocation_draft_items','updated_at',
          'pale_orbit_financial_worker','UPDATE')
      ) expected(relation_name, column_name, role_name, privilege_type)
      JOIN pg_catalog.pg_roles role_row ON role_row.rolname = expected.role_name
    ), acl_delta AS (
      (SELECT * FROM actual_acl EXCEPT SELECT * FROM expected_acl)
      UNION ALL
      (SELECT * FROM expected_acl EXCEPT SELECT * FROM actual_acl)
    )
    SELECT 1 FROM acl_delta
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 6B-II protected table ACL postflight failed';
  END IF;

  IF EXISTS (
    WITH protected_routine(signature, role_name) AS (VALUES
      ('public.plan6bii_assert_financial_admin_job_lease(uuid)'::text, NULL::text),
      ('public.plan6bii_guard_financial_admin_job_lease()'::text, NULL::text),
      ('public.plan6bii_guard_financial_admin_command_update()'::text, NULL::text),
      ('public.plan6bii_guard_financial_admin_command_delete()'::text, NULL::text),
      ('public.plan6bii_sync_failed_financial_admin_command()'::text, NULL::text),
      ('public.plan6bii_guard_administrative_grant_transition()'::text, NULL::text),
      ('public.plan6b_guard_job_insert()'::text, NULL::text),
      ('public.plan6b_guard_audit_insert()'::text, NULL::text),
      ('public.plan6b_validate_issue_transition()'::text, NULL::text),
      ('public.submit_financial_admin_command(uuid,text,text,text,text,jsonb)'::text,
        'pale_orbit_runtime'::text),
      ('public.financial_admin_command_status(uuid,uuid)'::text,
        'pale_orbit_runtime'::text),
      ('public.append_financial_issue_view_audit(uuid,uuid,text,text,text)'::text,
        'pale_orbit_runtime'::text),
      ('public.append_financial_refund_review_view_audit(uuid,uuid,text,text,text)'::text,
        'pale_orbit_runtime'::text),
      ('public.append_financial_payout_view_audit(uuid,uuid,text,text,text)'::text,
        'pale_orbit_runtime'::text),
      ('public.append_financial_sales_export_audit(uuid,text,text,integer,integer,integer,text,text)'::text,
        'pale_orbit_runtime'::text),
      ('public.resolve_financial_issue_after_admin_command(uuid,uuid)'::text,
        'pale_orbit_financial_worker'::text),
      ('public.transition_administrative_recovery_grant_after_admin_command(uuid)'::text,
        'pale_orbit_financial_worker'::text)
    ), resolved_routine AS (
      SELECT protected.signature, protected.role_name,
        pg_catalog.to_regprocedure(protected.signature)::oid AS routine_oid
      FROM protected_routine protected
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
      (SELECT * FROM actual_acl EXCEPT SELECT * FROM expected_acl)
      UNION ALL
      (SELECT * FROM expected_acl EXCEPT SELECT * FROM actual_acl)
    )
    SELECT 1 FROM resolved_routine WHERE routine_oid IS NULL
    UNION ALL
    SELECT 1 FROM acl_delta
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'Plan 6B-II private authority ACL postflight failed';
  END IF;
END;
$plan6bii_postflight$;
