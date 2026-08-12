import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

const PROVIDER_TABLES = [
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
  'stripe_balance_transactions',
  'stripe_payouts',
  'refund_allocation_drafts',
  'refund_allocation_draft_items',
  'financial_reconciliation_issues'
] as const;

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
    const combined = `${provider}\n${allocation}\n${migration}`;

    for (const tableName of [...PROVIDER_TABLES, ...ALLOCATION_TABLES]) {
      expect(migration).toContain(`"${tableName}"`);
    }
    expect(migration).toContain('current_financial_projection_heads');
    expect(migration).toContain('current_financial_projection_items');

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
});
