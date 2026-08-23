import { readFileSync } from 'node:fs';
import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FinancialIssueDto,
  PayoutDetailDto,
  PayoutSummaryDto,
  SalesCurrencySummaryDto,
  TitleSalesRowDto
} from '$lib/types/financial-reporting';
import type { SalesOverviewDto } from '$lib/server/commerce/reporting/overview';
import type { FinancialIssueListDto } from '$lib/server/commerce/reporting/review';
import type { PayoutListDto } from '$lib/server/commerce/reporting/payouts';

const componentMocks = vi.hoisted(() => ({
  url: 'https://books.example.test/admin/sales'
}));

vi.mock('$app/paths', () => ({
  resolve(path: string, params?: Record<string, string>): string {
    if (params === undefined) return path;
    return Object.entries(params).reduce(
      (resolved, [key, value]) => resolved.replace(`[${key}]`, encodeURIComponent(value)),
      path
    );
  }
}));
vi.mock('$app/stores', () => ({
  page: {
    subscribe(run: (value: { url: URL }) => void) {
      run({ url: new URL(componentMocks.url) });
      return () => undefined;
    }
  }
}));

import FinancialAmount from './FinancialAmount.svelte';
import PayoutTable from './PayoutTable.svelte';
import ReviewQueue from './ReviewQueue.svelte';
import SalesSummaryCards from './SalesSummaryCards.svelte';
import SalesTable from './SalesTable.svelte';
import SalesLayout from '../../../routes/admin/sales/+layout.svelte';
import SalesOverview from '../../../routes/admin/sales/+page.svelte';
import NeedsReview from '../../../routes/admin/sales/review/+page.svelte';
import FinancialIssueDetail from '../../../routes/admin/sales/review/[issueId]/+page.svelte';
import Payouts from '../../../routes/admin/sales/payouts/+page.svelte';
import PayoutDetail from '../../../routes/admin/sales/payouts/[payoutId]/+page.svelte';

const titleId = '00000000-0000-4000-8000-000000000701';

type PayoutSummaryOverrides = {
  [Key in keyof PayoutSummaryDto]?: PayoutSummaryDto[Key];
};
type PayoutDetailOverrides = {
  [Key in keyof PayoutDetailDto]?: PayoutDetailDto[Key];
};

function completeRow(overrides: Partial<TitleSalesRowDto> = {}): TitleSalesRowDto {
  return {
    titleId,
    currentTitle: 'A Very Long Current Title '.repeat(12),
    format: 'comic',
    archived: true,
    soldAsVariants: [
      { title: 'Original Moon', creatorName: 'A. Creator', format: 'comic' },
      { title: 'Original Moon: Revised', creatorName: 'B. Creator', format: 'comic' }
    ],
    presentmentCurrency: 'USD',
    settlementCurrency: 'EUR',
    soldCopies: 3,
    fullyRefundedCopies: 1,
    netCopies: 2,
    grossPresentmentMinor: 2_500,
    finalizedRefundPresentmentMinor: 500,
    disputeWithdrawalPresentmentMinor: 200,
    disputeReinstatementPresentmentMinor: 50,
    grossSettlementMinor: 2_300,
    refundImpactMinor: -460,
    disputeImpactMinor: -138,
    processingFeeImpactMinor: -90,
    refundFeeImpactMinor: 10,
    disputeFeeImpactMinor: -15,
    otherFeeImpactMinor: 3,
    estimatedPayoutMinor: -9_007_199_254_740_991,
    settlementMetricsComplete: true,
    missingSourceCount: 0,
    state: 'fee_reconciled',
    freshnessAt: '2026-08-21T12:00:00.000Z',
    ...overrides
  } as TitleSalesRowDto;
}

function incompleteRow(
  state: 'pending' | 'exception' = 'pending',
  overrides: Partial<TitleSalesRowDto> = {}
): TitleSalesRowDto {
  return {
    ...completeRow(),
    settlementCurrency: null,
    grossSettlementMinor: null,
    refundImpactMinor: null,
    disputeImpactMinor: null,
    processingFeeImpactMinor: null,
    refundFeeImpactMinor: null,
    disputeFeeImpactMinor: null,
    otherFeeImpactMinor: null,
    estimatedPayoutMinor: null,
    settlementMetricsComplete: false,
    missingSourceCount: 2,
    state,
    ...overrides
  } as TitleSalesRowDto;
}

function completeSummary(
  overrides: Partial<SalesCurrencySummaryDto> = {}
): SalesCurrencySummaryDto {
  return {
    presentmentCurrency: 'USD',
    settlementCurrency: 'EUR',
    titleCount: 2,
    soldCopies: 4,
    fullyRefundedCopies: 1,
    netCopies: 3,
    grossPresentmentMinor: 4_000,
    finalizedRefundPresentmentMinor: 500,
    disputeWithdrawalPresentmentMinor: 200,
    disputeReinstatementPresentmentMinor: 50,
    grossSettlementMinor: 3_700,
    refundImpactMinor: -460,
    disputeImpactMinor: -138,
    processingFeeImpactMinor: -120,
    refundFeeImpactMinor: 10,
    disputeFeeImpactMinor: -15,
    otherFeeImpactMinor: 3,
    estimatedPayoutMinor: 2_980,
    settlementMetricsComplete: true,
    missingSourceCount: 0,
    state: 'fee_reconciled',
    ...overrides
  } as SalesCurrencySummaryDto;
}

