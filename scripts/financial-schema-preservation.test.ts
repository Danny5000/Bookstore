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
    expect(migration).toContain("set_config('pale_orbit.financial_issue_resolution', p_issue_id::text, true)");
    expect(migration).toContain("current_setting('pale_orbit.financial_issue_resolution', true) IS DISTINCT FROM OLD.id::text");
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
