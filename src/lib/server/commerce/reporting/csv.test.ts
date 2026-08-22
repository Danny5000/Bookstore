import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthorizationError,
  type AdminCapability,
  type Actor,
  type AdministratorActor
} from '$lib/server/auth/admin-policy';
import type { Database } from '$lib/server/db/client';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import {
  SALES_CSV_ROW_DTO_KEYS,
  type SalesCsvRowDto,
  type TitleSalesRowDto
} from '$lib/types/financial-reporting';

const collaborators = vi.hoisted(() => ({
  audit: vi.fn(),
  listRoles: vi.fn(),
  loadRows: vi.fn(),
  loadDataThrough: vi.fn()
}));

vi.mock('$lib/server/auth/identity', () => ({
  listRolesForUser: collaborators.listRoles
}));

vi.mock('./audit', () => ({
  auditFinancialExportCompleted: collaborators.audit
}));

vi.mock('./overview', async (importOriginal) => {
  const actual: typeof import('./overview') = await importOriginal();
  return {
    ...actual,
    loadSalesAggregateRows: collaborators.loadRows,
    loadSalesDataThroughAt: collaborators.loadDataThrough
  };
});

import {
  SALES_CSV_MAX_BYTES,
  SALES_CSV_DEADLINE_MS,
  SALES_CSV_MAX_ROWS,
  exportSalesCsv,
  neutralizeCsvText,
  serializeSalesCsv
} from './csv';

const dialect = new PgDialect();
const ADMIN_ID = '00000000-0000-4000-8000-000000009000';
const ADMIN: AdministratorActor = { type: 'user', id: ADMIN_ID, roles: ['admin'] };
const CUSTOM_FILTERS = {
  range: 'custom',
  from: new Date('2026-08-01T00:00:00.000Z'),
  to: new Date('2026-08-11T00:00:00.000Z'),
  format: 'comic',
  presentmentCurrency: 'USD',
  settlementCurrency: 'EUR',
  state: 'fee_reconciled',
  sort: 'title_asc',
  pageSize: 50,
  cursor: {
    filterFingerprint: 'a'.repeat(64),
    primary: 'Pale Orbit',
    titleId: '00000000-0000-4000-8000-000000009001',
    presentmentCurrency: 'USD',
    settlementCurrency: 'EUR'
  }
} as const;