function incompleteSummary(
  state: 'pending' | 'exception' = 'pending',
  overrides: Partial<SalesCurrencySummaryDto> = {}
): SalesCurrencySummaryDto {
  return {
    ...completeSummary(),
    settlementCurrency: null,
    grossSettlementMinor: null,
    refundImpactMinor: null,
    disputeImpactMinor: null,
    processingFeeImpactMinor: null,
    refundFeeImpactMinor: null,
    disputeFeeImpactMinor: null,
    otherFeeImpactMinor: null,
    estimatedPayoutMinor: null,
    settlementMetricsComplete: false,
    missingSourceCount: 3,
    state,
    ...overrides
  } as SalesCurrencySummaryDto;
}

function overview(overrides: Partial<SalesOverviewDto> = {}): SalesOverviewDto {
  return {
    filters: {
      range: '30',
      from: '2026-07-23T00:00:00.000Z',
      to: '2026-08-22T00:00:00.000Z',
      titleId: null,
      format: null,
      presentmentCurrency: null,
      settlementCurrency: null,
      state: null,
      sort: 'gross_desc'
    },
    rows: [completeRow()],
    summaries: [completeSummary()],
    nextCursor: null,
    dataThroughAt: '2026-08-21T11:00:00.000Z',
    stripeEnabled: true,
    missingSourceCount: 0,
    needsReviewCount: 0,
    ...overrides
  };
}

function decodedHref(body: string, label: string): string {
  const link = new RegExp(`<a[^>]*href="([^"]+)"[^>]*>${label}<\\/a>`, 'u').exec(body);
  if (!link) throw new Error(`Missing link: ${label}`);
  return link[1]!.replaceAll('&amp;', '&');
}

function financialIssue(overrides: Partial<FinancialIssueDto> = {}): FinancialIssueDto {
  return {
    issueId: '22222222-2222-4222-8222-222222222222',
    resourceType: 'refund',
    resourceId: '33333333-3333-4333-8333-333333333333',
    safeCode: 'allocation_incomplete',
    state: 'open',
    impact: 'pending',
    actionability: 'refund_allocation_review',
    operationallyCurrent: true,
    safeReason: 'A refund allocation needs review.',
    firstObservedAt: '2026-08-01T10:00:00.000Z',
    lastObservedAt: '2026-08-02T11:00:00.000Z',
    occurrenceCount: 2,
    refundId: '33333333-3333-4333-8333-333333333333',
    ...overrides
  };
}

function payoutSummary(overrides: PayoutSummaryOverrides = {}): PayoutSummaryDto {
  return {
    payoutId: '88888888-8888-4888-8888-888888888888',
    automatic: true,
    method: 'standard',
    status: 'paid',
    reconciliationStatus: 'completed',
    settlementCurrency: 'USD',
    amountMinor: 930,
    createdAt: '2026-08-01T10:00:00.123Z',
    arrivalAt: '2026-08-03T10:00:00.000Z',
    associatedTransactionCount: 3,
    bookstoreLinkedTransactionCount: 2,
    membershipComplete: true,
    bookstoreLinkedSubtotalMinor: 1_000,
    accountLevelAdjustmentCount: 1,
    accountLevelAdjustmentMinor: -20,
    safeFailureCode: null,
    financialGeneration: 2,
    membershipGeneration: 2,
    historicalMembershipRetained: false,
    reversalState: 'none',
    openIssueCount: 0,
    freshnessAt: '2026-08-03T12:00:00.000Z',
    ...overrides
  } as PayoutSummaryDto;
}

function unavailablePayout(overrides: PayoutSummaryOverrides = {}): PayoutSummaryDto {
  return payoutSummary({
    automatic: false,
    reconciliationStatus: 'not_applicable',
    associatedTransactionCount: null,
    bookstoreLinkedTransactionCount: null,
    membershipComplete: false,
    bookstoreLinkedSubtotalMinor: null,
    accountLevelAdjustmentCount: null,
    accountLevelAdjustmentMinor: null,
    membershipGeneration: null,
    historicalMembershipRetained: false,
    ...overrides
  });
}

function payoutDetail(overrides: PayoutDetailOverrides = {}): PayoutDetailDto {
  return {
    ...payoutSummary(),
    bookstoreLinkedFeeImpactMinor: -50,
    bookstoreLinkedNetMinor: 950,
    reversalAmountMinor: null,
    ...overrides
  } as PayoutDetailDto;
}

