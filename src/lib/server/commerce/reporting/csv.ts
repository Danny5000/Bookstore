import { performance } from 'node:perf_hooks';
import { sql } from 'drizzle-orm';
import { isSupportedCommerceCurrency } from '$lib/commerce/money';
import {
  requireCapability,
  type Actor,
  type AdministratorActor,
  type FinancialAuthorizationDependencies
} from '$lib/server/auth/admin-policy';
import { listRolesForUser } from '$lib/server/auth/identity';
import type { Database } from '$lib/server/db/client';
import { userRoles } from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import type { SalesCsvRowDto } from '$lib/types/financial-reporting';
import { SALES_CSV_ROW_DTO_KEYS } from '$lib/types/financial-reporting';
import { auditFinancialExportCompleted } from './audit';
import type { FinancialRequestContext } from './context';
import {
  fingerprintSalesFilters,
  SALES_PAGE_SIZE,
  SalesReportingInputError,
  type SalesOverviewFilters
} from './filters';
import { loadSalesAggregateRows, loadSalesDataThroughAt } from './overview';

export const SALES_CSV_MAX_ROWS = 10_000;
export const SALES_CSV_MAX_BYTES = 10 * 1024 * 1024;
export const SALES_CSV_DEADLINE_MS = 25_000;

const FORMULA_PREFIXES = new Set(['=', '+', '-', '@', '\t', '\r', '\n']);
const encoder = new TextEncoder();
const DAY_MS = 24 * 60 * 60 * 1_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RANGES = new Set(['7', '30', '90', 'all', 'custom']);
const SORTS = new Set(['gross_desc', 'title_asc']);
const FORMATS = new Set(['prose', 'comic']);
const STATES = new Set(['pending', 'fee_reconciled', 'payout_reconciled', 'exception']);

export interface SalesCsvDependencies extends FinancialAuthorizationDependencies {
  readonly monotonicNow?: () => number;
}

export interface SalesCsvExport {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly filename: string;
  readonly rowCount: number;
}

function invalidCsv(): never {
  throw new SalesReportingInputError();
}

function canonicalCurrency(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{3}$/u.test(value) &&
    isSupportedCommerceCurrency(value);
}

function utcMidnight(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime()) &&
    value.getUTCHours() === 0 && value.getUTCMinutes() === 0 &&
    value.getUTCSeconds() === 0 && value.getUTCMilliseconds() === 0;
}

function optionalFilter<T>(value: T | undefined, key: string): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

function normalizeExportFilters(value: SalesOverviewFilters): SalesOverviewFilters {
  if (value === null || typeof value !== 'object') return invalidCsv();
  const range = value.range;
  const sort = value.sort;
  if (
    !RANGES.has(range) || !SORTS.has(sort) || value.pageSize !== SALES_PAGE_SIZE ||
    (value.titleId !== undefined && !UUID_PATTERN.test(value.titleId)) ||
    (value.format !== undefined && !FORMATS.has(value.format)) ||
    (value.presentmentCurrency !== undefined && !canonicalCurrency(value.presentmentCurrency)) ||
    (value.settlementCurrency !== undefined && value.settlementCurrency !== 'pending' &&
      !canonicalCurrency(value.settlementCurrency)) ||
    (value.state !== undefined && !STATES.has(value.state)) ||
    (value.settlementCurrency === 'pending' &&
      (value.state === 'fee_reconciled' || value.state === 'payout_reconciled'))
  ) {
    return invalidCsv();
  }

  if (range === 'all') {
    if (value.from !== undefined || value.to !== undefined) return invalidCsv();
  } else {
    if (!utcMidnight(value.from) || !utcMidnight(value.to) || value.from >= value.to) {
      return invalidCsv();
    }
    if (range !== 'custom' && value.to.getTime() - value.from.getTime() !== Number(range) * DAY_MS) {
      return invalidCsv();
    }
  }

  return {
    range,
    ...optionalFilter(value.from, 'from'),
    ...optionalFilter(value.to, 'to'),
    ...optionalFilter(value.titleId, 'titleId'),
    ...optionalFilter(value.format, 'format'),
    ...optionalFilter(value.presentmentCurrency, 'presentmentCurrency'),
    ...optionalFilter(value.settlementCurrency, 'settlementCurrency'),
    ...optionalFilter(value.state, 'state'),
    sort,
    pageSize: SALES_PAGE_SIZE
  } as SalesOverviewFilters;
}

function readClock(clock: () => number): number {
  const value = clock();
  return Number.isFinite(value) ? value : invalidCsv();
}

function assertBeforeDeadline(clock: () => number, deadline: number): number {
  const remaining = Math.ceil(deadline - readClock(clock));
  if (!Number.isSafeInteger(remaining) || remaining <= 0) return invalidCsv();
  return Math.min(remaining, SALES_CSV_DEADLINE_MS);
}

