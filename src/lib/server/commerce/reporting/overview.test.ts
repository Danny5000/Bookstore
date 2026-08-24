import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { AuthorizationError, type Actor } from '$lib/server/auth/admin-policy';
import {
  SALES_CURRENCY_SUMMARY_DTO_KEYS,
  TITLE_SALES_ROW_DTO_KEYS
} from '$lib/types/financial-reporting';
import {
  decodeSalesCursor,
  fingerprintSalesFilters,
  type SalesOverviewFilters
} from './filters';
import {
  SALES_OVERVIEW_DTO_KEYS,
  SALES_OVERVIEW_FILTER_DTO_KEYS,
  canExportSalesOverview,
  loadSalesAggregateRows,
  loadSalesDataThroughAt,
  listSalesOverview
} from './overview';

const dialect = new PgDialect();
const admin: Actor = {
  type: 'user',
  id: '00000000-0000-4000-8000-000000006001',
  roles: ['admin']
};
const filters: SalesOverviewFilters = {
  range: 'custom',
  from: new Date('2026-08-01T00:00:00.000Z'),
  to: new Date('2026-08-21T00:00:00.000Z'),
  sort: 'gross_desc',
  pageSize: 50
};

function titleId(index = 1): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function completeRow(index = 1, overrides: Record<string, unknown> = {}) {
  return {
    titleId: titleId(index),
    currentTitle: 'Pale Orbit',
    format: 'prose',
    archived: false,
    soldAsVariants: [{ title: 'Sold as Pale Orbit', creatorName: 'A. Writer', format: 'prose' }],
    presentmentCurrency: 'USD',
    settlementCurrency: 'USD',
    soldCopies: '2',
    fullyRefundedCopies: '1',
    netCopies: '1',
    grossPresentmentMinor: '2000',
    finalizedRefundPresentmentMinor: '1000',
    disputeWithdrawalPresentmentMinor: '0',
    disputeReinstatementPresentmentMinor: '0',
    grossSettlementMinor: '1900',
    refundImpactMinor: '-950',
    disputeImpactMinor: '0',
    processingFeeImpactMinor: '-60',
    refundFeeImpactMinor: '10',
    disputeFeeImpactMinor: '0',
    otherFeeImpactMinor: '0',
    estimatedPayoutMinor: '900',
    settlementMetricsComplete: true,
    missingSourceCount: '0',
    state: 'fee_reconciled',
    freshnessAt: '2026-08-21 12:00:00.123456+00',
    ...overrides
  };
}

function incompleteRow(index = 2, overrides: Record<string, unknown> = {}) {
  return completeRow(index, {
    settlementCurrency: 'USD',
    grossSettlementMinor: null,
    refundImpactMinor: null,
    disputeImpactMinor: null,
    processingFeeImpactMinor: null,
    refundFeeImpactMinor: null,
    disputeFeeImpactMinor: null,
    otherFeeImpactMinor: null,
    estimatedPayoutMinor: null,
    settlementMetricsComplete: false,
    missingSourceCount: '2',
    state: 'pending',
    ...overrides
  });
}

function summary(overrides: Record<string, unknown> = {}) {
  const row = Object.fromEntries(Object.entries(completeRow()).filter(([key]) =>
    !['titleId', 'currentTitle', 'format', 'archived', 'soldAsVariants', 'freshnessAt'].includes(key)
  ));
  return { titleCount: '1', ...row, ...overrides };
}

function databaseWith(rows: readonly (readonly unknown[])[]) {
  const queue = [...rows];
  const execute = vi.fn(async (_query: unknown) => ({ rows: queue.shift() ?? [] }));
  const transaction = vi.fn(async (work: (transaction: { execute: typeof execute }) => unknown) =>
    work({ execute })
  );
  return {
    database: { transaction } as never,
    execute,
    transaction
  };
}