describe('FinancialAmount', () => {
  it('renders explicit signed ISO values for zero-, two-, and three-decimal currencies', () => {
    const jpy = render(FinancialAmount, {
      props: { amountMinor: 1_234, currency: 'JPY' }
    }).body;
    const usd = render(FinancialAmount, {
      props: { amountMinor: -12_345, currency: 'USD' }
    }).body;
    const zero = render(FinancialAmount, {
      props: { amountMinor: 0, currency: 'USD' }
    }).body;
    const bhd = render(FinancialAmount, {
      props: { amountMinor: 1_234, currency: 'BHD' }
    }).body;

    expect(jpy).toContain('+JPY\u00a01,234');
    expect(usd).toContain('-USD\u00a0123.45');
    expect(zero).toContain('USD\u00a00.00');
    expect(bhd).toContain('+BHD\u00a01.234');
  });

  it('renders an explicit unavailable label without fabricating a currency', () => {
    const withCurrency = render(FinancialAmount, {
      props: {
        amountMinor: null,
        currency: 'EUR',
        unavailableLabel: 'Settlement estimate unavailable'
      }
    }).body;
    const pendingCurrency = render(FinancialAmount, {
      props: {
        amountMinor: null,
        currency: null,
        unavailableLabel: 'Settlement estimate unavailable'
      }
    }).body;

    expect(withCurrency).toContain('Settlement estimate unavailable');
    expect(withCurrency).toContain('EUR');
    expect(pendingCurrency).toContain('Settlement estimate unavailable');
    expect(pendingCurrency).toContain('Settlement currency pending');
    expect(pendingCurrency).not.toContain('USD');
  });
});

describe('Sales local layout', () => {
  beforeEach(() => {
    componentMocks.url = 'https://books.example.test/admin/sales';
  });

  it.each([
    { path: '/admin/sales', current: 'Overview' },
    { path: '/admin/sales/review/issue-id', current: 'Needs Review' },
    { path: '/admin/sales/payouts/payout-id', current: 'Payouts' }
  ])('provides semantic local navigation at $path', ({ path, current }) => {
    componentMocks.url = `https://books.example.test${path}`;
    const children = createRawSnippet(() => ({ render: () => '<p>Sales child</p>' }));
    const { body } = render(SalesLayout, { props: { children } });

    expect(body).toMatch(/<nav[^>]*aria-label="Sales sections"/u);
    expect(body).toMatch(/href="\/admin\/sales"[^>]*>Overview<\/a>/u);
    expect(body).toMatch(/href="\/admin\/sales\/review"[^>]*>Needs Review<\/a>/u);
    expect(body).toMatch(/href="\/admin\/sales\/payouts"[^>]*>Payouts<\/a>/u);
    expect(body).toMatch(
      new RegExp(`aria-current="page"[^>]*>${current.replace(' ', '(?: |&nbsp;)')}<\\/a>`, 'u')
    );
  });
});

describe('Sales summary and table', () => {
  it('keeps summaries separated by currency pair and suppresses incomplete settlement totals', () => {
    const complete = render(SalesSummaryCards, {
      props: {
        summaries: [
          completeSummary(),
          completeSummary({ presentmentCurrency: 'CAD', settlementCurrency: 'USD' })
        ]
      }
    }).body;
    const incomplete = render(SalesSummaryCards, {
      props: { summaries: [incompleteSummary()] }
    }).body;

    expect(complete).toContain('USD → EUR');
    expect(complete).toContain('CAD → USD');
    expect(complete).not.toMatch(/grand total|mixed total/iu);
    expect(complete).toContain('Estimated payout');
    expect(complete).toContain('Fee reconciled');

    expect(incomplete).toContain('USD → Settlement pending');
    expect(incomplete).toContain('Settlement estimate unavailable');
    expect(incomplete).toContain('3 missing sources');
    expect(incomplete).not.toContain('Gross settlement');
    expect(incomplete).not.toContain('Estimated payout');
  });

  it('renders a captioned, scoped, focusable table with every approved metric', () => {
    const { body } = render(SalesTable, {
      props: {
        rows: [
          completeRow(),
          completeRow({
            titleId: '00000000-0000-4000-8000-000000000702',
            state: 'payout_reconciled',
            estimatedPayoutMinor: 2_000
          }),
          incompleteRow('exception', {
            titleId: '00000000-0000-4000-8000-000000000703'
          })
        ]
      }
    });

    expect(body).toMatch(
      /role="region"[^>]*aria-label="Sales results by title"[^>]*tabindex="0"/u
    );
    expect(body).toMatch(/<caption>Sales by title and currency pair<\/caption>/u);
    expect(body.match(/scope="col"/gu)?.length).toBeGreaterThanOrEqual(5);
    expect(body).toContain('scope="row"');
    for (const copy of [
      'A. Creator',
      'B. Creator',
      'Comic',
      'Archived',
      'Sold copies',
      'Fully refunded copies',
      'Net copies',
      'Gross presentment',
      'Finalized refunds',
      'Dispute withdrawals',
      'Dispute reinstatements',
      'Gross settlement',
      'Refund impact',
      'Dispute impact',
      'Processing fee impact',
      'Refund fee impact',
      'Dispute fee impact',
      'Other fee impact',
      'Estimated payout',
      'Fee reconciled',
      'Payout reconciled',
      'Settlement estimate unavailable',
      'Exception',
      'Needs review',
      '2 missing sources',
      'Financial row through',
      'USD',
      'EUR'
    ]) {
      expect(body).toContain(copy);
    }
    expect(body).toContain('-EUR\u00a090,071,992,547,409.91');
  });

  it('uses visible text rather than color alone for every public state', () => {
    const { body } = render(SalesTable, {
      props: {
        rows: [
          incompleteRow('pending'),
          incompleteRow('exception', { titleId: '00000000-0000-4000-8000-000000000704' }),
          completeRow({ titleId: '00000000-0000-4000-8000-000000000705' }),
          completeRow({
            titleId: '00000000-0000-4000-8000-000000000706',
            state: 'payout_reconciled'
          })
        ]
      }
    });

    expect(body).toContain('Pending');
    expect(body).toContain('Exception');
    expect(body).toContain('Fee reconciled');
    expect(body).toContain('Payout reconciled');
  });
});