async function setRemainingStatementTimeout(
  transaction: DatabaseTransaction,
  clock: () => number,
  deadline: number
): Promise<void> {
  const remaining = assertBeforeDeadline(clock, deadline);
  await transaction.execute(
    sql`select pg_catalog.set_config('statement_timeout', ${String(remaining)}, true)`
  );
  assertBeforeDeadline(clock, deadline);
}

function csvFilename(filters: SalesOverviewFilters): string {
  if (filters.range === 'all') return 'pale-orbit-sales-all-time.csv';
  if (filters.from === undefined || filters.to === undefined) return invalidCsv();
  const inclusiveEnd = new Date(filters.to.getTime() - DAY_MS);
  return `pale-orbit-sales-${filters.from.toISOString().slice(0, 10)}-${inclusiveEnd.toISOString().slice(0, 10)}.csv`;
}

function toCsvRow(
  row: Awaited<ReturnType<typeof loadSalesAggregateRows>>[number],
  range: SalesCsvRowDto['range'],
  dataThroughAt: string | null
): SalesCsvRowDto {
  const common = {
    currentTitle: row.currentTitle,
    titleId: row.titleId,
    format: row.format,
    archived: row.archived,
    presentmentCurrency: row.presentmentCurrency,
    soldCopies: row.soldCopies,
    fullyRefundedCopies: row.fullyRefundedCopies,
    netCopies: row.netCopies,
    grossPresentmentMinor: row.grossPresentmentMinor,
    finalizedRefundPresentmentMinor: row.finalizedRefundPresentmentMinor,
    disputeWithdrawalPresentmentMinor: row.disputeWithdrawalPresentmentMinor,
    disputeReinstatementPresentmentMinor: row.disputeReinstatementPresentmentMinor,
    range,
    dataThroughAt,
    soldAsVariantsJson: JSON.stringify(row.soldAsVariants)
  } as const;
  if (row.settlementMetricsComplete) {
    return {
      ...common,
      settlementCurrency: row.settlementCurrency,
      grossSettlementMinor: row.grossSettlementMinor,
      refundImpactMinor: row.refundImpactMinor,
      disputeImpactMinor: row.disputeImpactMinor,
      processingFeeImpactMinor: row.processingFeeImpactMinor,
      refundFeeImpactMinor: row.refundFeeImpactMinor,
      disputeFeeImpactMinor: row.disputeFeeImpactMinor,
      otherFeeImpactMinor: row.otherFeeImpactMinor,
      estimatedPayoutMinor: row.estimatedPayoutMinor,
      settlementMetricsComplete: true,
      missingSourceCount: 0,
      state: row.state
    };
  }
  return {
    ...common,
    settlementCurrency: row.settlementCurrency ?? '',
    grossSettlementMinor: null,
    refundImpactMinor: null,
    disputeImpactMinor: null,
    processingFeeImpactMinor: null,
    refundFeeImpactMinor: null,
    disputeFeeImpactMinor: null,
    otherFeeImpactMinor: null,
    estimatedPayoutMinor: null,
    settlementMetricsComplete: false,
    missingSourceCount: row.missingSourceCount,
    state: row.state
  };
}

export function neutralizeCsvText(value: string): string {
  if (value.length === 0) return value;
  if (value[0] === '\t' || value[0] === '\r' || value[0] === '\n') return `'${value}`;
  let index = 0;
  while (value[index] === ' ') index += 1;
  return FORMULA_PREFIXES.has(value[index] ?? '') ? `'${value}` : value;
}

