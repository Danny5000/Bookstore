import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Actor,
  AdminCapability,
  AdministratorActor,
  CapabilityResolver
} from '$lib/server/auth/admin-policy';
import type { SalesOverviewDto } from '$lib/server/commerce/reporting/overview';
import type {
  FinancialIssueDetailDto,
  FinancialIssueListDto
} from '$lib/server/commerce/reporting/review';
import type {
  PayoutDetailDto,
  PayoutListDto
} from '$lib/server/commerce/reporting/payouts';
import { SalesReportingInputError } from '$lib/server/commerce/reporting/filters';

const routeMocks = vi.hoisted(() => ({
  database: {},
  denySalesReadForAdmin: false,
  denySalesExportForAdmin: false,
  listSalesOverview: vi.fn(),
  canExportSalesOverview: vi.fn(),
  exportSalesCsv: vi.fn(),
  listFinancialIssues: vi.fn(),
  getFinancialIssueDetail: vi.fn(),
  listPayouts: vi.fn(),
  getPayoutDetail: vi.fn(),
  getFinancialAdminCommandStatus: vi.fn()
}));

describe('Sales candidate navigation boundary', () => {
  it('keeps the global Sales — Upcoming item disabled while direct candidate routes remain review-only', () => {
    const adminLayout = readFileSync(new URL('../+layout.svelte', import.meta.url), 'utf8');
    const adminLinks = adminLayout.match(/<a\b[\s\S]*?<\/a>/giu) ?? [];

    expect(adminLayout).toContain('<span>Sales <small>Upcoming</small></span>');
    expect(adminLinks.some((link) => /\bSales\b/u.test(link))).toBe(false);
    expect(adminLayout).not.toMatch(/<a\b[^>]*\/admin\/sales/iu);
  });
});

vi.mock('$lib/server/db/runtime', () => ({
  getDatabaseClient: () => ({ db: routeMocks.database })
}));

vi.mock('$lib/server/config', () => ({
  getApplicationConfig: () => ({ origin: 'https://books.example.test' })
}));

vi.mock('$lib/server/auth/admin-policy', async (importOriginal) => {
  const actual: typeof import('$lib/server/auth/admin-policy') = await importOriginal();
  const requireActualCapability: (
    actor: Actor,
    capability: AdminCapability,
    capabilityResolver?: CapabilityResolver
  ) => void = actual.requireCapability;
  return {
    ...actual,
    requireCapability(
      actor: Actor,
      capability: AdminCapability,
      capabilityResolver?: CapabilityResolver
    ): asserts actor is AdministratorActor {
      const baseResolver = capabilityResolver ?? actual.capabilitiesForRoles;
      const resolver: CapabilityResolver = (roles) => {
        const capabilities = new Set(baseResolver(roles));
        if (routeMocks.denySalesReadForAdmin) capabilities.delete('sales.read');
        if (routeMocks.denySalesExportForAdmin) capabilities.delete('sales.export');
        return capabilities;
      };
      requireActualCapability(actor, capability, resolver);
    }
  };
});

vi.mock('$lib/server/commerce/reporting/overview', () => ({
  listSalesOverview: routeMocks.listSalesOverview,
  canExportSalesOverview: routeMocks.canExportSalesOverview
}));

vi.mock('$lib/server/commerce/reporting/csv', () => ({
  exportSalesCsv: routeMocks.exportSalesCsv
}));

vi.mock('$lib/server/commerce/reporting/review', async (importOriginal) => {
  const actual: typeof import('$lib/server/commerce/reporting/review') = await importOriginal();
  return {
    ...actual,
    listFinancialIssues: routeMocks.listFinancialIssues,
    getFinancialIssueDetail: routeMocks.getFinancialIssueDetail
  };
});

vi.mock('$lib/server/commerce/reporting/payouts', async (importOriginal) => {
  const actual: typeof import('$lib/server/commerce/reporting/payouts') = await importOriginal();
  return {
    ...actual,
    listPayouts: routeMocks.listPayouts,
    getPayoutDetail: routeMocks.getPayoutDetail
  };
});

vi.mock('$lib/server/commerce/financial/admin-commands/repository', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('$lib/server/commerce/financial/admin-commands/repository')
  >()),
  getFinancialAdminCommandStatus: routeMocks.getFinancialAdminCommandStatus
}));

import { load as loadSalesLayout } from './+layout.server';
import * as overviewRoute from './+page.server';
import * as exportRoute from './export.csv/+server';
import * as reviewRoute from './review/+page.server';
import * as reviewDetailRoute from './review/[issueId]/+page.server';
import * as payoutsRoute from './payouts/+page.server';
import * as payoutDetailRoute from './payouts/[payoutId]/+page.server';
import * as commandStatusRoute from './commands/[commandId]/+server';

const admin: Actor = { type: 'user', id: randomUUID(), roles: ['admin'] };
const customer: Actor = { type: 'user', id: randomUUID(), roles: ['customer'] };
const anonymous: Actor = { type: 'anonymous' };

