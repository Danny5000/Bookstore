DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles role_row
    WHERE role_row.rolname IN ('pale_orbit_runtime', 'pale_orbit_financial_worker')
      AND (
        role_row.rolcanlogin OR role_row.rolsuper OR role_row.rolcreatedb OR
        role_row.rolcreaterole OR NOT role_row.rolinherit OR role_row.rolreplication OR
        role_row.rolbypassrls OR role_row.rolconnlimit <> -1 OR
        role_row.rolvaliduntil IS NOT NULL OR role_row.rolconfig IS NOT NULL
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_db_role_setting setting_row
    JOIN pg_catalog.pg_roles role_row ON role_row.oid = setting_row.setrole
    WHERE role_row.rolname IN ('pale_orbit_runtime', 'pale_orbit_financial_worker')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'preexisting Plan 6B group role has noncanonical attributes';
  END IF;

  IF EXISTS (
    WITH RECURSIVE trusted_roles AS (
      SELECT role_row.oid
      FROM pg_catalog.pg_roles role_row
      WHERE role_row.rolsuper
        OR role_row.rolname = 'pg_database_owner'
        OR role_row.rolname = current_user
        OR role_row.rolname IN ('pale_orbit_runtime', 'pale_orbit_financial_worker')
        OR role_row.oid = (
          SELECT database_row.datdba
          FROM pg_catalog.pg_database database_row
          WHERE database_row.datname = pg_catalog.current_database()
        )
    ), extension_objects AS (
      SELECT extension_dependency.classid, extension_dependency.objid,
        extension_dependency.objsubid
      FROM pg_catalog.pg_depend extension_dependency
      WHERE extension_dependency.deptype = 'e'
      UNION
      SELECT dependent_object.classid, dependent_object.objid, dependent_object.objsubid
      FROM pg_catalog.pg_depend dependent_object
      JOIN extension_objects extension_object
        ON extension_object.classid = dependent_object.refclassid
       AND extension_object.objid = dependent_object.refobjid
       AND (extension_object.objsubid = 0 OR
         extension_object.objsubid = dependent_object.refobjsubid)
      WHERE dependent_object.deptype IN ('a', 'i')
    ), named_object_acl AS (
      SELECT 'database'::text AS object_kind, NULL::text AS schema_name,
        database_row.oid AS object_oid, acl.grantee, acl.privilege_type, acl.is_grantable
      FROM pg_catalog.pg_database database_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(database_row.datacl) acl
      WHERE database_row.datname = pg_catalog.current_database()
      UNION ALL
      SELECT 'schema', namespace_row.nspname, namespace_row.oid,
        acl.grantee, acl.privilege_type, acl.is_grantable
      FROM pg_catalog.pg_namespace namespace_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(namespace_row.nspacl) acl
      WHERE namespace_row.nspname = 'public'
      UNION ALL
      SELECT CASE WHEN relation_row.relkind = 'S' THEN 'sequence' ELSE 'relation' END,
        namespace_row.nspname, relation_row.oid,
        acl.grantee, acl.privilege_type, acl.is_grantable
      FROM pg_catalog.pg_class relation_row
      JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(relation_row.relacl) acl
      WHERE namespace_row.nspname = 'public'
        AND relation_row.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        AND NOT EXISTS (
          SELECT 1 FROM extension_objects extension_object
          WHERE extension_object.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
            AND extension_object.objid = relation_row.oid
            AND extension_object.objsubid = 0
        )
      UNION ALL
      SELECT 'column:' || attribute_row.attname, namespace_row.nspname,
        relation_row.oid, acl.grantee, acl.privilege_type, acl.is_grantable
      FROM pg_catalog.pg_attribute attribute_row
      JOIN pg_catalog.pg_class relation_row ON relation_row.oid = attribute_row.attrelid
      JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute_row.attacl) acl
      WHERE namespace_row.nspname = 'public'
        AND relation_row.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND attribute_row.attnum > 0
        AND NOT attribute_row.attisdropped
        AND NOT EXISTS (
          SELECT 1 FROM extension_objects extension_object
          WHERE extension_object.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
            AND extension_object.objid = relation_row.oid
            AND extension_object.objsubid = 0
        )
      UNION ALL
      SELECT 'function', namespace_row.nspname, function_row.oid,
        acl.grantee, acl.privilege_type, acl.is_grantable
      FROM pg_catalog.pg_proc function_row
      JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = function_row.pronamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl) acl
      WHERE namespace_row.nspname = 'public'
        AND NOT EXISTS (
          SELECT 1 FROM extension_objects extension_object
          WHERE extension_object.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
            AND extension_object.objid = function_row.oid
            AND extension_object.objsubid = 0
        )
      UNION ALL
      SELECT 'type', namespace_row.nspname, type_row.oid,
        acl.grantee, acl.privilege_type, acl.is_grantable
      FROM pg_catalog.pg_type type_row
      JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = type_row.typnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(type_row.typacl) acl
      WHERE namespace_row.nspname = 'public'
        AND NOT EXISTS (
          SELECT 1 FROM extension_objects extension_object
          WHERE extension_object.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
            AND extension_object.objid IN (type_row.oid, type_row.typelem)
            AND extension_object.objsubid = 0
        )
        AND NOT EXISTS (
          SELECT 1 FROM extension_objects extension_object
          WHERE extension_object.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
            AND extension_object.objid = type_row.typrelid
            AND extension_object.objsubid = 0
        )
    ), unexpected_authority AS (
      SELECT grantee_role.oid
      FROM named_object_acl privilege_row
      JOIN pg_catalog.pg_roles grantee_role ON grantee_role.oid = privilege_row.grantee
      WHERE NOT EXISTS (
          SELECT 1 FROM trusted_roles trusted_role WHERE trusted_role.oid = grantee_role.oid
        )
        AND (
          privilege_row.object_kind = 'database'
            AND privilege_row.privilege_type NOT IN ('CONNECT', 'TEMPORARY')
          OR privilege_row.object_kind = 'schema'
            AND (privilege_row.privilege_type <> 'USAGE' OR privilege_row.is_grantable)
          OR privilege_row.object_kind NOT IN ('database', 'schema')
        )
      UNION ALL
      SELECT grantee_role.oid
      FROM pg_catalog.pg_default_acl default_row
      JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = default_row.defaclrole
      CROSS JOIN LATERAL pg_catalog.aclexplode(default_row.defaclacl) acl
      JOIN pg_catalog.pg_roles grantee_role ON grantee_role.oid = acl.grantee
      WHERE (
          owner_role.rolname = current_user
          OR owner_role.oid = (
            SELECT database_row.datdba
            FROM pg_catalog.pg_database database_row
            WHERE database_row.datname = pg_catalog.current_database()
          )
        )
        AND (
          default_row.defaclnamespace = 0
          OR default_row.defaclnamespace = 'public'::pg_catalog.regnamespace
        )
        AND NOT EXISTS (
          SELECT 1 FROM trusted_roles trusted_role WHERE trusted_role.oid = grantee_role.oid
        )
      UNION ALL
      SELECT owner_role.oid
      FROM (
        SELECT namespace_row.nspowner AS owner_oid
        FROM pg_catalog.pg_namespace namespace_row
        WHERE namespace_row.nspname = 'public'
        UNION ALL
        SELECT relation_row.relowner
        FROM pg_catalog.pg_class relation_row
        JOIN pg_catalog.pg_namespace namespace_row
          ON namespace_row.oid = relation_row.relnamespace
        WHERE namespace_row.nspname = 'public'
          AND relation_row.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
          AND NOT EXISTS (
            SELECT 1 FROM extension_objects extension_object
            WHERE extension_object.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
              AND extension_object.objid = relation_row.oid
              AND extension_object.objsubid = 0
          )
        UNION ALL
        SELECT function_row.proowner
        FROM pg_catalog.pg_proc function_row
        JOIN pg_catalog.pg_namespace namespace_row
          ON namespace_row.oid = function_row.pronamespace
        WHERE namespace_row.nspname = 'public'
          AND NOT EXISTS (
            SELECT 1 FROM extension_objects extension_object
            WHERE extension_object.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
              AND extension_object.objid = function_row.oid
              AND extension_object.objsubid = 0
          )
        UNION ALL
        SELECT type_row.typowner
        FROM pg_catalog.pg_type type_row
        JOIN pg_catalog.pg_namespace namespace_row
          ON namespace_row.oid = type_row.typnamespace
        WHERE namespace_row.nspname = 'public'
          AND NOT EXISTS (
            SELECT 1 FROM extension_objects extension_object
            WHERE extension_object.classid = 'pg_catalog.pg_type'::pg_catalog.regclass
              AND extension_object.objid IN (type_row.oid, type_row.typelem)
              AND extension_object.objsubid = 0
          )
          AND NOT EXISTS (
            SELECT 1 FROM extension_objects extension_object
            WHERE extension_object.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
              AND extension_object.objid = type_row.typrelid
              AND extension_object.objsubid = 0
          )
      ) owned_object
      JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = owned_object.owner_oid
      WHERE NOT EXISTS (
        SELECT 1 FROM trusted_roles trusted_role WHERE trusted_role.oid = owner_role.oid
      )
      UNION ALL
      SELECT candidate_role.oid
      FROM pg_catalog.pg_roles candidate_role
      CROSS JOIN pg_catalog.pg_roles sensitive_role
      WHERE (
          sensitive_role.rolsuper
          OR sensitive_role.rolname = 'pg_database_owner'
          OR sensitive_role.rolname IN (
            'pale_orbit_runtime', 'pale_orbit_financial_worker',
            'pg_read_all_data', 'pg_write_all_data'
          )
          OR sensitive_role.rolname = current_user
          OR sensitive_role.oid = (
            SELECT database_row.datdba
            FROM pg_catalog.pg_database database_row
            WHERE database_row.datname = pg_catalog.current_database()
          )
        )
        AND candidate_role.oid <> sensitive_role.oid
        AND NOT EXISTS (
          SELECT 1 FROM trusted_roles trusted_role WHERE trusted_role.oid = candidate_role.oid
        )
        AND pg_catalog.pg_has_role(candidate_role.oid, sensitive_role.oid, 'MEMBER')
    )
    SELECT 1 FROM unexpected_authority
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'unexpected named Plan 6B database authority';
  END IF;