function successfulDatabase(
  pageRows: readonly unknown[] = [completeRow()],
  summaryRows: readonly unknown[] = [summary()],
  reviewRows: readonly unknown[] = [{ needsReviewCount: '3' }],
  freshnessRows: readonly unknown[] = [{
    sourceCompletedAt: '2026-08-21 12:00:00+00',
    payoutCompletedAt: '2026-08-21 11:00:00+00',
    projectionCompletedAt: '2026-08-21 13:00:00+00'
  }]
) {
  return databaseWith([pageRows, summaryRows, reviewRows, freshnessRows]);
}

function normalizedSql(call: unknown): string {
  return dialect.sqlToQuery(call as never).sql.replaceAll('"', '').replace(/\s+/gu, ' ').trim();
}

describe('sales overview read model', () => {
  it('derives the optional export affordance through the injected capability resolver', () => {
    const salesReadOnly = () => new Set(['sales.read'] as const);
    const salesExportOnly = () => new Set(['sales.export'] as const);
    const salesExporter = () => new Set(['sales.read', 'sales.export'] as const);

    expect(canExportSalesOverview(admin, { capabilityResolver: salesReadOnly })).toBe(false);
    expect(canExportSalesOverview(admin, { capabilityResolver: salesExportOnly })).toBe(false);
    expect(canExportSalesOverview(admin, { capabilityResolver: salesExporter })).toBe(true);
    expect(canExportSalesOverview({ type: 'anonymous' }, {
      capabilityResolver: salesExporter
    })).toBe(false);
  });

  it('loads a bounded aggregate in the shared deterministic order while explicitly omitting cursor', async () => {
    const cursor = {
      filterFingerprint: fingerprintSalesFilters(filters),
      primary: 2_000,
      titleId: titleId(20),
      presentmentCurrency: 'USD',
      settlementCurrency: 'USD'
    } as const;
    const { execute } = databaseWith([[completeRow()]]);

    const rows = await loadSalesAggregateRows(
      { execute } as never,
      { ...filters, cursor },
      { applyCursor: false, limit: 10_001 }
    );

    expect(rows).toHaveLength(1);
    const statement = normalizedSql(execute.mock.calls[0]![0]);
    expect(statement).toContain('gross_presentment_minor desc');
    expect(statement).not.toMatch(/gross_presentment_minor < \$\d+/u);
    expect(statement).toMatch(/limit \$\d+$/u);
    expect(dialect.sqlToQuery(execute.mock.calls[0]![0] as never).params.at(-1)).toBe(10_001);
  });

  it('loads and validates the shared global data-through timestamp', async () => {
    const { execute } = databaseWith([{
      sourceCompletedAt: '2026-08-21 12:00:00+00',
      payoutCompletedAt: '2026-08-21 11:00:00+00',
      projectionCompletedAt: '2026-08-21 13:00:00+00'
    }].map((row) => [row]));

    await expect(loadSalesDataThroughAt({ execute } as never)).resolves.toBe(
      '2026-08-21T11:00:00.000Z'
    );
  });

  it('authorizes sales.read before opening a transaction or issuing a query', async () => {
    const { database, transaction } = successfulDatabase();
    await expect(listSalesOverview(database, admin, filters, {
      capabilityResolver: () => new Set(),
      stripeEnabled: false
    })).rejects.toEqual(new AuthorizationError('forbidden', 403));
    expect(transaction).not.toHaveBeenCalled();
  });

  it('constructs only the exact browser-safe DTO and normalizes database values', async () => {
    const { database } = successfulDatabase();
    const result = await listSalesOverview(database, admin, filters, { stripeEnabled: true });

    expect(Object.keys(result)).toEqual(SALES_OVERVIEW_DTO_KEYS);
    expect(Object.keys(result.filters)).toEqual(SALES_OVERVIEW_FILTER_DTO_KEYS);
    expect(result.filters).toEqual({
      range: 'custom',
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-21T00:00:00.000Z',
      titleId: null,
      format: null,
      presentmentCurrency: null,
      settlementCurrency: null,
      state: null,
      sort: 'gross_desc'
    });
    expect(Object.keys(result.rows[0]!)).toEqual(TITLE_SALES_ROW_DTO_KEYS);
    expect(Object.keys(result.summaries[0]!)).toEqual(SALES_CURRENCY_SUMMARY_DTO_KEYS);
    expect(result.rows[0]).toMatchObject({
      grossPresentmentMinor: 2000,
      refundImpactMinor: -950,
      estimatedPayoutMinor: 900,
      freshnessAt: '2026-08-21T12:00:00.123Z'
    });
    expect(result).toMatchObject({
      nextCursor: null,
      dataThroughAt: '2026-08-21T11:00:00.000Z',
      stripeEnabled: true,
      missingSourceCount: 0,
      needsReviewCount: 3
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(
      /providerId|customer|email|fingerprint|checkpoint|balanceTransactionId/iu
    );
    expect(serialized).not.toMatch(/stripe(?!Enabled\b)[A-Z]/u);
  });

  it('uses bounded local SQL with immutable cohorts, current projections, and current corrections', async () => {
    const { database, execute } = successfulDatabase();
    await listSalesOverview(database, admin, filters, { stripeEnabled: false });
    expect(execute).toHaveBeenCalledTimes(4);

    const page = normalizedSql(execute.mock.calls[0]![0]);
    const cohortSummary = normalizedSql(execute.mock.calls[1]![0]);
    const review = normalizedSql(execute.mock.calls[2]![0]);
    const freshness = normalizedSql(execute.mock.calls[3]![0]);

    for (const statement of [page, cohortSummary]) {
      expect(statement).toContain("orders.status = 'paid'");
      expect(statement).toMatch(/orders\.paid_at >= \$\d+/u);
      expect(statement).toMatch(/orders\.paid_at < \$\d+/u);
      expect(statement).toContain('order_items.format');
      expect(statement).toContain('current_financial_projection_heads');
      expect(statement).toContain('current_financial_projection_items');
      expect(statement).toContain('compatible_correction_tip_id');
      expect(statement).toContain('refund_reporting_correction_items');
      expect(statement).toContain('dispute_item_allocations');
      expect(statement).toMatch(
        /dispute_tip\.id = dispute_item_allocations\.gross_allocation_set_id/u
      );
      expect(statement).toMatch(/dispute_tip\.tip_count = 1/u);
      expect(statement).toMatch(/successor\.supersedes_set_id = allocation\.id/u);
      expect(statement).toMatch(/projection\.order_item_id = item\.order_item_id/u);
      expect(statement).not.toMatch(/jsonb_agg\([^)]*balance_transaction_id/iu);
    }
    expect(page).toMatch(/limit \$\d+$/u);
    expect(cohortSummary).not.toMatch(/\blimit\b/iu);
    expect(review).toContain('financial_reconciliation_issues.state');
    expect(review).toContain('financial_projection_versions');
    expect(review).not.toContain('orders.paid_at');
    expect(freshness).toContain('financial_scan_runs');
    expect(freshness).toContain('financial_payout_discovery_state');
  });

  it('requires the current certified payout generation in every shared aggregate query', async () => {
    const { database, execute } = successfulDatabase();
    await listSalesOverview(database, admin, filters, { stripeEnabled: false });
    const aggregate = databaseWith([[completeRow()]]);
    await loadSalesAggregateRows(
      { execute: aggregate.execute } as never,
      filters,
      { applyCursor: false, limit: 10_001 }
    );

    for (const statement of [
      normalizedSql(execute.mock.calls[0]![0]),
      normalizedSql(execute.mock.calls[1]![0]),
      normalizedSql(aggregate.execute.mock.calls[0]![0])
    ]) {
      expect(statement).toContain('published_run_candidates');
      expect(statement).toContain('ranked_certifications');
      expect(statement).toContain('certified_membership');
      expect(statement).toMatch(
        /certification\.certified_generation = payout\.financial_generation/u
      );
    }
  });

  it('fails closed for legacy dispute reinstatement while accepting the tax-split v2 shape', async () => {
    const { database, execute } = successfulDatabase();
    await listSalesOverview(database, admin, filters, { stripeEnabled: false });
    const page = normalizedSql(execute.mock.calls[0]![0]);

    expect(page).toMatch(
      /left join financial_allocation_sets projection_set on projection_set\.id = projection\.base_set_id/u
    );
    expect(page).toMatch(
      /projection\.component = 'dispute_reinstatement' and projection_set\.algorithm_version is distinct from 2/u
    );
    expect(page).toMatch(
      /sum\(projection\.effect_minor\) filter \( where projection\.component in \('dispute_subtotal', 'dispute_reinstatement'\) \)/u
    );
    expect(page).not.toMatch(
      /sum\(projection\.effect_minor\) filter \( where projection\.component in \([^)]*'dispute_tax'/u
    );
  });

  it('counts only exact full refunds and makes over-refunded items unavailable', async () => {
    const { database, execute } = successfulDatabase();
    await listSalesOverview(database, admin, filters, { stripeEnabled: false });
    const page = normalizedSql(execute.mock.calls[0]![0]);

    expect(page).toMatch(
      /count\(\*\) filter \(where item\.refunded_total_minor = item\.total_minor\)::bigint as fully_refunded_copies/u
    );
    expect(page).not.toMatch(/refunded_total_minor >= item\.total_minor/u);
    expect(page).toMatch(
      /bool_and\(item\.settlement_metrics_complete\) and not bool_or\(item\.refunded_total_minor > item\.total_minor\) as settlement_metrics_complete/u
    );
    expect(page).toMatch(
      /sum\(item\.missing_source_count\)::bigint \+ count\(\*\) filter \( where item\.refunded_total_minor > item\.total_minor \)::bigint as missing_source_count/u
    );
    expect(page).toMatch(
      /greatest\(max\(item\.state_rank\), case when bool_or\( item\.refunded_total_minor > item\.total_minor \) then 3 else 0 end\) as state_rank/u
    );
  });

  it('fails closed on any account-scoped Charge head without poisoning account-scoped refunds', async () => {
    const { database, execute } = successfulDatabase();
    await listSalesOverview(database, admin, filters, { stripeEnabled: false });
    const page = normalizedSql(execute.mock.calls[0]![0]);

    expect(page).toMatch(
      /and not \(source\.source_kind = 'payment' and coalesce\(bool_or\(head\.scope = 'account'\), false\)\) then true else false end as is_complete/u
    );
    expect(page).toMatch(
      /case when source\.source_kind = 'payment' and coalesce\(bool_or\(head\.scope = 'account'\), false\) then 1 else 0 end/u
    );
    expect(page).toMatch(
      /or \(source\.source_kind = 'payment' and coalesce\(bool_or\(head\.scope = 'account'\), false\)\)/u
    );
    expect(page).toMatch(
      /where source\.source_kind = 'payment' or \( not source\.is_proven_account_only/u
    );
  });

  it('uses the full filtered cohort summary instead of reducing the current page', async () => {
    const fullSummary = summary({
      titleCount: '51',
      soldCopies: '99',
      fullyRefundedCopies: '7',
      netCopies: '92',
      grossPresentmentMinor: '99000',
      missingSourceCount: '0'
    });
    const { database } = successfulDatabase([completeRow()], [fullSummary]);
    const result = await listSalesOverview(database, admin, filters, { stripeEnabled: false });
    expect(result.rows).toHaveLength(1);
    expect(result.summaries[0]).toMatchObject({
      titleCount: 51,
      soldCopies: 99,
      grossPresentmentMinor: 99000
    });
  });

  it('returns exactly 50 rows and encodes continuation from the last returned equal-gross row', async () => {
    const page = Array.from({ length: 51 }, (_, index) => completeRow(index + 1));
    const { database } = successfulDatabase(page);
    const result = await listSalesOverview(database, admin, filters, { stripeEnabled: false });
    expect(result.rows).toHaveLength(50);
    expect(result.nextCursor).not.toBeNull();
    const cursor = decodeSalesCursor(
      result.nextCursor!,
      fingerprintSalesFilters(filters)
    );
    expect(cursor).toEqual({
      filterFingerprint: fingerprintSalesFilters(filters),
      primary: 2000,
      titleId: titleId(50),
      presentmentCurrency: 'USD',
      settlementCurrency: 'USD'
    });
  });

  it('renders matching keyset directions for gross and title cursors', async () => {
    const grossCursor = {
      filterFingerprint: fingerprintSalesFilters(filters),
      primary: 2000,
      titleId: titleId(20),
      presentmentCurrency: 'USD',
      settlementCurrency: 'USD'
    } as const;
    const grossDb = successfulDatabase([]);
    await listSalesOverview(grossDb.database, admin, { ...filters, cursor: grossCursor }, {
      stripeEnabled: false
    });
    const grossSql = normalizedSql(grossDb.execute.mock.calls[0]![0]);
    expect(grossSql).toMatch(/gross_presentment_minor < \$\d+/u);
    expect(grossSql).toContain('gross_presentment_minor desc');

    const titleFilters = { ...filters, sort: 'title_asc' as const };
    const titleCursor = {
      filterFingerprint: fingerprintSalesFilters(titleFilters),
      primary: 'Pale Orbit',
      titleId: titleId(20),
      presentmentCurrency: 'USD',
      settlementCurrency: 'USD'
    } as const;
    const titleDb = successfulDatabase([]);
    await listSalesOverview(titleDb.database, admin, { ...titleFilters, cursor: titleCursor }, {
      stripeEnabled: false
    });
    const titleSql = normalizedSql(titleDb.execute.mock.calls[0]![0]);
    expect(titleSql).toMatch(/current_title collate C > \$\d+/u);
    expect(titleSql).toContain('current_title collate C asc');
  });

  it('preserves presentment totals while nulling an incomplete row and its whole pair summary', async () => {
    const pair = summary({
      titleCount: '2',
      soldCopies: '4',
      fullyRefundedCopies: '1',
      netCopies: '3',
      grossPresentmentMinor: '4000',
      grossSettlementMinor: null,
      refundImpactMinor: null,
      disputeImpactMinor: null,
      processingFeeImpactMinor: null,
      refundFeeImpactMinor: null,
      disputeFeeImpactMinor: null,
      otherFeeImpactMinor: null,
      estimatedPayoutMinor: null,
      settlementMetricsComplete: false,
      missingSourceCount: '2',
      state: 'pending'
    });
    const { database } = successfulDatabase([incompleteRow()], [pair]);
    const result = await listSalesOverview(database, admin, filters, { stripeEnabled: false });
    expect(result.rows[0]).toMatchObject({
      grossPresentmentMinor: 2000,
      grossSettlementMinor: null,
      settlementMetricsComplete: false,
      missingSourceCount: 2,
      state: 'pending'
    });
    expect(result.summaries[0]).toMatchObject({
      grossPresentmentMinor: 4000,
      grossSettlementMinor: null,
      settlementMetricsComplete: false,
      missingSourceCount: 2
    });
    expect(result.missingSourceCount).toBe(2);
  });

  it('fails closed without a cause or raw value when protected query output is malformed', async () => {
    const malformed = completeRow(1, { customerEmail: 'private@example.test' });
    const { database } = successfulDatabase([malformed]);
    const failure = await listSalesOverview(database, admin, filters, {
      stripeEnabled: false
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: 'SalesOverviewRepositoryError',
      message: 'Sales overview data is temporarily unavailable.'
    });
    expect(failure).not.toHaveProperty('cause');
    expect(JSON.stringify(failure)).not.toContain('private@example.test');
  });

  it('rejects unsafe PostgreSQL aggregate strings instead of rounding them', async () => {
    const { database } = successfulDatabase([
      completeRow(1, { grossPresentmentMinor: '9007199254740992' })
    ]);
    await expect(listSalesOverview(database, admin, filters, { stripeEnabled: false }))
      .rejects.toMatchObject({ name: 'SalesOverviewRepositoryError' });
  });

  it('returns unavailable freshness unless every required local phase completed', async () => {
    const { database } = successfulDatabase(
      [completeRow()],
      [summary()],
      [{ needsReviewCount: '0' }],
      [{
        sourceCompletedAt: '2026-08-21 12:00:00+00',
        payoutCompletedAt: null,
        projectionCompletedAt: '2026-08-21 13:00:00+00'
      }]
    );
    const result = await listSalesOverview(database, admin, filters, { stripeEnabled: false });
    expect(result.dataThroughAt).toBeNull();
  });
});
