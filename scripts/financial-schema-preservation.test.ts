import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getViewConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  currentFinancialProjectionHeads,
  currentFinancialProjectionItems
} from '../src/lib/server/db/schema/financial-allocation';

function source(relativePath: string): string {
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

const PROVIDER_TABLES = [
  'financial_projection_versions',
  'financial_payout_discovery_state',
  'stripe_balance_transactions',
  'stripe_balance_transaction_fee_details',
  'financial_classification_versions',
  'stripe_payouts',
  'payout_import_runs',
  'payout_import_run_entries',
  'stripe_payout_balance_transactions',
  'financial_scan_runs'
] as const;

const ALLOCATION_TABLES = [
  'financial_allocation_sets',
  'financial_item_allocations',
  'financial_reconciliation_issues',
  'refund_allocation_components',
  'dispute_item_allocations',
  'refund_allocation_drafts',
  'refund_allocation_draft_items',
  'refund_reporting_correction_sets',
  'refund_reporting_correction_items',
  'refund_allocation_finalization_effects'
] as const;

const ROW_ALIASES = [
  'FinancialProjectionVersionRow',
  'FinancialPayoutDiscoveryStateRow',
  'StripeBalanceTransactionRow',
  'StripeBalanceTransactionFeeDetailRow',
  'FinancialClassificationVersionRow',
  'StripePayoutRow',
  'PayoutImportRunRow',
  'PayoutImportRunEntryRow',
  'StripePayoutBalanceTransactionRow',
  'FinancialScanRunRow',
  'FinancialAllocationSetRow',
  'FinancialItemAllocationRow',
  'FinancialIssueRow',
  'RefundAllocationComponentRow',
  'DisputeItemAllocationRow',
  'RefundAllocationDraftRow',
  'RefundAllocationDraftItemRow',
  'RefundReportingCorrectionSetRow',
  'RefundReportingCorrectionItemRow',
  'RefundAllocationFinalizationEffectRow'
] as const;

const IMMUTABLE_GUARD_TABLES = [
  'stripe_balance_transaction_fee_details',
  'financial_classification_versions',
  'stripe_payout_balance_transactions',
  'financial_allocation_sets',
  'financial_item_allocations',
  'refund_allocation_components',
  'dispute_item_allocations',
  'refund_reporting_correction_sets',
  'refund_reporting_correction_items',
  'refund_allocation_finalization_effects',
  'refund_allocations'
] as const;

const NARROW_UPDATE_GUARD_TABLES = [
  'financial_projection_versions',
  'stripe_balance_transactions',
  'stripe_payouts',
  'refund_allocation_drafts',
  'refund_allocation_draft_items',
  'financial_reconciliation_issues'
] as const;

function renderedProjectionHeads(): string {
  return getViewConfig(currentFinancialProjectionHeads).query.toQuery({
    casing: {} as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value}'`
  }).sql.replaceAll('\r\n', '\n');
}

function renderedProjectionItems(): string {
  return getViewConfig(currentFinancialProjectionItems).query.toQuery({
    casing: {} as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value}'`
  }).sql.replaceAll('\r\n', '\n');
}

function triggerAttachment(tableName: string): RegExp {
  return new RegExp(
    `create\\s+trigger\\s+"?[a-z0-9_]+"?\\s+before\\s+(?:update\\s+or\\s+delete|delete\\s+or\\s+update)\\s+on\\s+"?(?:public\\.)?"?${tableName}"?`,
    'iu'
  );
}