const overviewDto: SalesOverviewDto = {
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
  rows: [],
  summaries: [],
  nextCursor: null,
  dataThroughAt: null,
  stripeEnabled: false,
  missingSourceCount: 0,
  needsReviewCount: 0
};

const issueDetail: FinancialIssueDetailDto = {
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
  refundId: '33333333-3333-4333-8333-333333333333'
};

const reviewDto: FinancialIssueListDto = {
  issues: [issueDetail],
  currentCursor: null,
  nextCursor: null
};

const payoutDetail: PayoutDetailDto = {
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
  bookstoreLinkedFeeImpactMinor: -50,
  bookstoreLinkedNetMinor: 950,
  reversalAmountMinor: null
};

const payoutDto: PayoutListDto = {
  payouts: [payoutDetail],
  currentCursor: null,
  nextCursor: null
};

function pageEvent(actor: Actor, url: URL | (() => URL)) {
  const event: Record<string, unknown> = { locals: { actor } };
  Object.defineProperty(event, 'url', {
    enumerable: true,
    get: typeof url === 'function' ? url : () => url
  });
  return event;
}

const COMMAND_STATUS_ID = '00000000-0000-4000-8000-000000009901';

function trackedSalesEvent(actor: Actor, path: string) {
  const request = new Request(`https://books.example.test${path}`, {
    headers: { origin: 'https://books.example.test', 'x-request-id': 'task-15-route-matrix' }
  });
  const params = {
    issueId: issueDetail.issueId,
    payoutId: payoutDetail.payoutId
  } as Record<string, string>;
  const commandId = vi.fn(() => COMMAND_STATUS_ID);
  Object.defineProperty(params, 'commandId', { enumerable: true, get: commandId });
  const values = {
    params,
    url: new URL(request.url),
    request,
    route: { id: path.split('?')[0] ?? null }
  };
  const accesses = {
    params: vi.fn(() => values.params),
    url: vi.fn(() => values.url),
    request: vi.fn(() => values.request),
    route: vi.fn(() => values.route),
    commandId
  };
  const event: Record<string, unknown> = { locals: { actor } };
  for (const key of Object.keys(accesses) as Array<keyof typeof accesses>) {
    Object.defineProperty(event, key, { enumerable: true, get: accesses[key] });
  }
  return { event, accesses };
}

async function capturedRouteStatus(operation: () => unknown): Promise<number> {
  try {
    const result = await operation();
    return result instanceof Response ? result.status : 200;
  } catch (cause: unknown) {
    return (cause as { status?: number }).status ?? 500;
  }
}

const salesReadActorCases = [
  { actorLabel: 'anonymous visitor', actor: anonymous, denyRead: false, status: 401 },
  { actorLabel: 'customer', actor: customer, denyRead: false, status: 403 },
  { actorLabel: 'administrator missing sales.read', actor: admin, denyRead: true, status: 403 },
  { actorLabel: 'fully authorized administrator', actor: admin, denyRead: false, status: 200 }
] as const;