END;
$migration$;--> statement-breakpoint
LOCK TABLE "payments", "refunds", "refund_allocations", "disputes", "orders", "order_items",
  "stripe_payouts", "stripe_balance_transactions", "stripe_payout_balance_transactions",
  "financial_allocation_sets", "financial_classification_versions",
  "dispute_item_allocations", "financial_reconciliation_issues", "audit_events"
  IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "refunds" refund WHERE refund.amount_minor = 0) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Plan 6B zero-valued legacy refund amount cannot be migrated; refund amounts must be positive';
  END IF;
  IF EXISTS (SELECT 1 FROM "refund_allocations" allocation WHERE allocation.amount_minor = 0) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Plan 6B zero-valued legacy refund allocation cannot be migrated; refund allocations must be positive';
  END IF;
  IF EXISTS (SELECT 1 FROM "disputes" dispute WHERE dispute.amount_minor = 0) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Plan 6B zero-valued legacy dispute amount cannot be migrated; dispute amounts must be positive';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "stripe_payout_balance_transactions" membership
    JOIN "stripe_payouts" payout ON payout.id = membership.payout_id
    JOIN "stripe_balance_transactions" balance
      ON balance.id = membership.balance_transaction_id
    WHERE balance.currency IS DISTINCT FROM payout.currency
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'invalid legacy payout membership currency';
  END IF;
  IF EXISTS (
    WITH first_dispute_withdrawal_balance AS MATERIALIZED (
      SELECT DISTINCT ON (dispute.id)
        dispute.id AS dispute_id,
        dispute.amount_minor,
        balance.id AS balance_transaction_id
      FROM "disputes" dispute
      JOIN "stripe_balance_transactions" balance
        ON balance.source_family = 'dispute'
       AND balance.source_id = dispute.stripe_dispute_id
       AND balance.reporting_category = 'dispute'
      WHERE dispute.financial_evidence_status = 'fee_reconciled'
      ORDER BY dispute.id, balance.provider_created_at,
        balance.provider_id COLLATE "C", balance.id
    ), inconsistent_source_principal AS (
      SELECT payment.id AS source_id
      FROM "payments" payment
      JOIN "stripe_balance_transactions" balance
        ON balance.source_family = 'charge'
       AND balance.source_id = payment.stripe_latest_charge_id
       AND balance.reporting_category = 'charge'
      WHERE payment.financial_evidence_status = 'fee_reconciled'
        AND balance.currency = payment.currency
        AND balance.amount_minor <> payment.amount_minor
      UNION ALL
      SELECT refund.id
      FROM "refunds" refund
      JOIN "stripe_balance_transactions" balance
        ON balance.source_family = 'refund'
       AND balance.source_id = refund.stripe_refund_id
       AND balance.reporting_category = 'refund'
      WHERE refund.financial_evidence_status = 'fee_reconciled'
        AND balance.currency = refund.currency
        AND balance.amount_minor <> -refund.amount_minor
      UNION ALL
      SELECT first_withdrawal.dispute_id
      FROM first_dispute_withdrawal_balance first_withdrawal
      JOIN "financial_allocation_sets" allocation_set
        ON allocation_set.balance_transaction_id = first_withdrawal.balance_transaction_id
       AND allocation_set.source_kind = 'dispute'
       AND allocation_set.source_internal_id = first_withdrawal.dispute_id
       AND allocation_set.basis = 'gross_amount'
      JOIN "financial_classification_versions" classification
        ON classification.subject_type = 'balance_transaction'
       AND classification.subject_id = allocation_set.balance_transaction_id
       AND classification.classifier_version = allocation_set.classifier_version
       AND classification.source_fingerprint_sha256 =
         allocation_set.source_fingerprint_sha256
       AND classification.classification = 'dispute_withdrawal'
      LEFT JOIN "dispute_item_allocations" presentment
        ON presentment.gross_allocation_set_id = allocation_set.id
      GROUP BY first_withdrawal.dispute_id, first_withdrawal.amount_minor,
        allocation_set.id
      HAVING coalesce(sum(presentment.total_effect_minor), 0::bigint) <>
        -first_withdrawal.amount_minor::bigint
    )
    SELECT 1 FROM inconsistent_source_principal
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'invalid legacy fee-reconciled source principal parity';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "financial_reconciliation_issues" issue
    WHERE NOT (
      (issue.resource_type in ('payment', 'refund', 'dispute', 'allocation_set') and
        issue.safe_code in (
          'allocation_fork', 'allocation_incomplete', 'allocation_mismatch',
          'classification_fork', 'correction_rebase_required', 'currency_mismatch',
          'immutable_mismatch', 'missing_source', 'source_linkage_mismatch',
          'unsupported_category'
        ))
      or (issue.resource_type = 'payout' and issue.safe_code in (
        'currency_mismatch', 'generation_exhausted', 'immutable_mismatch',
        'payout_membership_conflict', 'payout_reversal_incomplete'
      ))
      or (issue.resource_type = 'balance_transaction' and
        issue.safe_code in ('classification_fork', 'immutable_mismatch'))
      or (issue.resource_type = 'financial_classification' and
        issue.safe_code = 'unsupported_category')
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'invalid legacy financial issue resource/code identity';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "financial_reconciliation_issues" issue
    WHERE NOT (
      (issue.safe_code in ('allocation_incomplete', 'missing_source') and issue.impact = 'pending')
      or (issue.safe_code not in ('allocation_incomplete', 'missing_source') and issue.impact = 'exception')
    )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'invalid legacy financial issue impact';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "financial_reconciliation_issues" issue
    WHERE (issue.resource_type = 'payment' and not exists (
        SELECT 1 FROM "payments" subject WHERE subject.id = issue.resource_id
      ))
      or (issue.resource_type = 'refund' and not exists (
        SELECT 1 FROM "refunds" subject WHERE subject.id = issue.resource_id
      ))
      or (issue.resource_type = 'dispute' and not exists (
        SELECT 1 FROM "disputes" subject WHERE subject.id = issue.resource_id
      ))
      or (issue.resource_type = 'payout' and not exists (
        SELECT 1 FROM "stripe_payouts" subject WHERE subject.id = issue.resource_id
      ))
      or (issue.resource_type = 'balance_transaction' and not exists (
        SELECT 1 FROM "stripe_balance_transactions" subject WHERE subject.id = issue.resource_id
      ))
      or (issue.resource_type = 'allocation_set' and not exists (
        SELECT 1 FROM "financial_allocation_sets" subject WHERE subject.id = issue.resource_id
      ))
      or (issue.resource_type = 'financial_classification' and not exists (
        SELECT 1
        FROM "financial_classification_versions" subject
        WHERE subject.id = issue.resource_id AND subject.classification = 'unknown'
      ))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'invalid legacy financial issue resource identity';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "financial_classification_versions" classification
    WHERE classification.classification = 'unknown'
      AND NOT EXISTS (
        SELECT 1
        FROM "financial_reconciliation_issues" issue
        WHERE issue.resource_type = 'financial_classification'
          AND issue.resource_id = classification.id
          AND issue.safe_code = 'unsupported_category'
          AND issue.impact = 'exception'
          AND issue.state = 'open'
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'missing legacy unknown classification issue';
  END IF;
  IF EXISTS (
    WITH canonical_resolved_audits AS (
      SELECT audit.id AS audit_id, issue.id AS issue_id
      FROM "audit_events" audit
      JOIN "financial_reconciliation_issues" issue
        ON issue.id::text = audit.resource_id
       AND issue.state = 'resolved'
      WHERE audit.action = 'financial.issue.resolved'
        AND audit.outcome = 'succeeded'
        AND audit.resource_type = 'financial_issue'
        AND audit.correlation_id IS NOT NULL
        AND char_length(audit.correlation_id) BETWEEN 1 AND 100
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
            ))
          OR (issue.resolved_by_admin_id IS NOT NULL
            AND audit.actor_type = 'user'
            AND audit.actor_id = issue.resolved_by_admin_id::text)
        )
        AND audit.after = jsonb_build_object(
          'resourceType', issue.resource_type,
          'resourceId', issue.resource_id,
          'safeCode', issue.safe_code,
          'impact', issue.impact,
          'state', issue.state,
          'occurrenceCount', issue.occurrence_count
        )
    ), invalid_resolved_issues AS (
      SELECT issue.id
      FROM "financial_reconciliation_issues" issue
      LEFT JOIN canonical_resolved_audits audit ON audit.issue_id = issue.id
      WHERE issue.state = 'resolved'
      GROUP BY issue.id
      HAVING count(audit.audit_id) <> 1
    ), invalid_resolved_audits AS (
      SELECT audit.id
      FROM "audit_events" audit
      LEFT JOIN canonical_resolved_audits canonical ON canonical.audit_id = audit.id
      WHERE audit.action = 'financial.issue.resolved'
        AND canonical.audit_id IS NULL
    )
    SELECT 1 FROM invalid_resolved_issues
    UNION ALL
    SELECT 1 FROM invalid_resolved_audits
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'invalid legacy financial issue resolution audit provenance';
  END IF;

  -- A succeeded multi-item refund without allocations is recoverable only when the immutable
  -- purchase graph passes the same facts consumed by lockPaymentPurchaseFacts and
  -- allocateDeterministicRefunds. Legitimate partial refunds remain needs_review.
  IF EXISTS (
    SELECT 1
    FROM "payments" payment
    JOIN "orders" purchase_order ON purchase_order.id = payment.order_id
    WHERE EXISTS (
      SELECT 1
      FROM "refunds" candidate_refund
      WHERE candidate_refund.payment_id = payment.id
        AND candidate_refund.status = 'succeeded'
        AND NOT EXISTS (
          SELECT 1
          FROM "refund_allocations" candidate_allocation
          WHERE candidate_allocation.refund_id = candidate_refund.id
        )
    )
      AND (
        SELECT count(*)
        FROM "order_items" candidate_item
        WHERE candidate_item.order_id = purchase_order.id
      ) > 1
      AND (
        payment.currency <> purchase_order.currency
        OR purchase_order.total_minor IS NULL
        OR purchase_order.total_minor <> payment.amount_minor
        OR EXISTS (
          SELECT 1
          FROM "order_items" graph_item
          WHERE graph_item.order_id = purchase_order.id
            AND (
              graph_item.tax_minor IS NULL
              OR graph_item.total_minor IS NULL
              OR graph_item.total_minor <= 0
              OR graph_item.total_minor <> graph_item.unit_subtotal_minor + graph_item.tax_minor
              OR graph_item.currency <> purchase_order.currency
            )
        )
        OR coalesce((
          SELECT sum(graph_item.total_minor)::bigint
          FROM "order_items" graph_item
          WHERE graph_item.order_id = purchase_order.id
        ), 0::bigint) <> payment.amount_minor::bigint
        OR EXISTS (
          SELECT 1
          FROM "refunds" graph_refund
          WHERE graph_refund.payment_id = payment.id
            AND (
              graph_refund.amount_minor <= 0
              OR graph_refund.currency <> purchase_order.currency
            )
        )
        OR coalesce((
          SELECT sum(graph_refund.amount_minor)::bigint
          FROM "refunds" graph_refund
          WHERE graph_refund.payment_id = payment.id
            AND graph_refund.status = 'succeeded'
        ), 0::bigint) > payment.amount_minor::bigint
      )
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'Plan 6B unrecoverable multi-item no-allocation refund graph cannot be migrated';
  END IF;
END;
$$;--> statement-breakpoint
ALTER TABLE "financial_reconciliation_issues" ADD CONSTRAINT "financial_reconciliation_issues_semantic_identity" CHECK (("financial_reconciliation_issues"."resource_type" in ('payment', 'refund', 'dispute', 'allocation_set') and "financial_reconciliation_issues"."safe_code" in ('allocation_fork', 'allocation_incomplete', 'allocation_mismatch', 'classification_fork', 'correction_rebase_required', 'currency_mismatch', 'immutable_mismatch', 'missing_source', 'source_linkage_mismatch', 'unsupported_category')) or ("financial_reconciliation_issues"."resource_type" = 'payout' and "financial_reconciliation_issues"."safe_code" in ('currency_mismatch', 'generation_exhausted', 'immutable_mismatch', 'payout_membership_conflict', 'payout_reversal_incomplete')) or ("financial_reconciliation_issues"."resource_type" = 'balance_transaction' and "financial_reconciliation_issues"."safe_code" in ('classification_fork', 'immutable_mismatch')) or ("financial_reconciliation_issues"."resource_type" = 'financial_classification' and "financial_reconciliation_issues"."safe_code" = 'unsupported_category'));--> statement-breakpoint
ALTER TABLE "financial_reconciliation_issues" ADD CONSTRAINT "financial_reconciliation_issues_semantic_impact" CHECK ((("financial_reconciliation_issues"."safe_code" in ('allocation_incomplete', 'missing_source')) and "financial_reconciliation_issues"."impact" = 'pending') or (("financial_reconciliation_issues"."safe_code" not in ('allocation_incomplete', 'missing_source')) and "financial_reconciliation_issues"."impact" = 'exception'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."plan6b_validate_issue_insert"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state <> 'open' OR NEW.resolved_at IS NOT NULL OR NEW.resolved_by_admin_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'financial issues must be inserted open';
  END IF;
  CASE NEW.resource_type
    WHEN 'payment' THEN
      PERFORM 1 FROM "public"."payments" subject WHERE subject.id = NEW.resource_id FOR KEY SHARE;
    WHEN 'refund' THEN
      PERFORM 1 FROM "public"."refunds" subject WHERE subject.id = NEW.resource_id FOR KEY SHARE;
    WHEN 'dispute' THEN
      PERFORM 1 FROM "public"."disputes" subject WHERE subject.id = NEW.resource_id FOR KEY SHARE;
    WHEN 'payout' THEN
      PERFORM 1 FROM "public"."stripe_payouts" subject WHERE subject.id = NEW.resource_id FOR KEY SHARE;
    WHEN 'balance_transaction' THEN
      PERFORM 1 FROM "public"."stripe_balance_transactions" subject WHERE subject.id = NEW.resource_id FOR KEY SHARE;
    WHEN 'allocation_set' THEN
      PERFORM 1 FROM "public"."financial_allocation_sets" subject WHERE subject.id = NEW.resource_id FOR KEY SHARE;
    WHEN 'financial_classification' THEN
      PERFORM 1
      FROM "public"."financial_classification_versions" subject
      WHERE subject.id = NEW.resource_id AND subject.classification = 'unknown'
      FOR KEY SHARE;
      IF NOT FOUND THEN
        IF EXISTS (
          SELECT 1 FROM "public"."financial_classification_versions" subject
          WHERE subject.id = NEW.resource_id
        ) THEN
          RAISE EXCEPTION USING ERRCODE = '23514',
            MESSAGE = 'financial classification issues require an unknown classification';
        END IF;
        RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'financial issue resource does not exist';
      END IF;
      RETURN NEW;
    ELSE
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid financial issue resource identity';
  END CASE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'financial issue resource does not exist';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "public"."plan6b_validate_unknown_classification_issue"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "public"."financial_reconciliation_issues" issue
    WHERE issue.resource_type = 'financial_classification'
      AND issue.resource_id = NEW.id
      AND issue.safe_code = 'unsupported_category'
      AND issue.impact = 'exception'
      AND issue.state = 'open'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'unknown classifications require a permanent reconciliation issue';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "financial_classification_versions_unknown_issue_required"
AFTER INSERT ON "financial_classification_versions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW."classification" = 'unknown')
EXECUTE FUNCTION "public"."plan6b_validate_unknown_classification_issue"();--> statement-breakpoint
CREATE FUNCTION "public"."plan6b_guard_financial_issue_subject_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  subject_resource_type text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.id IS NOT DISTINCT FROM OLD.id THEN
    RETURN NEW;
  END IF;
  subject_resource_type := CASE TG_TABLE_NAME
    WHEN 'payments' THEN 'payment'
    WHEN 'refunds' THEN 'refund'
    WHEN 'disputes' THEN 'dispute'
    ELSE NULL
  END;
  IF subject_resource_type IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid financial issue subject guard';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "public"."financial_reconciliation_issues" issue
    WHERE issue.resource_type = subject_resource_type
      AND issue.resource_id = OLD.id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'financial issue subjects cannot be deleted or reidentified';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "payments_financial_issue_subject_guard"
BEFORE DELETE OR UPDATE OF "id" ON "payments"
FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_guard_financial_issue_subject_mutation"();--> statement-breakpoint
CREATE TRIGGER "refunds_financial_issue_subject_guard"
BEFORE DELETE OR UPDATE OF "id" ON "refunds"
FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_guard_financial_issue_subject_mutation"();--> statement-breakpoint
CREATE TRIGGER "disputes_financial_issue_subject_guard"
BEFORE DELETE OR UPDATE OF "id" ON "disputes"
FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_guard_financial_issue_subject_mutation"();--> statement-breakpoint
ALTER TABLE "refunds" DROP CONSTRAINT "refunds_amount_nonnegative";--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_positive" CHECK ("refunds"."amount_minor" > 0);--> statement-breakpoint
ALTER TABLE "refund_allocations" DROP CONSTRAINT "refund_allocations_amount_nonnegative";--> statement-breakpoint
ALTER TABLE "refund_allocations" ADD CONSTRAINT "refund_allocations_amount_positive" CHECK ("refund_allocations"."amount_minor" > 0);--> statement-breakpoint
ALTER TABLE "disputes" DROP CONSTRAINT "disputes_amount_nonnegative";--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_amount_positive" CHECK ("disputes"."amount_minor" > 0);--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'pale_orbit_runtime') THEN
    CREATE ROLE "pale_orbit_runtime" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'pale_orbit_financial_worker') THEN
    CREATE ROLE "pale_orbit_financial_worker" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT;
  END IF;
END;
$$;--> statement-breakpoint
ALTER ROLE "pale_orbit_runtime" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;--> statement-breakpoint
ALTER ROLE "pale_orbit_runtime" RESET ALL;--> statement-breakpoint
ALTER ROLE "pale_orbit_financial_worker" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;--> statement-breakpoint
ALTER ROLE "pale_orbit_financial_worker" RESET ALL;--> statement-breakpoint
REVOKE ALL ON SCHEMA "public" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA "public" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON ALL SEQUENCES IN SCHEMA "public" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON ALL ROUTINES IN SCHEMA "public" FROM PUBLIC;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE ALL ON TABLES FROM PUBLIC;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "public" REVOKE ALL ON SEQUENCES FROM PUBLIC;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON ROUTINES FROM PUBLIC;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members membership
    JOIN pg_catalog.pg_roles member_role ON member_role.oid = membership.member
    JOIN pg_catalog.pg_roles granted_role ON granted_role.oid = membership.roleid
    WHERE (
      member_role.rolname IN ('pale_orbit_runtime', 'pale_orbit_financial_worker')
      OR granted_role.rolname IN ('pale_orbit_runtime', 'pale_orbit_financial_worker')
    )
      AND NOT (
        member_role.rolname = 'pale_orbit_financial_worker'
        AND granted_role.rolname = 'pale_orbit_runtime'
        AND NOT membership.admin_option
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_database database_row
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = database_row.datdba
    WHERE owner_role.rolname IN ('pale_orbit_runtime', 'pale_orbit_financial_worker')
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_namespace namespace_row
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = namespace_row.nspowner
    WHERE owner_role.rolname IN ('pale_orbit_runtime', 'pale_orbit_financial_worker')
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class relation_row
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = relation_row.relowner
    WHERE owner_role.rolname IN ('pale_orbit_runtime', 'pale_orbit_financial_worker')
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc function_row
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = function_row.proowner
    WHERE owner_role.rolname IN ('pale_orbit_runtime', 'pale_orbit_financial_worker')
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_type type_row
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = type_row.typowner
    WHERE owner_role.rolname IN ('pale_orbit_runtime', 'pale_orbit_financial_worker')
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_largeobject_metadata large_object_row
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = large_object_row.lomowner
    WHERE owner_role.rolname IN ('pale_orbit_runtime', 'pale_orbit_financial_worker')
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_default_acl default_row
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = default_row.defaclrole
    WHERE owner_role.rolname IN ('pale_orbit_runtime', 'pale_orbit_financial_worker')
  ) OR EXISTS (
    SELECT 1
    FROM (
      SELECT 'database'::text AS object_kind, NULL::text AS schema_name,
        object_row.oid AS object_oid, acl.grantee, acl.privilege_type, acl.is_grantable
      FROM pg_catalog.pg_database object_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(object_row.datacl) acl
      UNION ALL
      SELECT 'schema', object_row.nspname, object_row.oid,
        acl.grantee, acl.privilege_type, acl.is_grantable
      FROM pg_catalog.pg_namespace object_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(object_row.nspacl) acl
      UNION ALL
      SELECT CASE WHEN object_row.relkind = 'S' THEN 'sequence' ELSE 'relation' END,
        namespace_row.nspname, object_row.oid, acl.grantee, acl.privilege_type, acl.is_grantable
      FROM pg_catalog.pg_class object_row
      JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = object_row.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(object_row.relacl) acl
      UNION ALL
      SELECT 'column:' || object_row.attname, namespace_row.nspname, object_row.attrelid,
        acl.grantee, acl.privilege_type, acl.is_grantable
      FROM pg_catalog.pg_attribute object_row
      JOIN pg_catalog.pg_class relation_row ON relation_row.oid = object_row.attrelid
      JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(object_row.attacl) acl
      UNION ALL
      SELECT 'function', namespace_row.nspname, function_row.oid,
        acl.grantee, acl.privilege_type, acl.is_grantable
      FROM pg_catalog.pg_proc function_row
      JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = function_row.pronamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(function_row.proacl, pg_catalog.acldefault('f', function_row.proowner))
      ) acl
      UNION ALL
      SELECT 'type', namespace_row.nspname, object_row.oid,
        acl.grantee, acl.privilege_type, acl.is_grantable
      FROM pg_catalog.pg_type object_row
      JOIN pg_catalog.pg_namespace namespace_row ON namespace_row.oid = object_row.typnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(object_row.typacl) acl
      UNION ALL
      SELECT 'language', NULL, object_row.oid,
        acl.grantee, acl.privilege_type, acl.is_grantable
      FROM pg_catalog.pg_language object_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(object_row.lanacl) acl
      UNION ALL
      SELECT 'large_object', NULL, object_row.oid,
        acl.grantee, acl.privilege_type, acl.is_grantable
      FROM pg_catalog.pg_largeobject_metadata object_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(object_row.lomacl) acl
      UNION ALL
      SELECT 'tablespace', NULL, object_row.oid,
        acl.grantee, acl.privilege_type, acl.is_grantable
      FROM pg_catalog.pg_tablespace object_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(object_row.spcacl) acl
      UNION ALL
      SELECT 'foreign_data_wrapper', NULL, object_row.oid,
        acl.grantee, acl.privilege_type, acl.is_grantable
      FROM pg_catalog.pg_foreign_data_wrapper object_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(object_row.fdwacl) acl
      UNION ALL
      SELECT 'foreign_server', NULL, object_row.oid,
        acl.grantee, acl.privilege_type, acl.is_grantable
      FROM pg_catalog.pg_foreign_server object_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(object_row.srvacl) acl
      UNION ALL
      SELECT 'parameter', NULL, object_row.oid,
        acl.grantee, acl.privilege_type, acl.is_grantable
      FROM pg_catalog.pg_parameter_acl object_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(object_row.paracl) acl
      UNION ALL
      SELECT CASE object_row.defaclobjtype
          WHEN 'r' THEN 'default_relation'
          WHEN 'S' THEN 'default_sequence'
          ELSE 'default_other'
        END,
        namespace_row.nspname, object_row.oid,
        acl.grantee, acl.privilege_type, acl.is_grantable
      FROM pg_catalog.pg_default_acl object_row
      LEFT JOIN pg_catalog.pg_namespace namespace_row
        ON namespace_row.oid = object_row.defaclnamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(object_row.defaclacl) acl
    ) privilege_row
    WHERE EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles grantee_role
      WHERE grantee_role.oid = privilege_row.grantee
        AND grantee_role.rolname IN ('pale_orbit_runtime', 'pale_orbit_financial_worker')
    ) OR privilege_row.grantee = 0
    AND NOT (
      privilege_row.object_kind = 'relation'
      AND privilege_row.object_oid = 'pg_catalog.pg_settings'::pg_catalog.regclass
      AND privilege_row.privilege_type = 'UPDATE'
      AND NOT privilege_row.is_grantable
    ) AND (
      privilege_row.is_grantable
      OR privilege_row.object_kind LIKE 'default_%'
      OR privilege_row.object_kind = 'parameter'
      OR privilege_row.object_kind = 'database'
        AND privilege_row.privilege_type NOT IN ('CONNECT', 'TEMPORARY')
      OR privilege_row.object_kind = 'schema'
        AND privilege_row.privilege_type = 'CREATE'
      OR privilege_row.object_kind = 'relation'
        AND privilege_row.privilege_type = 'SELECT'
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.pg_class sensitive_relation
          JOIN pg_catalog.pg_namespace sensitive_namespace
            ON sensitive_namespace.oid = sensitive_relation.relnamespace
          CROSS JOIN pg_catalog.unnest(ARRAY[
            'outbox_messages:payload',
            'commerce_claim_issuances:*'
          ]::text[]) sensitive_column(token)
          WHERE sensitive_relation.oid = privilege_row.object_oid
            AND sensitive_namespace.nspname = 'public'
            AND sensitive_relation.relname =
              pg_catalog.split_part(sensitive_column.token, ':', 1)
        )
      OR privilege_row.object_kind = 'relation'
        AND privilege_row.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
      OR privilege_row.object_kind LIKE 'column:%'
        AND privilege_row.privilege_type IN ('INSERT', 'UPDATE', 'REFERENCES')
      OR privilege_row.object_kind LIKE 'column:%'
        AND privilege_row.privilege_type = 'SELECT'
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.pg_class sensitive_relation
          JOIN pg_catalog.pg_namespace sensitive_namespace
            ON sensitive_namespace.oid = sensitive_relation.relnamespace
          CROSS JOIN pg_catalog.unnest(ARRAY[
            'outbox_messages:payload',
            'commerce_claim_issuances:*'
          ]::text[]) sensitive_column(token)
          WHERE sensitive_relation.oid = privilege_row.object_oid
            AND sensitive_namespace.nspname = 'public'
            AND sensitive_relation.relname =
              pg_catalog.split_part(sensitive_column.token, ':', 1)
            AND (
              pg_catalog.split_part(sensitive_column.token, ':', 2) = '*'
              OR pg_catalog.substr(privilege_row.object_kind, 8) =
                pg_catalog.split_part(sensitive_column.token, ':', 2)
            )
        )
      OR privilege_row.object_kind = 'sequence'
        AND privilege_row.privilege_type IN ('USAGE', 'UPDATE')
      OR privilege_row.object_kind = 'function'
        AND privilege_row.privilege_type = 'EXECUTE'
        AND privilege_row.schema_name !~ '^pg_'
        AND privilege_row.schema_name <> 'information_schema'
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.pg_proc function_row
          WHERE function_row.oid = privilege_row.object_oid
            AND function_row.prosecdef
        )
      OR privilege_row.object_kind = 'large_object'
        AND privilege_row.privilege_type = 'UPDATE'
      OR privilege_row.object_kind = 'tablespace'
        AND privilege_row.privilege_type = 'CREATE'
      OR privilege_row.object_kind IN ('foreign_data_wrapper', 'foreign_server')
    )
  ) OR pg_catalog.current_setting('session_replication_role') IS DISTINCT FROM 'origin'
  OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_db_role_setting setting_row
    CROSS JOIN LATERAL pg_catalog.unnest(setting_row.setconfig) configured_setting(value)
    WHERE EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles setting_role
      WHERE setting_role.oid = setting_row.setrole
        AND setting_role.rolname IN ('pale_orbit_runtime', 'pale_orbit_financial_worker')
    ) OR setting_row.setrole = 0
      AND (
        setting_row.setdatabase = 0 OR setting_row.setdatabase = (
          SELECT database_row.oid
          FROM pg_catalog.pg_database database_row
          WHERE database_row.datname = pg_catalog.current_database()
        )
      )
      AND (
        pg_catalog.split_part(configured_setting.value, '=', 1) = 'session_replication_role'
          AND pg_catalog.lower(pg_catalog.split_part(configured_setting.value, '=', 2)) <> 'origin'
        OR pg_catalog.split_part(configured_setting.value, '=', 1) = 'role'
          AND pg_catalog.lower(pg_catalog.split_part(configured_setting.value, '=', 2)) <> 'none'
        OR pg_catalog.split_part(configured_setting.value, '=', 1) = 'search_path'
        OR pg_catalog.split_part(configured_setting.value, '=', 1) = 'row_security'
          AND pg_catalog.lower(pg_catalog.split_part(configured_setting.value, '=', 2)) = 'off'
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_shdepend authority_dependency
    JOIN pg_catalog.pg_roles authority_role ON authority_role.oid = authority_dependency.refobjid
    WHERE authority_dependency.deptype IN ('o', 'a', 'i', 'r')
      AND authority_role.rolname IN ('pale_orbit_runtime', 'pale_orbit_financial_worker')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = 'unsafe pre-existing Plan 6B database authority roles';
  END IF;
END;
$$;--> statement-breakpoint
DO $connect$
BEGIN
  EXECUTE pg_catalog.format(
    'GRANT CONNECT ON DATABASE %I TO "pale_orbit_runtime", "pale_orbit_financial_worker"',
    pg_catalog.current_database()
  );
END;
$connect$;--> statement-breakpoint
GRANT USAGE ON SCHEMA "public" TO "pale_orbit_runtime";--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" TO "pale_orbit_runtime";--> statement-breakpoint
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA "public" TO "pale_orbit_runtime";--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT SELECT ON TABLES TO "pale_orbit_runtime";--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA "public" GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO "pale_orbit_runtime";--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON TABLE
  "public"."dispute_item_allocations",
  "public"."financial_allocation_sets",
  "public"."financial_item_allocations",
  "public"."financial_reconciliation_issues",
  "public"."refund_allocation_components",
  "public"."refund_allocation_draft_items",
  "public"."refund_allocation_drafts",
  "public"."refund_allocation_finalization_effects",
  "public"."refund_reporting_correction_items",
  "public"."refund_reporting_correction_sets",
  "public"."financial_classification_versions",
  "public"."financial_projection_versions",
  "public"."financial_payout_discovery_state",
  "public"."financial_scan_runs",
  "public"."payout_import_run_entries",
  "public"."payout_import_runs",
  "public"."stripe_balance_transaction_fee_details",
  "public"."stripe_balance_transactions",
  "public"."stripe_payout_balance_transactions",
  "public"."stripe_payouts"
FROM "pale_orbit_runtime";--> statement-breakpoint
GRANT INSERT, UPDATE ON TABLE
  "public"."financial_reconciliation_issues",
  "public"."financial_scan_runs",
  "public"."payout_import_runs",
  "public"."stripe_balance_transactions",
  "public"."stripe_payouts"
TO "pale_orbit_financial_worker";--> statement-breakpoint
GRANT INSERT ON TABLE
  "public"."dispute_item_allocations",
  "public"."financial_allocation_sets",
  "public"."financial_item_allocations",
  "public"."refund_allocation_components",
  "public"."refund_reporting_correction_items",
  "public"."refund_reporting_correction_sets",
  "public"."financial_classification_versions",
  "public"."payout_import_run_entries",
  "public"."stripe_balance_transaction_fee_details",
  "public"."stripe_payout_balance_transactions"
TO "pale_orbit_financial_worker";--> statement-breakpoint
GRANT UPDATE ON TABLE
  "public"."financial_projection_versions",
  "public"."financial_payout_discovery_state"
TO "pale_orbit_financial_worker";--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON TABLE
  "public"."payments",
  "public"."refunds",
  "public"."refund_allocations",
  "public"."disputes"
FROM "pale_orbit_runtime";--> statement-breakpoint
GRANT INSERT, UPDATE ON TABLE
  "public"."payments",
  "public"."refunds",
  "public"."disputes"
TO "pale_orbit_financial_worker";--> statement-breakpoint
GRANT INSERT ON TABLE "public"."refund_allocations"
TO "pale_orbit_financial_worker";--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON TABLE "public"."stripe_events" FROM "pale_orbit_runtime";--> statement-breakpoint
GRANT INSERT (
  "provider_event_id",
  "event_type",
  "object_id",
  "live_mode",
  "api_version",
  "provider_created_at",
  "raw_body_sha256"
) ON TABLE "public"."stripe_events" TO "pale_orbit_runtime";--> statement-breakpoint
GRANT UPDATE ON TABLE "public"."stripe_events" TO "pale_orbit_financial_worker";--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON TABLE "public"."current_financial_projection_heads", "public"."current_financial_projection_items" FROM "pale_orbit_runtime";--> statement-breakpoint
GRANT "pale_orbit_runtime" TO "pale_orbit_financial_worker"
  WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;--> statement-breakpoint
CREATE FUNCTION "public"."plan6b_guard_audit_insert"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = 'pg_catalog'
AS $$
BEGIN
  IF NOT (
    pg_catalog.pg_has_role(session_user, 'pale_orbit_runtime', 'MEMBER')
    AND NOT pg_catalog.pg_has_role(session_user, 'pale_orbit_financial_worker', 'MEMBER')
  ) THEN
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
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."plan6b_guard_audit_insert"() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER "audit_events_plan6b_web_insert_guard"
BEFORE INSERT ON "public"."audit_events"
FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_guard_audit_insert"();--> statement-breakpoint
CREATE FUNCTION "public"."resolve_financial_issue_after_worker_recompute"(
  p_issue_id uuid,
  p_correlation_id text
) RETURNS SETOF "public"."financial_reconciliation_issues"
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $$
DECLARE
  current_issue "public"."financial_reconciliation_issues"%ROWTYPE;
  resolved_issue "public"."financial_reconciliation_issues"%ROWTYPE;
BEGIN
  IF p_issue_id IS NULL OR p_correlation_id IS NULL OR
    char_length(p_correlation_id) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid financial issue worker resolution';
  END IF;
  SELECT * INTO current_issue
  FROM "public"."financial_reconciliation_issues" issue
  WHERE issue.id = p_issue_id
  FOR UPDATE;
  IF NOT FOUND OR current_issue.state <> 'open' THEN
    RETURN;
  END IF;
  IF current_issue.resource_type = 'financial_classification'
    AND current_issue.safe_code = 'unsupported_category' THEN
    RAISE EXCEPTION USING ERRCODE = '55000',
      MESSAGE = 'immutable classification diagnostics cannot be resolved';
  END IF;
  PERFORM pg_catalog.set_config(
    'pale_orbit.financial_worker_issue_resolution', p_issue_id::text, true
  );
  UPDATE "public"."financial_reconciliation_issues"
  SET "state" = 'resolved', "resolved_at" = pg_catalog.now(), "resolved_by_admin_id" = NULL
  WHERE "id" = p_issue_id AND "state" = 'open'
  RETURNING * INTO resolved_issue;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  INSERT INTO "public"."audit_events" (
    actor_type, actor_id, action, outcome, resource_type, resource_id, correlation_id, after
  ) VALUES (
    'system'::"public"."audit_actor_type", 'financial-worker', 'financial.issue.resolved',
    'succeeded', 'financial_issue', resolved_issue.id::text, p_correlation_id,
    pg_catalog.jsonb_build_object(
      'resourceType', resolved_issue.resource_type,
      'resourceId', resolved_issue.resource_id,
      'safeCode', resolved_issue.safe_code,
      'impact', resolved_issue.impact,
      'state', resolved_issue.state,
      'occurrenceCount', resolved_issue.occurrence_count
    )
  );
  RETURN NEXT resolved_issue;
  RETURN;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."resolve_financial_issue_after_worker_recompute"(uuid,text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."resolve_financial_issue_after_worker_recompute"(uuid,text) TO "pale_orbit_financial_worker";--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."plan6b_validate_issue_transition"() RETURNS trigger
LANGUAGE plpgsql AS $$
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
    IF current_setting('pale_orbit.financial_worker_issue_resolution', true)
        IS DISTINCT FROM OLD.id::text OR
      current_user IS DISTINCT FROM (
        SELECT pg_catalog.pg_get_userbyid(worker_resolver.proowner)
        FROM pg_catalog.pg_proc worker_resolver
        WHERE worker_resolver.oid =
          'public.resolve_financial_issue_after_worker_recompute(uuid,text)'::pg_catalog.regprocedure
      ) OR
      NEW.resolved_by_admin_id IS NOT NULL OR NEW.resolved_at IS NULL OR
      NEW.occurrence_count <> OLD.occurrence_count OR
      NEW.last_observed_at IS DISTINCT FROM OLD.last_observed_at THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'financial issue resolution requires the guarded worker resolver';
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
$$;--> statement-breakpoint
CREATE FUNCTION "public"."plan6b_guard_order_write"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = 'pg_catalog'
AS $$
DECLARE
  expected_email text;
BEGIN
  IF NOT (
    pg_catalog.pg_has_role(session_user, 'pale_orbit_runtime', 'MEMBER')
    AND NOT pg_catalog.pg_has_role(session_user, 'pale_orbit_financial_worker', 'MEMBER')
  ) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'checkout_pending' OR NEW.guest_identity_id IS NOT NULL OR
      NEW.tax_minor IS NOT NULL OR NEW.total_minor IS NOT NULL OR
      NEW.stripe_checkout_session_id IS NOT NULL OR NEW.checkout_expires_at IS NOT NULL OR
      NEW.paid_at IS NOT NULL OR NEW.created_at IS DISTINCT FROM NEW.updated_at THEN
      RAISE EXCEPTION USING ERRCODE = '55000',
        MESSAGE = 'invalid web order creation';
    END IF;
    IF NEW.initiating_user_id IS NULL THEN
      IF NEW.purchase_email IS NOT NULL THEN
        RAISE EXCEPTION USING ERRCODE = '55000',
          MESSAGE = 'anonymous order identity must be empty';
      END IF;
    ELSE
      SELECT pg_catalog.lower(pg_catalog.btrim(account.email))
      INTO expected_email
      FROM "public"."user" account
      WHERE account.id = NEW.initiating_user_id AND account.email_verified
      FOR KEY SHARE;
      IF NOT FOUND OR NEW.purchase_email IS DISTINCT FROM expected_email THEN
        RAISE EXCEPTION USING ERRCODE = '55000',
          MESSAGE = 'account order identity is not verified';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR
    NEW.initiating_user_id IS DISTINCT FROM OLD.initiating_user_id OR
    NEW.guest_identity_id IS DISTINCT FROM OLD.guest_identity_id OR
    NEW.purchase_email IS DISTINCT FROM OLD.purchase_email OR
    NEW.currency IS DISTINCT FROM OLD.currency OR
    NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor OR
    NEW.tax_minor IS DISTINCT FROM OLD.tax_minor OR
    NEW.total_minor IS DISTINCT FROM OLD.total_minor OR
    NEW.client_checkout_attempt_id IS DISTINCT FROM OLD.client_checkout_attempt_id OR
    NEW.quote_fingerprint_sha256 IS DISTINCT FROM OLD.quote_fingerprint_sha256 OR
    NEW.status_token_sha256 IS DISTINCT FROM OLD.status_token_sha256 OR
    NEW.paid_at IS DISTINCT FROM OLD.paid_at OR
    NEW.created_at IS DISTINCT FROM OLD.created_at OR
    NEW.updated_at < OLD.updated_at OR
    NEW.updated_at > pg_catalog.clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid web order mutation';
  END IF;

  IF OLD.status = 'checkout_pending' AND NEW.status = 'checkout_open' AND (
      (OLD.stripe_checkout_session_id IS NULL AND OLD.checkout_expires_at IS NULL AND
        NEW.stripe_checkout_session_id IS NOT NULL AND NEW.checkout_expires_at IS NOT NULL)
      OR
      (OLD.stripe_checkout_session_id IS NOT NULL AND
        NEW.stripe_checkout_session_id IS NOT DISTINCT FROM OLD.stripe_checkout_session_id AND
        NEW.checkout_expires_at IS NOT DISTINCT FROM OLD.checkout_expires_at)
    ) THEN
    RETURN NEW;
  END IF;
  IF OLD.status IN ('checkout_pending', 'checkout_open', 'payment_pending') AND
    NEW.status = 'exception' AND
    NEW.stripe_checkout_session_id IS NOT DISTINCT FROM OLD.stripe_checkout_session_id AND
    NEW.checkout_expires_at IS NOT DISTINCT FROM OLD.checkout_expires_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid web order transition';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "orders_plan6b_web_write_guard"
BEFORE INSERT OR UPDATE ON "public"."orders"
FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_guard_order_write"();--> statement-breakpoint
CREATE FUNCTION "public"."plan6b_guard_order_item_insert"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = 'pg_catalog'
AS $$
DECLARE
  parent_order "public"."orders"%ROWTYPE;
BEGIN
  IF NOT (
    pg_catalog.pg_has_role(session_user, 'pale_orbit_runtime', 'MEMBER')
    AND NOT pg_catalog.pg_has_role(session_user, 'pale_orbit_financial_worker', 'MEMBER')
  ) THEN
    RETURN NEW;
  END IF;
  SELECT * INTO parent_order
  FROM "public"."orders" purchase_order
  WHERE purchase_order.id = NEW.order_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'order item parent does not exist';
  END IF;
  IF parent_order.status <> 'checkout_pending' OR
    parent_order.guest_identity_id IS NOT NULL OR
    parent_order.tax_minor IS NOT NULL OR parent_order.total_minor IS NOT NULL OR
    parent_order.stripe_checkout_session_id IS NOT NULL OR
    parent_order.checkout_expires_at IS NOT NULL OR parent_order.paid_at IS NOT NULL OR
    NEW.currency IS DISTINCT FROM parent_order.currency OR
    NEW.tax_minor IS NOT NULL OR NEW.total_minor IS NOT NULL OR
    NEW.stripe_line_item_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid web order item creation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "order_items_plan6b_web_insert_guard"
BEFORE INSERT ON "public"."order_items"
FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_guard_order_item_insert"();--> statement-breakpoint
CREATE FUNCTION "public"."plan6b_guard_job_insert"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $$
DECLARE
  referenced_id uuid;
  referenced_generation integer;
  stripe_provider_event_id text;
  stripe_event_status "public"."stripe_event_status";
  revision_state "public"."revision_state";
  revision_generation integer;
  claim_order "public"."orders"%ROWTYPE;
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

  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'web job type is not permitted';
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."plan6b_guard_job_insert"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."plan6b_guard_job_insert"() FROM "pale_orbit_runtime";--> statement-breakpoint
CREATE TRIGGER "jobs_plan6b_web_insert_guard"
BEFORE INSERT ON "public"."jobs"
FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_guard_job_insert"();--> statement-breakpoint
CREATE FUNCTION "public"."plan6b_guard_outbox_insert"() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $$
DECLARE
  dispatch_job "public"."jobs"%ROWTYPE;
BEGIN
  IF NOT (
    pg_catalog.pg_has_role(session_user, 'pale_orbit_runtime', 'MEMBER')
    AND NOT pg_catalog.pg_has_role(session_user, 'pale_orbit_financial_worker', 'MEMBER')
  ) THEN
    RETURN NEW;
  END IF;
  SELECT * INTO dispatch_job
  FROM "public"."jobs" queued_job
  WHERE queued_job.id = NEW.dispatch_job_id
  FOR KEY SHARE;
  IF NOT FOUND OR dispatch_job.type <> 'outbox.dispatch' OR
    dispatch_job.payload IS DISTINCT FROM pg_catalog.jsonb_build_object('outboxId', NEW.id) OR
    dispatch_job.status <> 'pending' OR dispatch_job.max_attempts <> 8 OR
    NEW.status <> 'pending' OR NEW.last_error IS NOT NULL OR NEW.delivered_at IS NOT NULL OR
    NEW.created_at IS DISTINCT FROM NEW.updated_at OR
    (NEW.deduplication_key IS NULL AND
      dispatch_job.deduplication_key IS DISTINCT FROM 'outbox:' || NEW.id::text) OR
    (NEW.deduplication_key IS NOT NULL AND
      dispatch_job.deduplication_key !~ '^outbox-key:[0-9a-f]{64}$') THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid web outbox creation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."plan6b_guard_outbox_insert"() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."plan6b_guard_outbox_insert"() FROM "pale_orbit_runtime";--> statement-breakpoint
CREATE TRIGGER "outbox_messages_plan6b_web_insert_guard"
BEFORE INSERT ON "public"."outbox_messages"
FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_guard_outbox_insert"();--> statement-breakpoint
CREATE FUNCTION "public"."plan6b_guard_title_revision_write"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = 'pg_catalog'
AS $$
BEGIN
  IF NOT (
    pg_catalog.pg_has_role(session_user, 'pale_orbit_runtime', 'MEMBER')
    AND NOT pg_catalog.pg_has_role(session_user, 'pale_orbit_financial_worker', 'MEMBER')
  ) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'uploaded' OR NEW.ingestion_generation <> 0 OR
      NEW.derivation_version <> 1 OR NEW.original_storage_key IS NOT NULL OR
      NEW.original_checksum_sha256 IS NOT NULL OR NEW.original_mime_type IS NOT NULL OR
      NEW.original_byte_size IS NOT NULL OR NEW.original_filename IS NOT NULL OR
      NEW.failure_code IS NOT NULL OR NEW.failure_details IS NOT NULL OR
      NEW.processing_started_at IS NOT NULL OR NEW.processed_at IS NOT NULL OR
      NEW.activated_at IS NOT NULL OR NEW.retired_at IS NOT NULL OR NOT (
        (NEW.staging_storage_key IS NULL AND NEW.staging_checksum_sha256 IS NULL AND
          NEW.staging_byte_size IS NULL AND NEW.upload_filename IS NULL AND
          NEW.upload_mime_type IS NULL)
        OR
        (NEW.staging_storage_key IS NOT NULL AND NEW.staging_checksum_sha256 IS NOT NULL AND
          NEW.staging_byte_size IS NOT NULL AND NEW.upload_filename IS NOT NULL AND
          NEW.upload_mime_type IS NOT NULL)
      ) THEN
      RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid web revision creation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.title_id IS DISTINCT FROM OLD.title_id OR
    NEW.parent_revision_id IS DISTINCT FROM OLD.parent_revision_id OR
    NEW.created_by_actor_id IS DISTINCT FROM OLD.created_by_actor_id OR
    NEW.change_summary IS DISTINCT FROM OLD.change_summary OR
    NEW.staging_checksum_sha256 IS DISTINCT FROM OLD.staging_checksum_sha256 OR
    NEW.staging_byte_size IS DISTINCT FROM OLD.staging_byte_size OR
    NEW.upload_filename IS DISTINCT FROM OLD.upload_filename OR
    NEW.upload_mime_type IS DISTINCT FROM OLD.upload_mime_type OR
    NEW.derivation_version IS DISTINCT FROM OLD.derivation_version OR
    NEW.original_storage_key IS DISTINCT FROM OLD.original_storage_key OR
    NEW.original_checksum_sha256 IS DISTINCT FROM OLD.original_checksum_sha256 OR
    NEW.original_mime_type IS DISTINCT FROM OLD.original_mime_type OR
    NEW.original_byte_size IS DISTINCT FROM OLD.original_byte_size OR
    NEW.original_filename IS DISTINCT FROM OLD.original_filename OR
    NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid web revision mutation';
  END IF;

  IF OLD.state = 'failed' AND NEW.state = 'uploaded' AND
    OLD.staging_storage_key IS NOT NULL AND OLD.staging_checksum_sha256 IS NOT NULL AND
    OLD.staging_byte_size IS NOT NULL AND OLD.upload_filename IS NOT NULL AND
    OLD.upload_mime_type IS NOT NULL AND NEW.staging_storage_key IS NOT NULL AND
    NEW.staging_storage_key IS DISTINCT FROM OLD.staging_storage_key AND
    NEW.ingestion_generation = OLD.ingestion_generation + 1 AND
    NEW.processing_started_at IS NULL AND NEW.processed_at IS NULL AND
    NEW.failure_code IS NULL AND NEW.failure_details IS NULL AND
    NEW.activated_at IS NOT DISTINCT FROM OLD.activated_at AND
    NEW.retired_at IS NOT DISTINCT FROM OLD.retired_at THEN
    RETURN NEW;
  END IF;

  IF OLD.state IN ('ready_for_review', 'retired') AND NEW.state = 'active' AND
    NEW.staging_storage_key IS NOT DISTINCT FROM OLD.staging_storage_key AND
    NEW.ingestion_generation IS NOT DISTINCT FROM OLD.ingestion_generation AND
    NEW.processing_started_at IS NOT DISTINCT FROM OLD.processing_started_at AND
    NEW.processed_at IS NOT DISTINCT FROM OLD.processed_at AND
    NEW.failure_code IS NOT DISTINCT FROM OLD.failure_code AND
    NEW.failure_details IS NOT DISTINCT FROM OLD.failure_details AND
    NEW.activated_at IS NOT NULL AND NEW.retired_at IS NULL AND
    NEW.original_storage_key IS NOT NULL AND NEW.original_checksum_sha256 IS NOT NULL AND
    NEW.original_mime_type IS NOT NULL AND NEW.original_byte_size IS NOT NULL AND
    NEW.original_filename IS NOT NULL AND NEW.staging_storage_key IS NULL AND
    NEW.staging_checksum_sha256 IS NULL AND NEW.staging_byte_size IS NULL AND
    NEW.processing_started_at IS NOT NULL AND NEW.processed_at IS NOT NULL AND
    NEW.failure_code IS NULL AND NEW.failure_details IS NULL AND
    NEW.activated_at >= NEW.processed_at AND EXISTS (
      SELECT 1 FROM "public"."revision_presentations" presentation
      WHERE presentation.revision_id = NEW.id AND presentation.state = 'published'
    ) THEN
    RETURN NEW;
  END IF;

  IF OLD.state = 'active' AND NEW.state = 'retired' AND
    NEW.staging_storage_key IS NOT DISTINCT FROM OLD.staging_storage_key AND
    NEW.ingestion_generation IS NOT DISTINCT FROM OLD.ingestion_generation AND
    NEW.processing_started_at IS NOT DISTINCT FROM OLD.processing_started_at AND
    NEW.processed_at IS NOT DISTINCT FROM OLD.processed_at AND
    NEW.failure_code IS NOT DISTINCT FROM OLD.failure_code AND
    NEW.failure_details IS NOT DISTINCT FROM OLD.failure_details AND
    NEW.activated_at IS NOT DISTINCT FROM OLD.activated_at AND
    NEW.retired_at IS NOT NULL AND NEW.retired_at >= NEW.activated_at THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'invalid web revision transition';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "title_revisions_plan6b_web_write_guard"
BEFORE INSERT OR UPDATE ON "public"."title_revisions"
FOR EACH ROW EXECUTE FUNCTION "public"."plan6b_guard_title_revision_write"();--> statement-breakpoint
CREATE FUNCTION "public"."rearm_pending_stripe_event_job"(p_stripe_event_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'pg_catalog'
AS $$
DECLARE
  pending_event "public"."stripe_events"%ROWTYPE;
  exhausted_job "public"."jobs"%ROWTYPE;
  expected_payload jsonb;
  expected_deduplication_key text;
BEGIN
  IF p_stripe_event_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid Stripe event job rearm';
  END IF;
  SELECT * INTO pending_event
  FROM "public"."stripe_events" event
  WHERE event.id = p_stripe_event_id
  FOR UPDATE;
  IF NOT FOUND OR pending_event.status <> 'pending' THEN
    RETURN false;
  END IF;
  expected_payload := pg_catalog.jsonb_build_object('stripeEventId', pending_event.id);
  expected_deduplication_key := 'stripe:event:' || pending_event.provider_event_id;
  SELECT * INTO exhausted_job
  FROM "public"."jobs" queued_job
  WHERE queued_job.deduplication_key = expected_deduplication_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF exhausted_job.type <> 'commerce.stripe-event' OR
    exhausted_job.payload IS DISTINCT FROM expected_payload OR
    exhausted_job.max_attempts <> 12 THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'Stripe event job identity mismatch';
  END IF;
  IF exhausted_job.status <> 'failed' OR
    exhausted_job.attempts < exhausted_job.max_attempts THEN
    RETURN false;
  END IF;
  UPDATE "public"."jobs"
  SET status = 'pending', run_at = pg_catalog.transaction_timestamp(), attempts = 0,
    max_attempts = 12, locked_at = NULL, locked_by = NULL, last_error = NULL,
    rerun_requested_at = NULL, completed_at = NULL,
    updated_at = pg_catalog.transaction_timestamp()
  WHERE id = exhausted_job.id;
  RETURN true;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION "public"."rearm_pending_stripe_event_job"(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "public"."rearm_pending_stripe_event_job"(uuid) TO "pale_orbit_runtime";--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON TABLE "public"."orders" FROM "pale_orbit_runtime";--> statement-breakpoint
GRANT INSERT (
  "initiating_user_id",
  "purchase_email",
  "currency",
  "subtotal_minor",
  "client_checkout_attempt_id",
  "quote_fingerprint_sha256",
  "status_token_sha256"
) ON TABLE "public"."orders" TO "pale_orbit_runtime";--> statement-breakpoint
GRANT UPDATE (
  "status",
  "stripe_checkout_session_id",
  "checkout_expires_at",
  "updated_at"
) ON TABLE "public"."orders" TO "pale_orbit_runtime";--> statement-breakpoint
GRANT UPDATE ON TABLE "public"."orders" TO "pale_orbit_financial_worker";--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON TABLE "public"."order_items" FROM "pale_orbit_runtime";--> statement-breakpoint
GRANT INSERT (
  "order_id",
  "title_id",
  "title_snapshot",
  "creator_name_snapshot",
  "format",
  "currency",
  "unit_subtotal_minor"
) ON TABLE "public"."order_items" TO "pale_orbit_runtime";--> statement-breakpoint
GRANT UPDATE ON TABLE "public"."order_items" TO "pale_orbit_financial_worker";--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON TABLE "public"."jobs" FROM "pale_orbit_runtime";--> statement-breakpoint
GRANT INSERT (
  "type",
  "payload",
  "deduplication_key",
  "run_at",
  "max_attempts"
) ON TABLE "public"."jobs" TO "pale_orbit_runtime";--> statement-breakpoint
GRANT UPDATE ON TABLE "public"."jobs" TO "pale_orbit_financial_worker";--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON TABLE "public"."outbox_messages" FROM "pale_orbit_runtime";--> statement-breakpoint
GRANT INSERT (
  "id",
  "topic",
  "payload",
  "deduplication_key",
  "dispatch_job_id"
) ON TABLE "public"."outbox_messages" TO "pale_orbit_runtime";--> statement-breakpoint
GRANT UPDATE (
  "status",
  "last_error",
  "delivered_at",
  "updated_at"
) ON TABLE "public"."outbox_messages" TO "pale_orbit_financial_worker";--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON TABLE "public"."title_revisions" FROM "pale_orbit_runtime";--> statement-breakpoint
GRANT INSERT (
  "title_id",
  "parent_revision_id",
  "created_by_actor_id",
  "change_summary",
  "staging_storage_key",
  "staging_checksum_sha256",
  "staging_byte_size",
  "upload_filename",
  "upload_mime_type"
) ON TABLE "public"."title_revisions" TO "pale_orbit_runtime";--> statement-breakpoint
GRANT UPDATE (
  "state",
  "staging_storage_key",
  "ingestion_generation",
  "processing_started_at",
  "processed_at",
  "failure_code",
  "failure_details",
  "activated_at",
  "retired_at"
) ON TABLE "public"."title_revisions" TO "pale_orbit_runtime";--> statement-breakpoint
GRANT UPDATE ON TABLE "public"."title_revisions" TO "pale_orbit_financial_worker";--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE ON TABLE
  "public"."prose_sections",
  "public"."prose_images",
  "public"."prose_blocks",
  "public"."comic_pages",
  "public"."revision_cover_suggestions",
  "public"."revision_ingestion_warnings"
FROM "pale_orbit_runtime";--> statement-breakpoint
GRANT INSERT, DELETE ON TABLE
  "public"."prose_sections",
  "public"."prose_images",
  "public"."prose_blocks",
  "public"."comic_pages",
  "public"."revision_cover_suggestions",
  "public"."revision_ingestion_warnings"
TO "pale_orbit_financial_worker";