describe('Plan 6B financial schema preservation', () => {
  it('keeps provider, allocation, view, and row contracts in project-owned modules', () => {
    const provider = source('../src/lib/server/db/schema/financial-provider.ts');
    const allocation = source('../src/lib/server/db/schema/financial-allocation.ts');
    const schemaIndex = source('../src/lib/server/db/schema/index.ts');

    for (const tableName of PROVIDER_TABLES) {
      expect(provider).toMatch(new RegExp(`pgTable\\(\\s*'${tableName}'`, 'u'));
    }
    for (const tableName of ALLOCATION_TABLES) {
      expect(allocation).toMatch(new RegExp(`pgTable\\(\\s*'${tableName}'`, 'u'));
    }
    expect(allocation).toMatch(/pgView\(\s*'current_financial_projection_heads'/u);
    expect(allocation).toMatch(/pgView\(\s*'current_financial_projection_items'/u);
    for (const alias of ROW_ALIASES) {
      expect(`${provider}\n${allocation}`).toContain(`export type ${alias} =`);
      expect(`${provider}\n${allocation}`).toContain(`export type New${alias} =`);
    }
    expect(schemaIndex).toContain("export * from './financial-provider';");
    expect(schemaIndex).toContain("export * from './financial-allocation';");
  });

  it('keeps generated SQL complete and structurally free of sensitive provider data', () => {
    const provider = source('../src/lib/server/db/schema/financial-provider.ts');
    const allocation = source('../src/lib/server/db/schema/financial-allocation.ts');
    const migration = source('../drizzle/0007_plan6b_financial_reconciliation.sql');
    const snapshot = source('../drizzle/meta/0007_snapshot.json');
    const combined = `${provider}\n${allocation}\n${migration}\n${snapshot}`;

    for (const tableName of [...PROVIDER_TABLES, ...ALLOCATION_TABLES]) {
      expect(migration).toContain(`"${tableName}"`);
    }
    expect(migration).toContain('current_financial_projection_heads');
    expect(migration).toContain('current_financial_projection_items');
    const projectionHeads = renderedProjectionHeads();
    const snapshotJson = JSON.parse(snapshot) as {
      views: Record<string, { definition: string }>;
    };
    expect(
      snapshotJson.views['public.current_financial_projection_heads']?.definition.replaceAll(
        '\r\n',
        '\n'
      )
    ).toBe(projectionHeads);
    expect(migration.replaceAll('\r\n', '\n')).toContain(
      `CREATE VIEW "public"."current_financial_projection_heads" AS (${projectionHeads}\n);`
    );
    const projectionItems = renderedProjectionItems();
    expect(
      snapshotJson.views['public.current_financial_projection_items']?.definition.replaceAll(
        '\r\n',
        '\n'
      )
    ).toBe(projectionItems);
    expect(migration.replaceAll('\r\n', '\n')).toContain(
      `CREATE VIEW "public"."current_financial_projection_items" AS (${projectionItems}\n);`
    );
    for (const generatedContract of [migration, snapshot]) {
      expect(generatedContract).toContain('financial_projection_versions');
      expect(generatedContract).toMatch(
        /classifier_version\s*=\s*active_projection_version\.classifier_version/iu
      );
      expect(generatedContract).toMatch(
        /algorithm_version\s*=\s*active_projection_version\.allocation_algorithm_version/iu
      );
      expect(generatedContract).toContain('current_parent_classification_candidates');
      expect(generatedContract).toContain('current_fee_detail_classification_candidates');
      expect(generatedContract).toContain('current_fee_classification_candidates');
      expect(generatedContract).not.toMatch(/classifier_version\s*=\s*1/iu);
      expect(generatedContract).not.toMatch(/algorithm_version\s*=\s*1/iu);
      expect(generatedContract).toContain('correction_rebase_required');
      expect(generatedContract).toContain("resource_type = 'balance_transaction'");
      expect(generatedContract).toMatch(
        /group\s+by\s+(?:"?detail"?\.)?"?balance_transaction_id"?,\s*(?:"?detail"?\.)?"?id"?/iu
      );
      expect(generatedContract).toContain('fee_detail_amount_sum');
      expect(generatedContract).toContain('invalid_delta_group_count');
      expect(generatedContract).toContain('invalid_settlement_arithmetic_count');
      expect(generatedContract).toContain('invalid_presentment_arithmetic_count');
      expect(generatedContract).toContain('presentment_capacity_status');
      expect(generatedContract).toMatch(/base_item_count\s*=\s*0\s+and\s+expected_effect_minor\s*<>\s*0/iu);
    }
    for (const generatedContract of [allocation, migration, snapshot]) {
      expect(generatedContract).toContain('financial_allocation_sets_reversal_root_unique');
      expect(generatedContract).toMatch(
        /reversal_of_set_id[\s\S]+?supersedes_set_id[\s\S]+?is\s+null/iu
      );
    }

    const forbiddenColumnDeclarations = [
      /(?:varchar|text|jsonb)\(['"]raw_(?:payload|response)['"]/u,
      /(?:varchar|text|jsonb)\(['"]provider_(?:payload|message)['"]/u,
      /(?:varchar|text|jsonb)\(['"](?:description|destination|statement_descriptor|metadata)['"]/u,
      /(?:varchar|text|jsonb)\(['"](?:customer|billing|card|payment_method)['"]/u,
      /(?:varchar|text|jsonb)\(['"](?:receipt_url|action_url|client_secret|secret_key|webhook_secret)['"]/u,
      /"(?:raw_payload|raw_response|provider_payload|provider_message|destination|statement_descriptor|metadata|customer|billing_address|card_number|receipt_url|action_url|client_secret|secret_key|webhook_secret)"\s/u
    ];
    for (const forbidden of forbiddenColumnDeclarations) {
      expect(combined).not.toMatch(forbidden);
    }
  });

  it('keeps the 0006-to-0007 backfill fact-derived and transactionally defensive', () => {
    const migration = source('../drizzle/0007_plan6b_financial_reconciliation.sql');

    expect(migration).toMatch(/\bcase\b[\s\S]+?"reconciliation_status"/iu);
    expect(migration).toMatch(
      /update\s+"payments"[\s\S]+?"financial_evidence_status"/iu
    );
    expect(migration).toMatch(
      /update\s+"refunds"[\s\S]+?"allocation_status"[\s\S]+?"financial_evidence_status"/iu
    );
    expect(migration).toMatch(
      /update\s+"disputes"[\s\S]+?"financial_evidence_status"/iu
    );
    expect(migration).toMatch(
      /insert\s+into\s+"refund_allocation_components"[\s\S]+?"subtotal_minor"[\s\S]+?"tax_minor"/iu
    );
    expect(migration).toMatch(
      /insert\s+into\s+"financial_reconciliation_issues"[\s\S]+?allocation_incomplete/iu
    );
    expect(migration).toMatch(
      /raise\s+exception[\s\S]+?(?:over[-_ ]allocation|capacity)/iu
    );
    expect(migration).toMatch(
      /raise\s+exception[\s\S]+?(?:currency|cross[-_ ]currency)/iu
    );
    expect(migration).toMatch(
      /raise\s+exception[\s\S]+?(?:partial|incomplete)[-_ ](?:allocation|facts?)/iu
    );

    expect(migration).not.toMatch(
      /"reconciliation_status"\s*::\s*(?:text\s*::\s*)?"?financial_evidence_status"?/iu
    );
    expect(migration).not.toMatch(
      /when\s+['"]?reconciled['"]?\s+then\s+['"]?fee_reconciled['"]?/iu
    );

    for (const tableName of ['payments', 'refunds', 'disputes'] as const) {
      const backfillPosition = migration.search(
        new RegExp(`update\\s+"${tableName}"`, 'iu')
      );
      const dropPosition = migration.search(
        new RegExp(
          `alter\\s+table\\s+"${tableName}"\\s+drop\\s+column\\s+"reconciliation_status"`,
          'iu'
        )
      );
      expect(backfillPosition).toBeGreaterThanOrEqual(0);
      expect(dropPosition).toBeGreaterThan(backfillPosition);
    }
  });

  it('keeps every durable financial-history guard attached in migration 0007', () => {
    const migration = source('../drizzle/0007_plan6b_financial_reconciliation.sql');
    const schema = source('../src/lib/server/db/schema/financial-allocation.ts');
    const snapshot = source('../drizzle/meta/0007_snapshot.json');

    expect(migration).toMatch(/create\s+(?:or\s+replace\s+)?function/iu);
    expect(migration).toMatch(/raise\s+exception[\s\S]+?errcode\s*=\s*'55000'/iu);

    for (const tableName of [...IMMUTABLE_GUARD_TABLES, ...NARROW_UPDATE_GUARD_TABLES]) {
      expect(migration, `${tableName} must have an UPDATE/DELETE guard`).toMatch(
        triggerAttachment(tableName)
      );
    }

    expect(migration).toMatch(/pending[\s\S]+?available/iu);
    expect(migration).toMatch(/last_imported_at/iu);
    expect(migration).toMatch(/financial_generation/iu);
    expect(migration).toMatch(/state[\s\S]+?active[\s\S]+?finalized/iu);
    expect(migration).toMatch(/occurrence_count/iu);
    expect(migration).toMatch(/resolved_at/iu);
    expect(migration).toContain('CREATE FUNCTION "public"."resolve_financial_reconciliation_issue"');
    const resolver = migration.slice(
      migration.indexOf('CREATE FUNCTION "public"."resolve_financial_reconciliation_issue"'),
      migration.indexOf('CREATE FUNCTION "public"."plan6b_validate_issue_transition"')
    );
    expect(resolver).toMatch(
      /p_issue_id uuid,\s+p_resolved_by_admin_id uuid,\s+p_actor_type "public"\."audit_actor_type",\s+p_actor_id text,\s+p_correlation_id text/iu
    );
    expect(resolver).toContain('FROM "public"."financial_reconciliation_issues" issue');
    expect(resolver).toContain('FROM "public"."user_roles" resolver_role');
    expect(resolver).toContain("resolver_role.role = 'admin'");
    expect(resolver).toContain('UPDATE "public"."financial_reconciliation_issues"');
    expect(resolver).toContain('INSERT INTO "public"."audit_events"');
    expect(resolver).toContain("char_length(p_actor_id) NOT BETWEEN 1 AND 100");
    expect(resolver).toContain("char_length(p_correlation_id) NOT BETWEEN 1 AND 100");
    expect(resolver.indexOf("immutable classification diagnostics cannot be resolved"))
      .toBeLessThan(resolver.indexOf("set_config('pale_orbit.financial_issue_resolution'"));
    expect(resolver.indexOf('UPDATE "public"."financial_reconciliation_issues"'))
      .toBeLessThan(resolver.indexOf('INSERT INTO "public"."audit_events"'));
    expect(resolver).toContain("'financial.issue.resolved'");
    expect(resolver).toContain("'financial_issue'");
    expect(resolver).toContain("set_config('pale_orbit.financial_issue_resolution', p_issue_id::text, true)");
    expect(migration).toContain("current_setting('pale_orbit.financial_issue_resolution', true) IS DISTINCT FROM OLD.id::text");
    expect(migration).toContain('GET DIAGNOSTICS call_context = PG_CONTEXT');
    expect(migration).toContain(
      "call_context !~ E'(^|\\\\n)PL/pgSQL function resolve_financial_reconciliation_issue\\\\(uuid,uuid,audit_actor_type,text,text\\\\) line [0-9]+ at SQL statement($|\\\\n)'"
    );
    expect(migration).toContain('CREATE FUNCTION "public"."plan6b_validate_issue_insert"');
    expect(migration).toMatch(
      /CREATE TRIGGER "financial_reconciliation_issues_validate_insert" BEFORE INSERT ON "financial_reconciliation_issues"/u
    );
    expect(migration).toContain('financial_reconciliation_issues_immutable_classification_open');
    expect(schema).toMatch(
      /table\.resourceType[^\n]+financial_classification[^\n]+table\.safeCode[^\n]+unsupported_category[^\n]+table\.state[^\n]+open/u
    );
    expect(snapshot).toMatch(
      /resource_type[^\n]+financial_classification[^\n]+safe_code[^\n]+unsupported_category[^\n]+state[^\n]+open/iu
    );
  });

  it('ships a fail-closed worker-only issue-resolution authority boundary after migration 0007', () => {
    const lockdown = source('../drizzle/0008_plan6b_worker_issue_resolution.sql');
    const migration = source('../drizzle/0009_plan6b_worker_authority_and_commerce_integrity.sql');

    expect(lockdown).toContain('pg_catalog.to_regprocedure(');
    expect(lockdown).toContain(
      'public.resolve_financial_reconciliation_issue(uuid,uuid,public.audit_actor_type,text,text)'
    );
    expect(lockdown).toContain("function_row.prokind = 'f'");
    expect(lockdown).not.toContain('pronargs');
    expect(lockdown).toContain("'DROP FUNCTION %s'");
    expect(lockdown).not.toContain('resolve_financial_issue_after_worker_recompute');
    expect(migration).toContain('CREATE ROLE "pale_orbit_runtime" NOLOGIN');
    expect(migration).toContain('CREATE ROLE "pale_orbit_financial_worker" NOLOGIN');
    expect(migration).toContain(
      'ALTER ROLE "pale_orbit_runtime" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS'
    );
    expect(migration).toContain(
      'ALTER ROLE "pale_orbit_financial_worker" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS'
    );
    expect(migration).toContain('FROM pg_catalog.pg_auth_members membership');
    expect(migration).toContain('pg_catalog.aclexplode');
    expect(migration).toContain('pg_catalog.pg_parameter_acl');
    expect(migration).toContain('pg_catalog.pg_default_acl');
    expect(migration).toContain('pg_catalog.pg_db_role_setting');
    expect(migration).toContain('pg_catalog.pg_shdepend');
    expect(migration).toContain('WITH ADMIN FALSE, INHERIT TRUE, SET FALSE');
    expect(migration).toContain('unsafe pre-existing Plan 6B database authority roles');
    expect(migration).toContain('financial_reconciliation_issues_semantic_identity');
    expect(migration).toContain('invalid legacy financial issue resource/code identity');
    expect(migration).toContain('financial_reconciliation_issues_semantic_impact');
    expect(migration).toContain('invalid legacy financial issue impact');
    expect(migration).toContain('invalid legacy financial issue resource identity');
    expect(migration).toContain('missing legacy unknown classification issue');
    expect(migration).toContain('invalid legacy financial issue resolution audit provenance');
    expect(migration).toContain("audit.actor_id = 'commerce-worker'");
    expect(migration).toMatch(
      /resource_type = 'dispute'[\s\S]*resource_type = 'allocation_set'[\s\S]*'allocation_mismatch'[\s\S]*'unsupported_category'/u
    );
    expect(migration).toMatch(
      /resource_type in \('payment', 'refund', 'dispute', 'allocation_set'\)[\s\S]*safe_code in \([\s\S]*'allocation_fork'[\s\S]*'unsupported_category'[\s\S]*resource_type = 'payout'[\s\S]*'payout_membership_conflict'[\s\S]*resource_type = 'balance_transaction'[\s\S]*'classification_fork'[\s\S]*resource_type = 'financial_classification'[\s\S]*safe_code = 'unsupported_category'/u
    );
    expect(migration).toMatch(
      /safe_code in \('allocation_incomplete', 'missing_source'\)[\s\S]*impact = 'pending'[\s\S]*impact = 'exception'/u
    );
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION "public"."plan6b_validate_issue_insert"'
    );
    expect(migration).toContain('FOR KEY SHARE');
    expect(migration).toContain(
      'CREATE FUNCTION "public"."plan6b_validate_unknown_classification_issue"'
    );
    expect(migration).toContain('financial_classification_versions_unknown_issue_required');
    expect(migration).toContain(
      'CREATE FUNCTION "public"."plan6b_guard_financial_issue_subject_mutation"'
    );
    for (const trigger of [
      'payments_financial_issue_subject_guard',
      'refunds_financial_issue_subject_guard',
      'disputes_financial_issue_subject_guard'
    ]) expect(migration).toContain(trigger);
    expect(migration).toContain('REVOKE ALL ON SCHEMA "public" FROM PUBLIC');
    expect(migration).toContain(
      'CREATE FUNCTION "public"."resolve_financial_issue_after_worker_recompute"'
    );
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain("SET search_path = 'pg_catalog'");
    expect(migration).toContain("'system'::\"public\".\"audit_actor_type\"");
    expect(migration).toContain("'financial-worker'");
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION "public"."resolve_financial_issue_after_worker_recompute"(uuid,text) FROM PUBLIC'
    );
    expect(migration).toContain(
      'GRANT EXECUTE ON FUNCTION "public"."resolve_financial_issue_after_worker_recompute"(uuid,text) TO "pale_orbit_financial_worker"'
    );
    expect(migration).toContain('current_user IS DISTINCT FROM');
    expect(migration).toContain(
      "'public.resolve_financial_issue_after_worker_recompute(uuid,text)'::pg_catalog.regprocedure"
    );
    expect(migration).not.toContain('PG_CONTEXT');
    expect(migration).not.toContain('p_actor_type');
    expect(migration).not.toContain('p_actor_id');
    expect(migration).not.toContain('p_resolved_by_admin_id');
  });

  it('locks and rejects contradictory legacy payout membership and source-principal evidence before 0009', () => {
    const migration = source('../drizzle/0009_plan6b_worker_authority_and_commerce_integrity.sql');
    const lockStatement = migration.match(/(?:^|\r?\n)LOCK TABLE[\s\S]*?IN SHARE ROW EXCLUSIVE MODE;/u)?.[0];
    const principalPreflight = migration.match(
      /IF EXISTS \([\s\S]*?invalid legacy fee-reconciled source principal parity[\s\S]*?END IF;/u
    )?.[0];

    expect(lockStatement).toBeDefined();
    expect(lockStatement).toContain('"stripe_payout_balance_transactions"');
    expect(migration).toContain('invalid legacy payout membership currency');
    expect(migration).toMatch(
      /stripe_payout_balance_transactions[\s\S]*?stripe_payouts[\s\S]*?stripe_balance_transactions[\s\S]*?balance\.currency is distinct from payout\.currency/iu
    );
    expect(principalPreflight).toBeDefined();
    expect(principalPreflight).toContain('first_dispute_withdrawal_balance');
    expect(principalPreflight).toMatch(
      /balance\.source_family = 'charge'[\s\S]*?balance\.source_id = payment\.stripe_latest_charge_id[\s\S]*?balance\.reporting_category = 'charge'[\s\S]*?payment\.financial_evidence_status = 'fee_reconciled'[\s\S]*?balance\.currency = payment\.currency[\s\S]*?balance\.amount_minor <> payment\.amount_minor/u
    );
    expect(principalPreflight).toMatch(
      /balance\.source_family = 'refund'[\s\S]*?balance\.source_id = refund\.stripe_refund_id[\s\S]*?balance\.reporting_category = 'refund'[\s\S]*?refund\.financial_evidence_status = 'fee_reconciled'[\s\S]*?balance\.currency = refund\.currency[\s\S]*?balance\.amount_minor <> -refund\.amount_minor/u
    );
    expect(principalPreflight).toMatch(
      /first_dispute_withdrawal_balance[\s\S]*?reporting_category = 'dispute'[\s\S]*?provider_created_at[\s\S]*?provider_id collate "C"[\s\S]*?classification = 'dispute_withdrawal'[\s\S]*?sum\(presentment\.total_effect_minor\)[\s\S]*?<>\s*-first_withdrawal\.amount_minor/iu
    );
    expect(principalPreflight).not.toMatch(
      /reporting_category = 'dispute_reversal'[\s\S]*?amount_minor <> -dispute\.amount_minor/u
    );
    expect(principalPreflight).not.toMatch(
      /reporting_category = 'fee'[\s\S]*?amount_minor <> -dispute\.amount_minor/u
    );
  });

  it('binds every dispute presentment row to its exact dispute gross allocation set', () => {
    const migration = source('../drizzle/0007_plan6b_financial_reconciliation.sql');

    expect(migration).toContain('financial_allocation_sets_source_identity_unique');
    expect(migration).toContain('dispute_item_allocations_gross_set_graph_fk');
    expect(migration).toContain('CREATE FUNCTION "public"."plan6b_validate_dispute_gross_allocation_set"');
    expect(migration).toMatch(
      /source_kind[\s\S]+?=\s*'dispute'[\s\S]+?basis[\s\S]+?=\s*'gross_amount'/iu
    );
    expect(migration).toMatch(
      /create\s+trigger\s+"dispute_item_allocations_validate_gross_set"\s+before\s+insert\s+on\s+"dispute_item_allocations"/iu
    );
  });

  it('resets and reseeds the singleton active projection pair in integration cleanup', () => {
    const setup = source('../tests/integration/setup.ts');

    expect(setup).toMatch(/truncate table[\s\S]+?financial_projection_versions/iu);
    expect(setup).toMatch(
      /insert\s+into\s+financial_projection_versions[\s\S]+?values\s*\(true,\s*1,\s*1,/iu
    );
  });
});