describe('complete Task 7–14 Sales capability matrix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.denySalesReadForAdmin = false;
    routeMocks.denySalesExportForAdmin = false;
    routeMocks.listSalesOverview.mockReset().mockResolvedValue(overviewDto);
    routeMocks.canExportSalesOverview.mockReset().mockReturnValue(true);
    routeMocks.exportSalesCsv.mockReset().mockResolvedValue({
      bytes: new TextEncoder().encode('currentTitle\r\nSafe title\r\n'),
      filename: 'sales.csv',
      rowCount: 1
    });
    routeMocks.listFinancialIssues.mockReset().mockResolvedValue(reviewDto);
    routeMocks.getFinancialIssueDetail.mockReset().mockResolvedValue(issueDetail);
    routeMocks.listPayouts.mockReset().mockResolvedValue(payoutDto);
    routeMocks.getPayoutDetail.mockReset().mockResolvedValue(payoutDetail);
    routeMocks.getFinancialAdminCommandStatus.mockReset().mockResolvedValue({
      commandId: COMMAND_STATUS_ID,
      kind: 'refund_draft_save',
      status: 'pending',
      resultCode: null,
      result: null,
      createdAt: '2026-08-22T12:00:00.000Z',
      updatedAt: '2026-08-22T12:00:00.000Z',
      completedAt: null
    });
  });

  it.each(salesReadActorCases)(
    'applies sales.read to the Sales layout for $actorLabel',
    async ({ actor, denyRead, status }) => {
      routeMocks.denySalesReadForAdmin = denyRead;
      expect(await capturedRouteStatus(() => loadSalesLayout({ locals: { actor } } as never)))
        .toBe(status);
    }
  );

  const readSurfaces = [
    {
      surface: 'Sales overview loader',
      path: '/admin/sales',
      invoke: (event: Record<string, unknown>) => overviewRoute.load(event as never),
      service: routeMocks.listSalesOverview
    },
    {
      surface: 'issue list loader',
      path: '/admin/sales/review',
      invoke: (event: Record<string, unknown>) => reviewRoute.load(event as never),
      service: routeMocks.listFinancialIssues
    },
    {
      surface: 'issue detail loader',
      path: `/admin/sales/review/${issueDetail.issueId}`,
      invoke: (event: Record<string, unknown>) => reviewDetailRoute.load(event as never),
      service: routeMocks.getFinancialIssueDetail
    },
    {
      surface: 'payout list loader',
      path: '/admin/sales/payouts',
      invoke: (event: Record<string, unknown>) => payoutsRoute.load(event as never),
      service: routeMocks.listPayouts
    },
    {
      surface: 'payout detail loader',
      path: `/admin/sales/payouts/${payoutDetail.payoutId}`,
      invoke: (event: Record<string, unknown>) => payoutDetailRoute.load(event as never),
      service: routeMocks.getPayoutDetail
    },
    {
      surface: 'command status endpoint',
      path: `/admin/sales/commands/${COMMAND_STATUS_ID}`,
      invoke: (event: Record<string, unknown>) => commandStatusRoute.GET(event as never),
      service: routeMocks.getFinancialAdminCommandStatus
    }
  ] as const;

  it.each(readSurfaces.flatMap((surface) =>
    salesReadActorCases.map((actorCase) => ({ ...surface, ...actorCase }))))(
    'applies sales.read to $surface for $actorLabel before parsing request state',
    async ({ actor, denyRead, status, path, invoke, service }) => {
      routeMocks.denySalesReadForAdmin = denyRead;
      const { event, accesses } = trackedSalesEvent(actor, path);

      expect(await capturedRouteStatus(() => invoke(event))).toBe(status);

      if (status === 200) {
        expect(Object.values(accesses).some((access) => access.mock.calls.length > 0)).toBe(true);
        expect(service).toHaveBeenCalledOnce();
      } else if (path.includes('/commands/')) {
        expect(accesses.commandId).not.toHaveBeenCalled();
        expect(service).not.toHaveBeenCalled();
      } else {
        for (const access of Object.values(accesses)) expect(access).not.toHaveBeenCalled();
        expect(service).not.toHaveBeenCalled();
      }
    }
  );

  it.each([
    { actorLabel: 'anonymous visitor', actor: anonymous, denied: 'none', status: 401 },
    { actorLabel: 'customer', actor: customer, denied: 'none', status: 403 },
    {
      actorLabel: 'administrator missing sales.read',
      actor: admin,
      denied: 'sales.read',
      status: 403
    },
    {
      actorLabel: 'administrator missing sales.export',
      actor: admin,
      denied: 'sales.export',
      status: 403
    },
    { actorLabel: 'fully authorized administrator', actor: admin, denied: 'none', status: 200 }
  ] as const)(
    'applies both CSV capabilities for $actorLabel before parsing filters or audit context',
    async ({ actor, denied, status }) => {
      routeMocks.denySalesReadForAdmin = denied === 'sales.read';
      routeMocks.denySalesExportForAdmin = denied === 'sales.export';
      const { event, accesses } = trackedSalesEvent(actor, '/admin/sales/export.csv');

      expect(await capturedRouteStatus(() => exportRoute.GET(event as never))).toBe(status);

      if (status === 200) {
        for (const access of [accesses.url, accesses.request, accesses.route]) {
          expect(access).toHaveBeenCalled();
        }
        expect(routeMocks.exportSalesCsv).toHaveBeenCalledOnce();
      } else {
        for (const access of Object.values(accesses)) expect(access).not.toHaveBeenCalled();
        expect(routeMocks.exportSalesCsv).not.toHaveBeenCalled();
      }
    }
  );
});

describe('Sales route authorization', () => {
  beforeEach(() => {
    routeMocks.denySalesReadForAdmin = false;
  });

  it.each([
    { actor: anonymous, status: 401 },
    { actor: customer, status: 403 }
  ])('denies the Sales layout with safe status $status', async ({ actor, status }) => {
    await expect(
      Promise.resolve().then(() => loadSalesLayout({ locals: { actor } } as never))
    ).rejects.toMatchObject({ status, body: { message: status === 401 ? 'unauthenticated' : 'forbidden' } });
  });

  it('denies an administrator whose resolved capabilities omit sales.read', async () => {
    routeMocks.denySalesReadForAdmin = true;

    await expect(
      Promise.resolve().then(() => loadSalesLayout({ locals: { actor: admin } } as never))
    ).rejects.toMatchObject({ status: 403, body: { message: 'forbidden' } });
  });

  it('authorizes before accessing Overview URL or invoking reporting', async () => {
    const url = vi.fn(() => new URL('https://books.example.test/admin/sales?private=value'));

    await expect(overviewRoute.load(pageEvent(anonymous, url) as never)).rejects.toMatchObject({
      status: 401,
      body: { message: 'unauthenticated' }
    });
    expect(url).not.toHaveBeenCalled();
    expect(routeMocks.listSalesOverview).not.toHaveBeenCalled();
  });

  it('rechecks sales.read for an administrator missing that specific capability', async () => {
    routeMocks.denySalesReadForAdmin = true;
    const url = vi.fn(() => new URL('https://books.example.test/admin/sales'));

    await expect(overviewRoute.load(pageEvent(admin, url) as never)).rejects.toMatchObject({
      status: 403,
      body: { message: 'forbidden' }
    });
    expect(url).not.toHaveBeenCalled();
    expect(routeMocks.listSalesOverview).not.toHaveBeenCalled();
  });
});