describe('Sales Overview page', () => {
  beforeEach(() => {
    componentMocks.url = 'https://books.example.test/admin/sales';
  });

  it('renders one page heading, native labeled filters, and a live result count', () => {
    const { body } = render(SalesOverview, { props: { data: overview() as never } });

    expect(body.match(/<h1(?:\s|>)/gu)).toHaveLength(1);
    expect(body).toMatch(/<form[^>]*method="GET"[^>]*action="\/admin\/sales"/u);
    for (const control of [
      'Range',
      'From date',
      'To date',
      'Title ID',
      'Format',
      'Presentment currency',
      'Settlement currency',
      'Financial state',
      'Sort'
    ]) {
      expect(body).toMatch(new RegExp(`<label[^>]*>[\\s\\S]*?${control}`, 'u'));
    }
    expect(body).toMatch(/role="status"[^>]*aria-live="polite"/u);
    expect(body).toContain('1 matching sales row');
    expect(body).toContain('Financial data through');
    expect(body).toContain('datetime="2026-08-21T11:00:00.000Z"');
    expect(body).toContain('Aug 21, 2026, 11:00 AM UTC');
    expect(body).toContain('pattern="[A-Z]{3}"');
    expect(body).not.toContain('autofocus');
  });

  it('omits empty optional GET entries without disabling controls reused after navigation', () => {
    const source = readFileSync(new URL('./SalesFilters.svelte', import.meta.url), 'utf8');

    expect(source).toMatch(/onformdata=\{omitEmptyOptionalFields\}/u);
    expect(source).toMatch(/event\.formData\.delete\(element\.name\)/u);
    expect(source).not.toMatch(/(?:\.disabled\s*=|setAttribute\(\s*['"]disabled)/u);
  });

  it('shows a canonical cursor-free export link only when canExport is true', () => {
    componentMocks.url =
      'https://books.example.test/admin/sales?private=ignored&cursor=page_cursor';
    const filters = {
      range: 'custom' as const,
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-11T00:00:00.000Z',
      titleId,
      format: 'comic' as const,
      presentmentCurrency: 'USD',
      settlementCurrency: 'EUR',
      state: 'fee_reconciled' as const,
      sort: 'title_asc' as const
    };
    const visible = render(SalesOverview, {
      props: { data: { ...overview({ filters }), canExport: true } as never }
    }).body;
    const hidden = render(SalesOverview, {
      props: { data: { ...overview({ filters }), canExport: false } as never }
    }).body;
    const href = decodedHref(visible, 'Export filtered CSV');

    expect(visible).toMatch(/<a[^>]*data-sveltekit-reload[^>]*>Export filtered CSV<\/a>/u);
    expect(href).toBe(
      `/admin/sales/export.csv?range=custom&from=2026-08-01&to=2026-08-10&titleId=${titleId}&format=comic&presentmentCurrency=USD&settlementCurrency=EUR&state=fee_reconciled&sort=title_asc`
    );
    const exported = new URL(href, 'https://books.example.test');
    expect(exported.searchParams.has('cursor')).toBe(false);
    expect(exported.searchParams.has('private')).toBe(false);
    for (const key of exported.searchParams.keys()) {
      expect(exported.searchParams.getAll(key)).toHaveLength(1);
    }
    expect(hidden).not.toContain('Export filtered CSV');
  });

  it('renders explicit disabled, freshness, pending-only, and review notices', () => {
    const data = overview({
      rows: [incompleteRow()],
      summaries: [incompleteSummary()],
      dataThroughAt: null,
      stripeEnabled: false,
      missingSourceCount: 3,
      needsReviewCount: 4
    });
    const { body } = render(SalesOverview, { props: { data: data as never } });

    expect(body.match(/role="alert"/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(body).toContain('Stripe is disabled');
    expect(body).toContain('Financial freshness unavailable');
    expect(body).toContain('All matching sales are settlement pending');
    expect(body).toMatch(/<strong>4<\/strong>\s*<span>items need review<\/span>/u);
    expect(body).toMatch(/href="\/admin\/sales\/review"[^>]*>Needs review<\/a>/u);
  });

  it('distinguishes the initial empty state from filtered no results', () => {
    const empty = render(SalesOverview, {
      props: { data: overview({ rows: [], summaries: [] }) as never }
    }).body;
    const filtered = render(SalesOverview, {
      props: {
        data: overview({
          filters: { ...overview().filters, format: 'comic' },
          rows: [],
          summaries: []
        }) as never
      }
    }).body;

    expect(empty).toContain('No sales data yet');
    expect(filtered).toContain('No sales match these filters');
  });

  it('builds stable canonical next and first-page URLs without duplicate parameters', () => {
    componentMocks.url =
      'https://books.example.test/admin/sales?range=custom&from=2026-08-01&to=2026-08-10&format=comic&presentmentCurrency=USD&settlementCurrency=EUR&state=fee_reconciled&sort=title_asc&cursor=current_cursor';
    const data = overview({
      filters: {
        range: 'custom',
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-11T00:00:00.000Z',
        titleId: null,
        format: 'comic',
        presentmentCurrency: 'USD',
        settlementCurrency: 'EUR',
        state: 'fee_reconciled',
        sort: 'title_asc'
      },
      nextCursor: 'next_cursor'
    });
    const { body } = render(SalesOverview, { props: { data: data as never } });
    const nextHref = decodedHref(body, 'Next page →');
    const firstHref = decodedHref(body, 'First page');

    expect(nextHref).toBe(
      '/admin/sales?range=custom&from=2026-08-01&to=2026-08-10&format=comic&presentmentCurrency=USD&settlementCurrency=EUR&state=fee_reconciled&sort=title_asc&cursor=next_cursor'
    );
    expect(firstHref).toBe(
      '/admin/sales?range=custom&from=2026-08-01&to=2026-08-10&format=comic&presentmentCurrency=USD&settlementCurrency=EUR&state=fee_reconciled&sort=title_asc'
    );
    const next = new URL(nextHref, 'https://books.example.test');
    for (const key of next.searchParams.keys()) {
      expect(next.searchParams.getAll(key)).toHaveLength(1);
    }
    expect(body).toMatch(/name="to"[^>]*value="2026-08-10"/u);
  });

  it('ships focus, reduced-motion, overflow, and semantic narrow-screen rules', () => {
    const appCss = readFileSync(new URL('../../../app.css', import.meta.url), 'utf8');
    const salesCss = readFileSync(
      new URL('../../../routes/admin/sales/sales.css', import.meta.url),
      'utf8'
    );

    expect(appCss).toContain(':focus-visible');
    expect(appCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(salesCss).toMatch(/\.sales-table-region\s*\{[^}]*overflow-x:\s*auto/isu);
    expect(salesCss).toMatch(/@media\s*\(max-width:\s*700px\)/u);
    expect(salesCss).toContain('.mobile-cell-label');
    expect(salesCss).toContain('overflow-wrap: anywhere');
  });
});

describe('Needs Review queue and safe issue detail', () => {
  const currentCursor = 'bounded_current_cursor';

  beforeEach(() => {
    componentMocks.url = `https://books.example.test/admin/sales/review?cursor=${currentCursor}`;
  });

  it('renders a captioned, scoped, focusable queue with semantic non-color labels', () => {
    const issues = [
      financialIssue(),
      financialIssue({
        issueId: '44444444-4444-4444-8444-444444444444',
        resourceType: 'payment',
        resourceId: '55555555-5555-4555-8555-555555555555',
        safeCode: 'missing_source',
        actionability: 'wait_for_recovery',
        safeReason: 'Required financial evidence is not available yet.',
        refundId: null
      }),
      financialIssue({
        issueId: '66666666-6666-4666-8666-666666666666',
        resourceType: 'balance_transaction',
        resourceId: '77777777-7777-4777-8777-777777777777',
        safeCode: 'immutable_mismatch',
        impact: 'exception',
        actionability: 'read_only',
        safeReason: 'Stored financial evidence conflicts with its immutable record.',
        refundId: null
      })
    ];

    const { body } = render(ReviewQueue, { props: { issues, currentCursor } });

    expect(body).toMatch(
      /role="region"[^>]*aria-label="Financial issues needing review"[^>]*tabindex="0"/u
    );
    expect(body).toContain('<caption>Current operational financial issues</caption>');
    expect(body.match(/scope="col"/gu)?.length).toBeGreaterThanOrEqual(5);
    expect(body).toContain('scope="row"');
    for (const copy of [
      'A refund allocation needs review.',
      'Required financial evidence is not available yet.',
      'Stored financial evidence conflicts with its immutable record.',
      'Refund allocation review',
      'Wait for recovery',
      'Read-only',
      'Pending',
      'Exception',
      'First observed',
      'Last observed',
      '2 occurrences',
      'View issue'
    ]) {
      expect(body).toContain(copy);
    }
    expect(decodedHref(body, 'View issue')).toBe(
      `/admin/sales/review/${issues[0]!.issueId}?cursor=${currentCursor}`
    );
    expect(body).not.toMatch(/>\s*(?:Resolve|Retry|Sync)\s*</iu);
    expect(body).not.toContain('provider_private_canary');
  });

  it('renders one queue heading, a live count, stable paging, and an explicit empty state', () => {
    const data: FinancialIssueListDto = {
      issues: [financialIssue()],
      currentCursor,
      nextCursor: 'bounded_next_cursor'
    };
    const populated = render(NeedsReview, { props: { data: data as never } }).body;
    const empty = render(NeedsReview, {
      props: {
        data: { issues: [], currentCursor: null, nextCursor: null } as never
      }
    }).body;

    expect(populated.match(/<h1(?:\s|>)/gu)).toHaveLength(1);
    expect(populated).toContain('Needs review');
    expect(populated).toMatch(/role="status"[^>]*aria-live="polite"/u);
    expect(populated).toContain('1 current issue');
    expect(decodedHref(populated, 'First page')).toBe('/admin/sales/review');
    expect(decodedHref(populated, 'Next page →')).toBe(
      '/admin/sales/review?cursor=bounded_next_cursor'
    );
    expect(empty).toContain('No current financial issues');
    expect(empty).toContain('No operational financial issue needs attention right now.');
  });

  it('renders audited safe detail and only the named ambiguous-refund workflow', () => {
    const actionable = render(FinancialIssueDetail, {
      props: {
        data: { issue: financialIssue(), currentCursor } as never
      }
    }).body;
    const generic = render(FinancialIssueDetail, {
      props: {
        data: {
          issue: financialIssue({
            resourceType: 'balance_transaction',
            resourceId: '77777777-7777-4777-8777-777777777777',
            safeCode: 'immutable_mismatch',
            impact: 'exception',
            actionability: 'read_only',
            safeReason: 'Stored financial evidence conflicts with its immutable record.',
            refundId: null
          }),
          currentCursor: null
        } as never
      }
    }).body;

    expect(actionable.match(/<h1(?:\s|>)/gu)).toHaveLength(1);
    expect(actionable).toContain('Financial issue');
    expect(actionable).toMatch(/<dl[^>]*>[\s\S]*Issue ID[\s\S]*Resource ID[\s\S]*Safe code/u);
    expect(actionable).toContain('datetime="2026-08-01T10:00:00.000Z"');
    expect(actionable).toContain('datetime="2026-08-02T11:00:00.000Z"');
    expect(decodedHref(actionable, 'Back to Needs review')).toBe(
      `/admin/sales/review?cursor=${currentCursor}`
    );
    expect(decodedHref(actionable, 'Review refund allocation')).toBe(
      `/admin/sales/refunds/${financialIssue().refundId}?reviewCursor=${currentCursor}`
    );
    expect(actionable).not.toMatch(/>\s*(?:Resolve|Retry|Sync)\s*</iu);

    expect(generic).toContain('No administrator action is available for this issue.');
    expect(generic).not.toContain('Review refund allocation');
    expect(generic).not.toMatch(/href="[^"]*refunds/u);
    expect(generic).not.toMatch(/correlation|provider_private_canary|customer@example/iu);
  });

  it('extends the existing responsive Sales styles for queue and detail resilience', () => {
    const salesCss = readFileSync(
      new URL('../../../routes/admin/sales/sales.css', import.meta.url),
      'utf8'
    );

    expect(salesCss).toMatch(/\.review-detail-grid\s*\{[^}]*display:\s*grid/isu);
    expect(salesCss).toMatch(/\.review-identifier\s*\{[^}]*overflow-wrap:\s*anywhere/isu);
    expect(salesCss).toMatch(/@media\s*\(max-width:\s*700px\)[\s\S]*\.review-detail-grid/iu);
  });
});

describe('Local payout list and audited detail', () => {
  const currentCursor = 'bounded_payout_cursor';

  beforeEach(() => {
    componentMocks.url = `https://books.example.test/admin/sales/payouts?cursor=${currentCursor}`;
  });

  it('renders a captioned, scoped, focusable payout table with signed currency and text states', () => {
    const payouts = [
      payoutSummary(),
      payoutSummary({
        payoutId: '99999999-9999-4999-8999-999999999999',
        status: 'pending',
        reconciliationStatus: 'in_progress',
        associatedTransactionCount: null,
        bookstoreLinkedTransactionCount: null,
        membershipComplete: false,
        bookstoreLinkedSubtotalMinor: null,
        accountLevelAdjustmentCount: null,
        accountLevelAdjustmentMinor: null,
        membershipGeneration: null,
        historicalMembershipRetained: false
      } as never),
      payoutSummary({
        payoutId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        status: 'failed',
        membershipComplete: false,
        historicalMembershipRetained: true,
        financialGeneration: 3,
        membershipGeneration: 2,
        reversalState: 'reversed',
        safeFailureCode: 'provider_failed'
      }),
      unavailablePayout({
        payoutId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      }),
      unavailablePayout({
        payoutId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        automatic: true,
        method: 'instant'
      }),
      unavailablePayout({
        payoutId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        automatic: true,
        method: 'unknown'
      })
    ];

    const { body } = render(PayoutTable, { props: { payouts, currentCursor } });

    expect(body).toMatch(
      /role="region"[^>]*aria-label="Local payout reporting"[^>]*tabindex="0"/u
    );
    expect(body).toContain('<caption>Local payout history</caption>');
    expect(body.match(/scope="col"/gu)?.length).toBeGreaterThanOrEqual(5);
    expect(body).toContain('scope="row"');
    for (const copy of [
      'Automatic',
      'Manual',
      'Standard',
      'Instant',
      'Unknown method',
      'Paid',
      'Pending',
      'Failed',
      'Completed',
      'In progress',
      'Bookstore-linked subtotal',
      'Account-level adjustments',
      'Historical payout membership retained',
      'Fee reconciled — exact payout membership unavailable',
      'provider_failed',
      'Financial generation 3',
      'Membership generation 2',
      'View payout'
    ]) {
      expect(body).toContain(copy);
    }
    expect(body).toContain('+USD 9.30');
    expect(body).toContain('-USD 0.20');
    expect(decodedHref(body, 'View payout')).toBe(
      `/admin/sales/payouts/${payouts[0]!.payoutId}?cursor=${currentCursor}`
    );
    expect(body).not.toMatch(/>\s*(?:Retry|Sync)\s*</iu);
    expect(body).not.toMatch(/providerId|stripeId|balanceTransactionId|provider_private_canary/iu);
  });

  it('renders one payout heading, live count, stable paging, and an explicit empty state', () => {
    const data: PayoutListDto = {
      payouts: [payoutSummary()],
      currentCursor,
      nextCursor: 'bounded_next_payout_cursor'
    };
    const populated = render(Payouts, { props: { data: data as never } }).body;
    const empty = render(Payouts, {
      props: {
        data: { payouts: [], currentCursor: null, nextCursor: null } as never
      }
    }).body;

    expect(populated.match(/<h1(?:\s|>)/gu)).toHaveLength(1);
    expect(populated).toContain('Payouts');
    expect(populated).toMatch(/role="status"[^>]*aria-live="polite"/u);
    expect(populated).toContain('1 payout on this page');
    expect(decodedHref(populated, 'First page')).toBe('/admin/sales/payouts');
    expect(decodedHref(populated, 'Next page →')).toBe(
      '/admin/sales/payouts?cursor=bounded_next_payout_cursor'
    );
    expect(empty).toContain('No payouts yet');
    expect(empty).toContain('No local payout record is available.');
  });

  it('renders audited detail with bookstore-linked caveats and only a validated cursor back link', () => {
    const detail = payoutDetail();
    const { body } = render(PayoutDetail, {
      props: { data: { payout: detail, currentCursor } as never }
    });

    expect(body.match(/<h1(?:\s|>)/gu)).toHaveLength(1);
    expect(body).toContain('Payout detail');
    expect(body).toMatch(
      /<dl[^>]*>[\s\S]*Payout ID[\s\S]*Status[\s\S]*Settlement currency[\s\S]*Financial generation/u
    );
    for (const copy of [
      'Payout amount',
      'Bookstore-linked subtotal',
      'Bookstore-linked fee impact',
      'Bookstore-linked net',
      'Account-level adjustments',
      'Associated transactions',
      'Bookstore-linked transactions',
      'Created',
      'Expected arrival',
      'Local data through',
      'Bookstore-linked amounts are not the full payout total.'
    ]) {
      expect(body).toContain(copy);
    }
    expect(body).toContain('+USD 10.00');
    expect(body).toContain('-USD 0.50');
    expect(body).toContain('+USD 9.50');
    expect(body).toContain('datetime="2026-08-01T10:00:00.123Z"');
    expect(body).toContain('datetime="2026-08-03T12:00:00.000Z"');
    expect(decodedHref(body, 'Back to Payouts')).toBe(
      `/admin/sales/payouts?cursor=${currentCursor}`
    );
    expect(body).not.toMatch(/>\s*(?:Retry|Sync)\s*</iu);
    expect(body).not.toMatch(/correlation|provider_private_canary|customer@example/iu);
  });

  it('uses exact limitation copy for manual, instant, and unknown methods without invented membership', () => {
    for (const payout of [
      unavailablePayout(),
      unavailablePayout({ automatic: true, method: 'instant' }),
      unavailablePayout({ automatic: true, method: 'unknown' })
    ]) {
      const detail = payoutDetail({
        ...payout,
        bookstoreLinkedFeeImpactMinor: null,
        bookstoreLinkedNetMinor: null
      } as never);
      const body = render(PayoutDetail, {
        props: { data: { payout: detail, currentCursor: null } as never }
      }).body;

      expect(body).toContain('Fee reconciled — exact payout membership unavailable');
      expect(body).toContain('Membership unavailable');
      expect(body).not.toContain('Associated transactions</dt><dd>0');
      expect(decodedHref(body, 'Back to Payouts')).toBe('/admin/sales/payouts');
    }
  });

  it('retains historical membership and renders reversal/failure evidence as text', () => {
    const detail = payoutDetail({
      status: 'canceled',
      membershipComplete: false,
      historicalMembershipRetained: true,
      financialGeneration: 3,
      membershipGeneration: 2,
      reversalState: 'reversed',
      reversalAmountMinor: -930,
      safeFailureCode: 'provider_canceled'
    });
    const body = render(PayoutDetail, {
      props: { data: { payout: detail, currentCursor: null } as never }
    }).body;

    expect(body).toContain('Historical payout membership retained');
    expect(body).toContain('Reversed');
    expect(body).toContain('Reversal amount');
    expect(body).toContain('-USD 9.30');
    expect(body).toContain('provider_canceled');
  });

  it('extends responsive Sales styles for payout table and detail resilience', () => {
    const salesCss = readFileSync(
      new URL('../../../routes/admin/sales/sales.css', import.meta.url),
      'utf8'
    );

    expect(salesCss).toMatch(/\.payout-table\s*\{[^}]*min-width:/isu);
    expect(salesCss).toMatch(/\.payout-detail-grid\s*\{[^}]*display:\s*grid/isu);
    expect(salesCss).toMatch(/@media\s*\(max-width:\s*700px\)[\s\S]*\.payout-detail-grid/iu);
  });
});

describe('Sales presentation privacy allowlists', () => {
  it('renders approved DTO fields while ignoring nested operational and identity canaries', () => {
    const privateFields = {
      privateCommandJson: 'private_command_json_canary_15a',
      idempotencyKey: 'private_idempotency_canary_15a',
      jobId: 'private_job_id_canary_15a',
      attempts: 'private_attempt_count_canary_15a',
      leaseCapability: 'private_lease_capability_canary_15a',
      capabilityDigest: 'private_capability_digest_canary_15a',
      claimGeneration: 'private_claim_generation_canary_15a',
      claimExpiresAt: 'private_claim_expiry_canary_15a',
      lastError: 'private_last_error_canary_15a',
      stripeSecret: 'sk_live_private_canary_15a',
      chargeProviderId: 'ch_private_canary_15a',
      refundProviderId: 're_private_canary_15a',
      disputeProviderId: 'dp_private_canary_15a',
      payoutProviderId: 'po_private_canary_15a',
      providerBody: 'private_provider_body_canary_15a',
      claimProof: 'private_claim_proof_canary_15a',
      authToken: 'private_auth_token_canary_15a',
      password: 'private_password_canary_15a',
      resetToken: 'private_reset_token_canary_15a',
      magicLinkToken: 'private_magic_token_canary_15a',
      email: 'private-sales-15a@example.test',
      ipAddress: '198.51.100.115',
      userAgent: 'private_user_agent_canary_15a',
      sqlError: 'private_sql_error_canary_15a',
      stackTrace: 'private_stack_trace_canary_15a',
      databaseRole: 'private_database_role_canary_15a',
      filesystemPath: 'C:/private/financial-canary-15a.json'
    } as const;
    const taintedIssue = {
      ...financialIssue({ safeReason: 'Approved issue reason.' }),
      ...privateFields
    };
    const taintedPayout = { ...payoutDetail(), ...privateFields };
    const artifacts = [
      render(SalesOverview, {
        props: {
          data: {
            ...overview({
              rows: [{
                ...completeRow({ currentTitle: 'Approved sales title' }),
                ...privateFields
              }],
              summaries: [{ ...completeSummary(), ...privateFields }]
            }),
            ...privateFields,
            canExport: false
          } as never
        }
      }).body,
      render(NeedsReview, {
        props: {
          data: {
            issues: [taintedIssue],
            currentCursor: null,
            nextCursor: null,
            ...privateFields
          } as never
        }
      }).body,
      render(FinancialIssueDetail, {
        props: {
          data: { issue: taintedIssue, currentCursor: null, ...privateFields } as never
        }
      }).body,
      render(Payouts, {
        props: {
          data: {
            payouts: [taintedPayout],
            currentCursor: null,
            nextCursor: null,
            ...privateFields
          } as never
        }
      }).body,
      render(PayoutDetail, {
        props: {
          data: { payout: taintedPayout, currentCursor: null, ...privateFields } as never
        }
      }).body
    ];

    expect(artifacts[0]).toContain('Approved sales title');
    expect(artifacts[1]).toContain('Approved issue reason.');
    expect(artifacts[4]).toContain(taintedPayout.payoutId);
    for (const artifact of artifacts) {
      for (const privateValue of Object.values(privateFields)) {
        expect(artifact).not.toContain(privateValue);
      }
    }
  });
});