function textCell(value: unknown): string {
  if (typeof value !== 'string') return invalidCsv();
  const neutralized = neutralizeCsvText(value);
  if (!/[",\r\n]/u.test(neutralized)) return neutralized;
  return `"${neutralized.replaceAll('"', '""')}"`;
}

function integerCell(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return invalidCsv();
  return String(value);
}

function nullableIntegerCell(value: unknown): string {
  return value === null ? '' : integerCell(value);
}

function booleanCell(value: unknown): string {
  if (typeof value !== 'boolean') return invalidCsv();
  return value ? 'true' : 'false';
}

function nullableTextCell(value: unknown): string {
  return value === null ? '' : textCell(value);
}

function rowCells(row: SalesCsvRowDto): readonly string[] {
  return [
    textCell(row.currentTitle),
    textCell(row.titleId),
    textCell(row.format),
    booleanCell(row.archived),
    textCell(row.presentmentCurrency),
    textCell(row.settlementCurrency),
    integerCell(row.soldCopies),
    integerCell(row.fullyRefundedCopies),
    integerCell(row.netCopies),
    integerCell(row.grossPresentmentMinor),
    integerCell(row.finalizedRefundPresentmentMinor),
    integerCell(row.disputeWithdrawalPresentmentMinor),
    integerCell(row.disputeReinstatementPresentmentMinor),
    nullableIntegerCell(row.grossSettlementMinor),
    nullableIntegerCell(row.refundImpactMinor),
    nullableIntegerCell(row.disputeImpactMinor),
    nullableIntegerCell(row.processingFeeImpactMinor),
    nullableIntegerCell(row.refundFeeImpactMinor),
    nullableIntegerCell(row.disputeFeeImpactMinor),
    nullableIntegerCell(row.otherFeeImpactMinor),
    nullableIntegerCell(row.estimatedPayoutMinor),
    booleanCell(row.settlementMetricsComplete),
    integerCell(row.missingSourceCount),
    textCell(row.state),
    textCell(row.range),
    nullableTextCell(row.dataThroughAt),
    textCell(row.soldAsVariantsJson)
  ];
}

export function serializeSalesCsv(rows: readonly SalesCsvRowDto[]): Uint8Array<ArrayBuffer> {
  if (!Array.isArray(rows) || rows.length > SALES_CSV_MAX_ROWS) return invalidCsv();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let byteLength = 0;
  const append = (line: string): void => {
    const bytes = encoder.encode(`${line}\r\n`);
    if (byteLength + bytes.byteLength > SALES_CSV_MAX_BYTES) return invalidCsv();
    chunks.push(bytes);
    byteLength += bytes.byteLength;
  };

  append(SALES_CSV_ROW_DTO_KEYS.map(textCell).join(','));
  for (const row of rows) append(rowCells(row).join(','));

  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function exportSalesCsv(
  database: Database,
  actor: Actor,
  filters: SalesOverviewFilters,
  context: FinancialRequestContext,
  dependencies: SalesCsvDependencies = {}
): Promise<SalesCsvExport> {
  requireCapability(actor, 'sales.read', dependencies.capabilityResolver);
  requireCapability(actor, 'sales.export', dependencies.capabilityResolver);

  const normalizedFilters = normalizeExportFilters(filters);
  const filterFingerprint = fingerprintSalesFilters(normalizedFilters);
  const filename = csvFilename(normalizedFilters);
  const clock = dependencies.monotonicNow ?? (() => performance.now());
  const startedAt = readClock(clock);
  const deadline = startedAt + SALES_CSV_DEADLINE_MS;
  if (!Number.isFinite(deadline)) return invalidCsv();

  return database.transaction(async (transaction: DatabaseTransaction) => {
    await setRemainingStatementTimeout(transaction, clock, deadline);
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtext('pale-orbit:user-roles:admin'))`
    );
    assertBeforeDeadline(clock, deadline);

    await setRemainingStatementTimeout(transaction, clock, deadline);
    await transaction.execute(sql`
      select ${userRoles.role}
      from ${userRoles}
      where ${userRoles.userId} = ${actor.id}
        and ${userRoles.role} = ${'admin'}
      for key share
    `);
    assertBeforeDeadline(clock, deadline);

    await setRemainingStatementTimeout(transaction, clock, deadline);
    const refreshedActor: AdministratorActor = {
      type: 'user',
      id: actor.id,
      roles: await listRolesForUser(transaction, actor.id)
    };
    assertBeforeDeadline(clock, deadline);
    requireCapability(refreshedActor, 'sales.read', dependencies.capabilityResolver);
    requireCapability(refreshedActor, 'sales.export', dependencies.capabilityResolver);

    await setRemainingStatementTimeout(transaction, clock, deadline);
    const aggregateRows = await loadSalesAggregateRows(transaction, normalizedFilters, {
      applyCursor: false,
      limit: SALES_CSV_MAX_ROWS + 1
    });
    assertBeforeDeadline(clock, deadline);
    if (aggregateRows.length > SALES_CSV_MAX_ROWS) return invalidCsv();

    await setRemainingStatementTimeout(transaction, clock, deadline);
    const dataThroughAt = await loadSalesDataThroughAt(transaction);
    assertBeforeDeadline(clock, deadline);

    assertBeforeDeadline(clock, deadline);
    const csvRows = aggregateRows.map((row) =>
      toCsvRow(row, normalizedFilters.range, dataThroughAt)
    );
    assertBeforeDeadline(clock, deadline);

    assertBeforeDeadline(clock, deadline);
    const bytes = serializeSalesCsv(csvRows);
    assertBeforeDeadline(clock, deadline);

    const currencyPairCount = new Set(aggregateRows.map((row) =>
      JSON.stringify([row.presentmentCurrency, row.settlementCurrency ?? ''])
    )).size;
    await setRemainingStatementTimeout(transaction, clock, deadline);
    await auditFinancialExportCompleted(transaction, {
      actor: refreshedActor,
      filterFingerprint,
      rowCount: csvRows.length,
      byteCount: bytes.byteLength,
      currencyPairCount,
      context
    });
    assertBeforeDeadline(clock, deadline);

    return { bytes, filename, rowCount: csvRows.length };
  }, { isolationLevel: 'repeatable read' });
}