describe('Sales Overview loader', () => {
  beforeEach(() => {
    routeMocks.denySalesReadForAdmin = false;
    routeMocks.canExportSalesOverview.mockReset().mockReturnValue(true);
  });

  it.each([
    '?unknown=value',
    '?range=30&range=7',
    '?cursor=not-canonical'
  ])('maps malformed filters %s to a safe 400', async (search) => {
    await expect(
      overviewRoute.load(
        pageEvent(admin, new URL(`https://books.example.test/admin/sales${search}`)) as never
      )
    ).rejects.toMatchObject({ status: 400, body: { message: 'invalid_request' } });
    expect(routeMocks.listSalesOverview).not.toHaveBeenCalled();
  });

  it('maps a private reporting failure to a detail-free 503', async () => {
    routeMocks.listSalesOverview.mockRejectedValueOnce(
      new Error('private database relation and provider evidence')
    );

    let failure: unknown;
    try {
      await overviewRoute.load(
        pageEvent(admin, new URL('https://books.example.test/admin/sales')) as never
      );
    } catch (cause: unknown) {
      failure = cause;
    }
    expect(failure).toMatchObject({
      status: 503,
      body: { message: 'temporarily_unavailable' }
    });
    expect(JSON.stringify(failure)).not.toContain('private database relation');
  });

  it('accepts blank optional controls from the native GET form without JavaScript', async () => {
    routeMocks.listSalesOverview.mockResolvedValueOnce(overviewDto);

    const result = await overviewRoute.load(
      pageEvent(
        admin,
        new URL(
          'https://books.example.test/admin/sales?range=30&from=&to=&titleId=&format=&presentmentCurrency=&settlementCurrency=&state=&sort=gross_desc'
        )
      ) as never
    );

    expect(result).toEqual({ ...overviewDto, canExport: true });
    expect(routeMocks.listSalesOverview).toHaveBeenCalledOnce();
  });

  it('passes normalized filters and returns the exact service DTO', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T18:45:00.000Z'));
    routeMocks.listSalesOverview.mockResolvedValueOnce(overviewDto);

    try {
      const result = await overviewRoute.load(
        pageEvent(
          admin,
          new URL(
            'https://books.example.test/admin/sales?range=custom&from=2026-08-01&to=2026-08-10&format=comic&presentmentCurrency=USD&settlementCurrency=EUR&state=fee_reconciled&sort=title_asc'
          )
        ) as never
      );

      expect(routeMocks.listSalesOverview).toHaveBeenCalledWith(
        routeMocks.database,
        admin,
        {
          range: 'custom',
          from: new Date('2026-08-01T00:00:00.000Z'),
          to: new Date('2026-08-11T00:00:00.000Z'),
          format: 'comic',
          presentmentCurrency: 'USD',
          settlementCurrency: 'EUR',
          state: 'fee_reconciled',
          sort: 'title_asc',
          pageSize: 50
        }
      );
      expect(result).toEqual({ ...overviewDto, canExport: true });
      expect(Object.keys(result as object)).toEqual([
        'filters',
        'rows',
        'summaries',
        'nextCursor',
        'dataThroughAt',
        'stripeEnabled',
        'missingSourceCount',
        'needsReviewCount',
        'canExport'
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns canExport false without exposing export for a read-only actor', async () => {
    routeMocks.canExportSalesOverview.mockReturnValueOnce(false);
    routeMocks.listSalesOverview.mockResolvedValueOnce(overviewDto);

    await expect(overviewRoute.load(pageEvent(
      admin,
      new URL('https://books.example.test/admin/sales')
    ) as never)).resolves.toEqual({ ...overviewDto, canExport: false });
  });

  it('has no Overview action surface', () => {
    expect('actions' in overviewRoute).toBe(false);
  });
});

describe('bounded audited Sales CSV route', () => {
  beforeEach(() => {
    routeMocks.denySalesReadForAdmin = false;
    routeMocks.denySalesExportForAdmin = false;
    routeMocks.exportSalesCsv.mockReset();
  });

  it.each([
    ['sales.read', anonymous, false, 401],
    ['sales.export', admin, true, 403]
  ])('requires %s before touching URL, request, or route input', async (
    _capability,
    actor,
    denyExport,
    status
  ) => {
    routeMocks.denySalesExportForAdmin = denyExport;
    const accesses = { url: vi.fn(), request: vi.fn(), route: vi.fn() };
    const event: Record<string, unknown> = { locals: { actor } };
    for (const key of Object.keys(accesses) as Array<keyof typeof accesses>) {
      Object.defineProperty(event, key, { enumerable: true, get: accesses[key] });
    }

    const response = await exportRoute.GET(event as never);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({
      code: status === 401 ? 'unauthenticated' : 'forbidden'
    });
    for (const access of Object.values(accesses)) expect(access).not.toHaveBeenCalled();
    expect(routeMocks.exportSalesCsv).not.toHaveBeenCalled();
  });

  it('passes normalized filters and fixed audit context, then returns only complete CSV bytes', async () => {
    const bytes = new TextEncoder().encode('currentTitle\r\nPale Orbit\r\n');
    routeMocks.exportSalesCsv.mockResolvedValueOnce({
      bytes,
      filename: 'pale-orbit-sales-2026-08-01-2026-08-10.csv',
      rowCount: 1
    });
    const request = new Request(
      'https://books.example.test/admin/sales/export.csv?range=custom&from=2026-08-01&to=2026-08-10&format=comic&presentmentCurrency=USD&settlementCurrency=EUR&state=fee_reconciled&sort=title_asc',
      { headers: { 'x-request-id': 'sales-export-route-1' } }
    );

    const response = await exportRoute.GET({
      locals: { actor: admin },
      url: new URL(request.url),
      request,
      route: { id: '/admin/sales/export.csv' }
    } as never);

    expect(routeMocks.exportSalesCsv).toHaveBeenCalledWith(
      routeMocks.database,
      admin,
      {
        range: 'custom',
        from: new Date('2026-08-01T00:00:00.000Z'),
        to: new Date('2026-08-11T00:00:00.000Z'),
        format: 'comic',
        presentmentCurrency: 'USD',
        settlementCurrency: 'EUR',
        state: 'fee_reconciled',
        sort: 'title_asc',
        pageSize: 50
      },
      {
        correlationId: 'sales-export-route-1',
        requestMetadata: { method: 'GET', routeId: '/admin/sales/export.csv' }
      }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="pale-orbit-sales-2026-08-01-2026-08-10.csv"'
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it.each([
    ['malformed filter', new URL('https://books.example.test/admin/sales/export.csv?unknown=private'), null],
    ['bounded service rejection', new URL('https://books.example.test/admin/sales/export.csv'), new SalesReportingInputError('private limit')]
  ])('maps %s to safe non-CSV 400 with no partial bytes', async (_label, url, rejection) => {
    if (rejection !== null) routeMocks.exportSalesCsv.mockRejectedValueOnce(rejection);
    const request = new Request(url);

    const response = await exportRoute.GET({
      locals: { actor: admin }, url, request, route: { id: '/admin/sales/export.csv' }
    } as never);
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBeNull();
    expect(body).toContain('invalid_request');
    expect(body).not.toContain('private');
    if (rejection === null) expect(routeMocks.exportSalesCsv).not.toHaveBeenCalled();
  });

  it('maps a private export failure to a detail-free non-CSV 503', async () => {
    routeMocks.exportSalesCsv.mockRejectedValueOnce(new Error('private CSV query detail'));
    const url = new URL('https://books.example.test/admin/sales/export.csv');
    const request = new Request(url);

    const response = await exportRoute.GET({
      locals: { actor: admin }, url, request, route: { id: '/admin/sales/export.csv' }
    } as never);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get('content-disposition')).toBeNull();
    expect(body).toContain('temporarily_unavailable');
    expect(body).not.toContain('private CSV query detail');
  });
});

describe('Needs Review loaders', () => {
  beforeEach(() => {
    routeMocks.denySalesReadForAdmin = false;
  });

  it('authorizes the queue before reading its URL or calling reporting', async () => {
    const url = vi.fn(() => new URL('https://books.example.test/admin/sales/review?private=value'));

    await expect(reviewRoute.load(pageEvent(anonymous, url) as never)).rejects.toMatchObject({
      status: 401,
      body: { message: 'unauthenticated' }
    });
    expect(url).not.toHaveBeenCalled();
    expect(routeMocks.listFinancialIssues).not.toHaveBeenCalled();
  });

  it('rechecks sales.read for the queue and detail before touching request data', async () => {
    routeMocks.denySalesReadForAdmin = true;
    const queueUrl = vi.fn(() => new URL('https://books.example.test/admin/sales/review'));
    const detailParams = vi.fn(() => ({ issueId: issueDetail.issueId }));
    const detailEvent: Record<string, unknown> = { locals: { actor: admin } };
    Object.defineProperty(detailEvent, 'params', { enumerable: true, get: detailParams });

    await expect(reviewRoute.load(pageEvent(admin, queueUrl) as never)).rejects.toMatchObject({
      status: 403,
      body: { message: 'forbidden' }
    });
    await expect(reviewDetailRoute.load(detailEvent as never)).rejects.toMatchObject({
      status: 403,
      body: { message: 'forbidden' }
    });
    expect(queueUrl).not.toHaveBeenCalled();
    expect(detailParams).not.toHaveBeenCalled();
    expect(routeMocks.listFinancialIssues).not.toHaveBeenCalled();
    expect(routeMocks.getFinancialIssueDetail).not.toHaveBeenCalled();
  });

  it.each([
    '?unknown=value',
    '?cursor=',
    '?cursor=first&cursor=second',
    '?cursor=not-canonical'
  ])('maps malformed queue input %s to a safe 400', async (search) => {
    await expect(reviewRoute.load(pageEvent(
      admin,
      new URL(`https://books.example.test/admin/sales/review${search}`)
    ) as never)).rejects.toMatchObject({
      status: 400,
      body: { message: 'invalid_request' }
    });
    expect(routeMocks.listFinancialIssues).not.toHaveBeenCalled();
  });

  it('passes strict cursor-only input and returns the exact queue DTO', async () => {
    routeMocks.listFinancialIssues.mockResolvedValueOnce(reviewDto);

    const result = await reviewRoute.load(pageEvent(
      admin,
      new URL('https://books.example.test/admin/sales/review')
    ) as never);

    expect(routeMocks.listFinancialIssues).toHaveBeenCalledWith(
      routeMocks.database,
      admin,
      { pageSize: 50 }
    );
    expect(result).toBe(reviewDto);
    expect(Object.keys(result as object)).toEqual(['issues', 'currentCursor', 'nextCursor']);
  });

  it('authorizes detail before touching path, query, request, route, or reporting', async () => {
    const accesses = {
      params: vi.fn(),
      url: vi.fn(),
      request: vi.fn(),
      route: vi.fn()
    };
    const event: Record<string, unknown> = { locals: { actor: anonymous } };
    for (const key of Object.keys(accesses) as Array<keyof typeof accesses>) {
      Object.defineProperty(event, key, { enumerable: true, get: accesses[key] });
    }

    await expect(reviewDetailRoute.load(event as never)).rejects.toMatchObject({
      status: 401,
      body: { message: 'unauthenticated' }
    });
    for (const access of Object.values(accesses)) expect(access).not.toHaveBeenCalled();
    expect(routeMocks.getFinancialIssueDetail).not.toHaveBeenCalled();
  });

  it('treats malformed issue IDs as safe 404 before reading request context', async () => {
    const request = vi.fn(() => new Request('https://books.example.test/admin/sales/review/private'));
    const event: Record<string, unknown> = {
      locals: { actor: admin },
      params: { issueId: 'PRIVATE-NONCANONICAL-ID' }
    };
    Object.defineProperty(event, 'request', { enumerable: true, get: request });

    await expect(reviewDetailRoute.load(event as never)).rejects.toMatchObject({
      status: 404,
      body: { message: 'not_found' }
    });
    expect(request).not.toHaveBeenCalled();
    expect(routeMocks.getFinancialIssueDetail).not.toHaveBeenCalled();
  });

  it('passes fixed audit context and preserves only a validated local queue cursor', async () => {
    const { encodeFinancialIssueCursor } = await import(
      '$lib/server/commerce/reporting/review'
    );
    const cursor = encodeFinancialIssueCursor({
      actionabilityRank: 1,
      impactRank: 0,
      firstObservedAt: '2026-08-01T10:00:00.000000Z',
      issueId: issueDetail.issueId
    });
    routeMocks.getFinancialIssueDetail.mockResolvedValueOnce(issueDetail);
    const request = new Request(
      `https://books.example.test/admin/sales/review/${issueDetail.issueId}?cursor=${cursor}`,
      { headers: { 'x-request-id': 'review-route-1' } }
    );

    const result = await reviewDetailRoute.load({
      locals: { actor: admin },
      params: { issueId: issueDetail.issueId },
      url: new URL(request.url),
      request,
      route: { id: '/admin/sales/review/[issueId]' }
    } as never);

    expect(routeMocks.getFinancialIssueDetail).toHaveBeenCalledWith(
      routeMocks.database,
      admin,
      issueDetail.issueId,
      {
        correlationId: 'review-route-1',
        requestMetadata: { method: 'GET', routeId: '/admin/sales/review/[issueId]' }
      }
    );
    expect(result).toEqual({ issue: issueDetail, currentCursor: cursor });
  });

  it.each([
    '?unknown=value',
    '?cursor=',
    '?cursor=first&cursor=second',
    '?cursor=not-canonical'
  ])('maps malformed detail return context %s to a safe 400 after validating the issue ID', async (search) => {
    const request = new Request(
      `https://books.example.test/admin/sales/review/${issueDetail.issueId}${search}`
    );

    await expect(reviewDetailRoute.load({
      locals: { actor: admin },
      params: { issueId: issueDetail.issueId },
      url: new URL(request.url),
      request,
      route: { id: '/admin/sales/review/[issueId]' }
    } as never)).rejects.toMatchObject({
      status: 400,
      body: { message: 'invalid_request' }
    });
    expect(routeMocks.getFinancialIssueDetail).not.toHaveBeenCalled();
  });

  it('returns the same safe 404 for a missing or inaccessible operational issue', async () => {
    routeMocks.getFinancialIssueDetail.mockResolvedValueOnce(null);

    await expect(reviewDetailRoute.load({
      locals: { actor: admin },
      params: { issueId: issueDetail.issueId },
      url: new URL(`https://books.example.test/admin/sales/review/${issueDetail.issueId}`),
      request: new Request(`https://books.example.test/admin/sales/review/${issueDetail.issueId}`),
      route: { id: '/admin/sales/review/[issueId]' }
    } as never)).rejects.toMatchObject({
      status: 404,
      body: { message: 'not_found' }
    });
  });

  it('maps private queue/detail failures to detail-free 503 responses', async () => {
    routeMocks.listFinancialIssues.mockRejectedValueOnce(new Error('private queue SQL'));
    routeMocks.getFinancialIssueDetail.mockRejectedValueOnce(new Error('private detail SQL'));

    const queueFailure = reviewRoute.load(pageEvent(
      admin,
      new URL('https://books.example.test/admin/sales/review')
    ) as never);
    const detailFailure = reviewDetailRoute.load({
      locals: { actor: admin },
      params: { issueId: issueDetail.issueId },
      url: new URL(`https://books.example.test/admin/sales/review/${issueDetail.issueId}`),
      request: new Request(`https://books.example.test/admin/sales/review/${issueDetail.issueId}`),
      route: { id: '/admin/sales/review/[issueId]' }
    } as never);

    await expect(queueFailure).rejects.toMatchObject({
      status: 503,
      body: { message: 'temporarily_unavailable' }
    });
    await expect(detailFailure).rejects.toMatchObject({
      status: 503,
      body: { message: 'temporarily_unavailable' }
    });
    await expect(queueFailure).rejects.not.toHaveProperty('body.message', 'private queue SQL');
  });

  it('exposes no queue or detail action surface', () => {
    expect('actions' in reviewRoute).toBe(false);
    expect('actions' in reviewDetailRoute).toBe(false);
  });
});

describe('Payout list and audited detail loaders', () => {
  beforeEach(() => {
    routeMocks.denySalesReadForAdmin = false;
  });

  it('authorizes the payout list before reading its URL or calling reporting', async () => {
    const url = vi.fn(() => new URL('https://books.example.test/admin/sales/payouts?private=value'));

    await expect(payoutsRoute.load(pageEvent(anonymous, url) as never)).rejects.toMatchObject({
      status: 401,
      body: { message: 'unauthenticated' }
    });
    expect(url).not.toHaveBeenCalled();
    expect(routeMocks.listPayouts).not.toHaveBeenCalled();
  });

  it('rechecks sales.read for list and detail before touching request data', async () => {
    routeMocks.denySalesReadForAdmin = true;
    const listUrl = vi.fn(() => new URL('https://books.example.test/admin/sales/payouts'));
    const detailParams = vi.fn(() => ({ payoutId: payoutDetail.payoutId }));
    const detailEvent: Record<string, unknown> = { locals: { actor: admin } };
    Object.defineProperty(detailEvent, 'params', { enumerable: true, get: detailParams });

    await expect(payoutsRoute.load(pageEvent(admin, listUrl) as never)).rejects.toMatchObject({
      status: 403,
      body: { message: 'forbidden' }
    });
    await expect(payoutDetailRoute.load(detailEvent as never)).rejects.toMatchObject({
      status: 403,
      body: { message: 'forbidden' }
    });
    expect(listUrl).not.toHaveBeenCalled();
    expect(detailParams).not.toHaveBeenCalled();
    expect(routeMocks.listPayouts).not.toHaveBeenCalled();
    expect(routeMocks.getPayoutDetail).not.toHaveBeenCalled();
  });

  it.each([
    '?unknown=value',
    '?cursor=',
    '?cursor=first&cursor=second',
    '?cursor=not-canonical'
  ])('maps malformed payout-list input %s to a safe 400', async (search) => {
    await expect(payoutsRoute.load(pageEvent(
      admin,
      new URL(`https://books.example.test/admin/sales/payouts${search}`)
    ) as never)).rejects.toMatchObject({
      status: 400,
      body: { message: 'invalid_request' }
    });
    expect(routeMocks.listPayouts).not.toHaveBeenCalled();
  });

  it('passes strict cursor-only list input and returns the exact service DTO', async () => {
    routeMocks.listPayouts.mockResolvedValueOnce(payoutDto);

    const result = await payoutsRoute.load(pageEvent(
      admin,
      new URL('https://books.example.test/admin/sales/payouts')
    ) as never);

    expect(routeMocks.listPayouts).toHaveBeenCalledWith(
      routeMocks.database,
      admin,
      { pageSize: 50 }
    );
    expect(result).toBe(payoutDto);
    expect(Object.keys(result as object)).toEqual(['payouts', 'currentCursor', 'nextCursor']);
  });

  it('authorizes payout detail before touching path, query, request, or route', async () => {
    const accesses = {
      params: vi.fn(),
      url: vi.fn(),
      request: vi.fn(),
      route: vi.fn()
    };
    const event: Record<string, unknown> = { locals: { actor: anonymous } };
    for (const key of Object.keys(accesses) as Array<keyof typeof accesses>) {
      Object.defineProperty(event, key, { enumerable: true, get: accesses[key] });
    }

    await expect(payoutDetailRoute.load(event as never)).rejects.toMatchObject({
      status: 401,
      body: { message: 'unauthenticated' }
    });
    for (const access of Object.values(accesses)) expect(access).not.toHaveBeenCalled();
    expect(routeMocks.getPayoutDetail).not.toHaveBeenCalled();
  });

  it('treats malformed payout IDs as safe 404 before reading request context', async () => {
    const request = vi.fn(() => new Request('https://books.example.test/admin/sales/payouts/private'));
    const event: Record<string, unknown> = {
      locals: { actor: admin },
      params: { payoutId: 'PRIVATE-NONCANONICAL-ID' }
    };
    Object.defineProperty(event, 'request', { enumerable: true, get: request });

    await expect(payoutDetailRoute.load(event as never)).rejects.toMatchObject({
      status: 404,
      body: { message: 'not_found' }
    });
    expect(request).not.toHaveBeenCalled();
    expect(routeMocks.getPayoutDetail).not.toHaveBeenCalled();
  });

  it('passes fixed audit context and preserves only a validated payout cursor', async () => {
    const { encodePayoutCursor } = await import('$lib/server/commerce/reporting/payouts');
    const cursor = encodePayoutCursor({
      providerCreatedAt: '2026-08-01T10:00:00.123456Z',
      payoutId: payoutDetail.payoutId
    });
    routeMocks.getPayoutDetail.mockResolvedValueOnce(payoutDetail);
    const request = new Request(
      `https://books.example.test/admin/sales/payouts/${payoutDetail.payoutId}?cursor=${cursor}`,
      { headers: { 'x-request-id': 'payout-route-1' } }
    );

    const result = await payoutDetailRoute.load({
      locals: { actor: admin },
      params: { payoutId: payoutDetail.payoutId },
      url: new URL(request.url),
      request,
      route: { id: '/admin/sales/payouts/[payoutId]' }
    } as never);

    expect(routeMocks.getPayoutDetail).toHaveBeenCalledWith(
      routeMocks.database,
      admin,
      payoutDetail.payoutId,
      {
        correlationId: 'payout-route-1',
        requestMetadata: { method: 'GET', routeId: '/admin/sales/payouts/[payoutId]' }
      }
    );
    expect(result).toEqual({ payout: payoutDetail, currentCursor: cursor });
  });

  it.each([
    '?unknown=value',
    '?cursor=',
    '?cursor=first&cursor=second',
    '?cursor=not-canonical'
  ])('maps malformed payout return context %s to safe 400', async (search) => {
    const request = new Request(
      `https://books.example.test/admin/sales/payouts/${payoutDetail.payoutId}${search}`
    );

    await expect(payoutDetailRoute.load({
      locals: { actor: admin },
      params: { payoutId: payoutDetail.payoutId },
      url: new URL(request.url),
      request,
      route: { id: '/admin/sales/payouts/[payoutId]' }
    } as never)).rejects.toMatchObject({
      status: 400,
      body: { message: 'invalid_request' }
    });
    expect(routeMocks.getPayoutDetail).not.toHaveBeenCalled();
  });

  it('returns the same safe 404 for a missing or inaccessible payout', async () => {
    routeMocks.getPayoutDetail.mockResolvedValueOnce(null);

    await expect(payoutDetailRoute.load({
      locals: { actor: admin },
      params: { payoutId: payoutDetail.payoutId },
      url: new URL(`https://books.example.test/admin/sales/payouts/${payoutDetail.payoutId}`),
      request: new Request(`https://books.example.test/admin/sales/payouts/${payoutDetail.payoutId}`),
      route: { id: '/admin/sales/payouts/[payoutId]' }
    } as never)).rejects.toMatchObject({
      status: 404,
      body: { message: 'not_found' }
    });
  });

  it('maps private list/detail failures to detail-free 503 responses', async () => {
    routeMocks.listPayouts.mockRejectedValueOnce(new Error('private payout SQL'));
    routeMocks.getPayoutDetail.mockRejectedValueOnce(new Error('private payout detail SQL'));

    const listFailure = payoutsRoute.load(pageEvent(
      admin,
      new URL('https://books.example.test/admin/sales/payouts')
    ) as never);
    const detailFailure = payoutDetailRoute.load({
      locals: { actor: admin },
      params: { payoutId: payoutDetail.payoutId },
      url: new URL(`https://books.example.test/admin/sales/payouts/${payoutDetail.payoutId}`),
      request: new Request(`https://books.example.test/admin/sales/payouts/${payoutDetail.payoutId}`),
      route: { id: '/admin/sales/payouts/[payoutId]' }
    } as never);

    await expect(listFailure).rejects.toMatchObject({
      status: 503,
      body: { message: 'temporarily_unavailable' }
    });
    await expect(detailFailure).rejects.toMatchObject({
      status: 503,
      body: { message: 'temporarily_unavailable' }
    });
    await expect(listFailure).rejects.not.toHaveProperty('body.message', 'private payout SQL');
  });

  it('exposes no payout list or detail action surface', () => {
    expect('actions' in payoutsRoute).toBe(false);
    expect('actions' in payoutDetailRoute).toBe(false);
  });
});