function aggregateRow(
  overrides: Partial<TitleSalesRowDto> = {}
): TitleSalesRowDto {
  return {
    titleId: '00000000-0000-4000-8000-000000009001',
    currentTitle: 'Pale Orbit',
    format: 'comic',
    archived: false,
    soldAsVariants: [
      { title: 'Pale Orbit, First Edition', creatorName: 'A. Writer', format: 'prose' }
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
    estimatedPayoutMinor: 1_610,
    settlementMetricsComplete: true,
    missingSourceCount: 0,
    state: 'fee_reconciled',
    freshnessAt: '2026-08-21T12:00:00.000Z',
    ...overrides
  } as TitleSalesRowDto;
}

function fakeDatabase(order: string[] = []): {
  readonly database: Database;
  readonly execute: ReturnType<typeof vi.fn>;
  readonly transaction: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn(async (statement: SQL) => {
    const rendered = dialect.sqlToQuery(statement);
    order.push(rendered.sql.includes('set_config') ? 'timeout' : 'role-lock');
    return { rows: [] };
  });
  const transaction = vi.fn(async (
    work: (transaction: DatabaseTransaction) => Promise<unknown>
  ) => work({ execute } as unknown as DatabaseTransaction));
  return { database: { transaction } as unknown as Database, execute, transaction };
}

function completeRow(overrides: Partial<SalesCsvRowDto> = {}): SalesCsvRowDto {
  return {
    currentTitle: 'Pale Orbit',
    titleId: '00000000-0000-4000-8000-000000009001',
    format: 'prose',
    archived: false,
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
    estimatedPayoutMinor: 1_610,
    settlementMetricsComplete: true,
    missingSourceCount: 0,
    state: 'fee_reconciled',
    range: '30',
    dataThroughAt: '2026-08-21T11:00:00.000Z',
    soldAsVariantsJson:
      '[{"title":"Pale Orbit, First Edition","creatorName":"A. Writer","format":"prose"}]',
    ...overrides
  } as SalesCsvRowDto;
}

function incompleteRow(overrides: Partial<SalesCsvRowDto> = {}): SalesCsvRowDto {
  return {
    ...completeRow(),
    settlementCurrency: '',
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
    state: 'pending',
    dataThroughAt: null,
    ...overrides
  } as SalesCsvRowDto;
}

describe('sales CSV text neutralization', () => {
  it.each([
    ['leading tab', '\tcmd', "'\tcmd"],
    ['leading carriage return', '\r=SUM(A1:A2)', "'\r=SUM(A1:A2)"],
    ['leading line feed', '\n=SUM(A1:A2)', "'\n=SUM(A1:A2)"],
    ['spaces before equals', '   =SUM(A1:A2)', "'   =SUM(A1:A2)"],
    ['spaces before plus', ' +cmd', "' +cmd"],
    ['spaces before minus', '  -cmd', "'  -cmd"],
    ['spaces before at', ' @cmd', "' @cmd"],
    ['spaces before tab', ' \tcmd', "' \tcmd"]
  ])('prefixes exactly one apostrophe for %s', (_label, value, expected) => {
    expect(neutralizeCsvText(value)).toBe(expected);
  });

  it.each([
    ['empty text', ''],
    ['ordinary text', 'Pale Orbit'],
    ['existing apostrophe', "'=SUM(A1:A2)"],
    ['non-breaking space', '\u00a0=SUM(A1:A2)'],
    ['Unicode text', '月の軌道']
  ])('preserves safe %s without normalization', (_label, value) => {
    expect(neutralizeCsvText(value)).toBe(value);
  });
});

describe('bounded audited sales CSV export', () => {
  beforeEach(() => {
    collaborators.audit.mockReset();
    collaborators.listRoles.mockReset().mockResolvedValue(['customer', 'admin']);
    collaborators.loadRows.mockReset().mockResolvedValue([aggregateRow()]);
    collaborators.loadDataThrough.mockReset().mockResolvedValue('2026-08-21T11:00:00.000Z');
  });

  it.each([
    ['sales.read', (): ReadonlySet<AdminCapability> => new Set(), 'sales.read'],
    ['sales.export', (): ReadonlySet<AdminCapability> => new Set(['sales.read']), 'sales.export']
  ])('requires %s before reading filters or opening a transaction', async (
    _label,
    capabilityResolver,
    _missing
  ) => {
    const { database, transaction } = fakeDatabase();
    let filterRead = false;
    const protectedFilters = Object.defineProperty({}, 'range', {
      get() {
        filterRead = true;
        return 'all';
      }
    });

    await expect(exportSalesCsv(
      database,
      ADMIN,
      protectedFilters as never,
      { correlationId: 'csv-denied' },
      { capabilityResolver }
    )).rejects.toEqual(new AuthorizationError('forbidden', 403));
    expect(filterRead).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('sets shrinking transaction-local timeouts, locks roles, reloads and reauthorizes before data', async () => {
    const order: string[] = [];
    const database = fakeDatabase(order);
    collaborators.listRoles.mockImplementation(async () => {
      order.push('role-reload');
      return ['customer', 'admin'];
    });
    collaborators.loadRows.mockImplementation(async () => {
      order.push('rows');
      return [aggregateRow()];
    });
    collaborators.loadDataThrough.mockImplementation(async () => {
      order.push('freshness');
      return '2026-08-21T11:00:00.000Z';
    });
    collaborators.audit.mockImplementation(async () => {
      order.push('audit');
    });
    let now = 1_000;
    const monotonicNow = vi.fn(() => now++);

    await exportSalesCsv(database.database, ADMIN, CUSTOM_FILTERS, {
      correlationId: 'csv-sequence',
      requestMetadata: { method: 'GET', routeId: '/admin/sales/export.csv' }
    }, { monotonicNow });

    expect(order).toEqual([
      'timeout', 'role-lock', 'timeout', 'role-reload',
      'timeout', 'rows', 'timeout', 'freshness', 'timeout', 'audit'
    ]);
    expect(database.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'repeatable read'
    });
    const timeoutCalls = database.execute.mock.calls
      .map(([statement]) => dialect.sqlToQuery(statement as SQL))
      .filter((statement) => statement.sql.includes('set_config'));
    expect(timeoutCalls).toHaveLength(5);
    expect(timeoutCalls.every((statement) =>
      statement.sql.includes("pg_catalog.set_config('statement_timeout'") &&
      Number(statement.params[0]) > 0 && Number(statement.params[0]) <= SALES_CSV_DEADLINE_MS
    )).toBe(true);
    const timeoutValues = timeoutCalls.map((statement) => Number(statement.params[0]));
    expect(timeoutValues).toEqual([...timeoutValues].sort((left, right) => right - left));
    expect(new Set(timeoutValues).size).toBe(timeoutValues.length);
    expect(collaborators.listRoles).toHaveBeenCalledWith(expect.any(Object), ADMIN_ID);
  });

  it('exports the cursor-free complete cohort, maps safe rows, and audits only bounded counts', async () => {
    const database = fakeDatabase();
    const secondTitle = aggregateRow({
      titleId: '00000000-0000-4000-8000-000000009002',
      currentTitle: '=Unsafe title',
      presentmentCurrency: 'CAD',
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
      missingSourceCount: 1,
      state: 'pending'
    });
    collaborators.loadRows.mockResolvedValueOnce([aggregateRow(), secondTitle]);
    const context = {
      correlationId: 'csv-success',
      requestMetadata: { method: 'GET' as const, routeId: '/admin/sales/export.csv' }
    };

    const result = await exportSalesCsv(
      database.database,
      ADMIN,
      CUSTOM_FILTERS,
      context,
      { monotonicNow: () => 1_000 }
    );

    expect(result.filename).toBe('pale-orbit-sales-2026-08-01-2026-08-10.csv');
    expect(result.rowCount).toBe(2);
    expect(collaborators.loadRows).toHaveBeenCalledWith(
      expect.any(Object),
      expect.not.objectContaining({ cursor: expect.anything() }),
      { applyCursor: false, limit: SALES_CSV_MAX_ROWS + 1 }
    );
    const csv = new TextDecoder().decode(result.bytes);
    expect(csv).toContain("'=Unsafe title");
    expect(csv).toContain(',CAD,,');
    expect(csv).not.toContain('csv-success');
    expect(collaborators.audit).toHaveBeenCalledWith(expect.any(Object), {
      actor: { type: 'user', id: ADMIN_ID, roles: ['customer', 'admin'] },
      filterFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      rowCount: 2,
      byteCount: result.bytes.byteLength,
      currencyPairCount: 2,
      context
    });
  });

  it('uses the fixed all-time filename', async () => {
    const database = fakeDatabase();

    await expect(exportSalesCsv(database.database, ADMIN, {
      range: 'all', sort: 'gross_desc', pageSize: 50
    }, { correlationId: 'csv-all-time' }, {
      monotonicNow: () => 1_000
    })).resolves.toMatchObject({ filename: 'pale-orbit-sales-all-time.csv' });
  });

  it('rejects the 10,001st aggregate row before serialization or audit', async () => {
    const database = fakeDatabase();
    collaborators.loadRows.mockResolvedValueOnce(
      Array.from({ length: SALES_CSV_MAX_ROWS + 1 }, () => aggregateRow())
    );

    await expect(exportSalesCsv(
      database.database,
      ADMIN,
      CUSTOM_FILTERS,
      { correlationId: 'csv-row-limit' },
      { monotonicNow: () => 1_000 }
    )).rejects.toMatchObject({ name: 'SalesReportingInputError', status: 400 });
    expect(collaborators.loadDataThrough).not.toHaveBeenCalled();
    expect(collaborators.audit).not.toHaveBeenCalled();
  });

  it('rolls back the response when the monotonic deadline expires', async () => {
    const database = fakeDatabase();
    const monotonicNow = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValue(SALES_CSV_DEADLINE_MS);

    await expect(exportSalesCsv(
      database.database,
      ADMIN,
      CUSTOM_FILTERS,
      { correlationId: 'csv-deadline' },
      { monotonicNow }
    )).rejects.toMatchObject({ name: 'SalesReportingInputError', status: 400 });
    expect(collaborators.loadRows).not.toHaveBeenCalled();
    expect(collaborators.audit).not.toHaveBeenCalled();
  });

  it('returns no successful export when the fixed audit fails', async () => {
    const database = fakeDatabase();
    collaborators.audit.mockRejectedValueOnce(new Error('private audit failure'));

    await expect(exportSalesCsv(
      database.database,
      ADMIN,
      CUSTOM_FILTERS,
      { correlationId: 'csv-audit-failure' },
      { monotonicNow: () => 1_000 }
    )).rejects.toThrow('private audit failure');
    expect(collaborators.audit).toHaveBeenCalledOnce();
  });

  it('rejects persisted-role demotion before loading aggregate rows', async () => {
    const database = fakeDatabase();
    collaborators.listRoles.mockResolvedValueOnce(['customer']);

    await expect(exportSalesCsv(
      database.database,
      ADMIN as Actor,
      CUSTOM_FILTERS,
      { correlationId: 'csv-demoted' },
      { monotonicNow: () => 1_000 }
    )).rejects.toMatchObject({ name: 'AuthorizationError', code: 'forbidden' });
    expect(collaborators.loadRows).not.toHaveBeenCalled();
    expect(collaborators.audit).not.toHaveBeenCalled();
  });
});

describe('sales CSV serialization', () => {
  it('uses the exact fixed header, minimal RFC 4180 quoting, CRLF, and no BOM', () => {
    const bytes = serializeSalesCsv([
      completeRow({ currentTitle: ' =SUM(A1:A2)\r\n"quoted"' })
    ]);
    const csv = new TextDecoder().decode(bytes);

    expect(csv.startsWith('\ufeff')).toBe(false);
    expect(csv.split('\r\n')[0]).toBe(SALES_CSV_ROW_DTO_KEYS.join(','));
    expect(csv).toContain('"\' =SUM(A1:A2)\r\n""quoted"""');
    expect(csv).toContain(',-460,-138,-90,10,-15,3,1610,');
    expect(csv).toContain(
      '"[{""title"":""Pale Orbit, First Edition"",""creatorName"":""A. Writer"",""format"":""prose""}]"'
    );
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.endsWith('\r\n\r\n')).toBe(false);
  });

  it('leaves every unavailable settlement field blank instead of serializing zero', () => {
    const csv = new TextDecoder().decode(serializeSalesCsv([incompleteRow()]));
    const fields = csv.split('\r\n')[1]!.split(',');

    expect(fields[5]).toBe('');
    expect(fields.slice(13, 21)).toEqual(['', '', '', '', '', '', '', '']);
    expect(fields[21]).toBe('false');
    expect(fields[22]).toBe('2');
    expect(fields[25]).toBe('');
  });

  it('serializes only fixed cells and never emits an extra private property', () => {
    const row = {
      ...completeRow(),
      customerEmail: 'private@example.test',
      providerId: 'ch_private'
    };
    const csv = new TextDecoder().decode(serializeSalesCsv([row as never]));

    expect(csv).not.toContain('private@example.test');
    expect(csv).not.toContain('ch_private');
  });

  it('rejects the 10,001st row without returning a truncated file', () => {
    const row = completeRow();
    const rows = Array.from({ length: SALES_CSV_MAX_ROWS + 1 }, () => row);

    expect(() => serializeSalesCsv(rows)).toThrow(/invalid/iu);
  });

  it('rejects an encoded file over 10 MiB before returning bytes', () => {
    const oversized = completeRow({ soldAsVariantsJson: 'x'.repeat(SALES_CSV_MAX_BYTES) });

    expect(() => serializeSalesCsv([oversized])).toThrow(/invalid/iu);
  });
});
