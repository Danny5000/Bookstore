import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isSupportedCommerceCurrency } from '$lib/commerce/money';
import type {
  PublicFinancialState,
  SalesRange,
  SalesSort,
  TitleFormat
} from '$lib/types/financial-reporting';

export const SALES_PAGE_SIZE = 50 as const;
export const SALES_CURSOR_MAX_ENCODED_LENGTH = 2_674 as const;
export const SALES_CURSOR_MAX_DECODED_BYTES = 2_005 as const;
export const SALES_CURSOR_ORDER = [
  'primary',
  'titleId',
  'presentmentCurrency',
  'settlementCurrency'
] as const;

export class SalesReportingInputError extends Error {
  readonly code = 'invalid_request' as const;
  readonly status = 400 as const;

  constructor(_unsafeDetail?: unknown) {
    super('The sales reporting request is invalid.');
    this.name = 'SalesReportingInputError';
  }
}

export interface SalesCursor {
  readonly filterFingerprint: string;
  readonly primary: number | string;
  readonly titleId: string;
  readonly presentmentCurrency: string;
  readonly settlementCurrency: string;
}

export interface SalesOverviewFilters {
  readonly range: SalesRange;
  readonly from?: Date;
  readonly to?: Date;
  readonly titleId?: string;
  readonly format?: TitleFormat;
  readonly presentmentCurrency?: string;
  readonly settlementCurrency?: string | 'pending';
  readonly state?: PublicFinancialState;
  readonly sort: SalesSort;
  readonly pageSize: typeof SALES_PAGE_SIZE;
  readonly cursor?: SalesCursor;
}

const allowedParameters = new Set([
  'range',
  'from',
  'to',
  'titleId',
  'format',
  'presentmentCurrency',
  'settlementCurrency',
  'state',
  'sort',
  'cursor'
]);
const blankNativeFormParameters = new Set([
  'from',
  'to',
  'titleId',
  'format',
  'presentmentCurrency',
  'settlementCurrency',
  'state'
]);
const canonicalCurrencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/u)
  .refine(isSupportedCommerceCurrency);
const canonicalUuidSchema = z.uuid().refine((value) => value === value.toLowerCase());
const rawFiltersSchema = z.strictObject({
  range: z.enum(['7', '30', '90', 'all', 'custom']).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  titleId: canonicalUuidSchema.optional(),
  format: z.enum(['prose', 'comic']).optional(),
  presentmentCurrency: canonicalCurrencySchema.optional(),
  settlementCurrency: z.union([canonicalCurrencySchema, z.literal('pending')]).optional(),
  state: z.enum(['pending', 'fee_reconciled', 'payout_reconciled', 'exception']).optional(),
  sort: z.enum(['gross_desc', 'title_asc']).optional(),
  cursor: z.string().min(1).max(SALES_CURSOR_MAX_ENCODED_LENGTH).optional()
});
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const canonicalTitlePrimarySchema = z
  .string()
  .min(1)
  .max(300);
const cursorPrimarySchema = z.union([
  z.number().int().safe(),
  canonicalTitlePrimarySchema
]);
const cursorSchema = z.strictObject({
  filterFingerprint: fingerprintSchema,
  primary: cursorPrimarySchema,
  titleId: canonicalUuidSchema,
  presentmentCurrency: canonicalCurrencySchema,
  settlementCurrency: z.union([z.literal(''), canonicalCurrencySchema])
});

function invalidInput(): never {
  throw new SalesReportingInputError();
}

function utcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

function addUtcDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function parseUtcCalendarDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return invalidInput();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0);
  parsed.setUTCFullYear(year, month - 1, day);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return invalidInput();
  }
  return parsed;
}

function rawQuery(url: URL): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    if (!allowedParameters.has(key) || values.length !== 1) invalidInput();
    const value = values[0]!;
    if (value === '') {
      if (blankNativeFormParameters.has(key)) continue;
      invalidInput();
    }
    raw[key] = value;
  }
  return raw;
}

export function fingerprintSalesFilters(filters: SalesOverviewFilters): string {
  const normalized = {
    version: 1,
    range: filters.range,
    from: filters.from?.toISOString() ?? null,
    to: filters.to?.toISOString() ?? null,
    titleId: filters.titleId ?? null,
    format: filters.format ?? null,
    presentmentCurrency: filters.presentmentCurrency ?? null,
    settlementCurrency: filters.settlementCurrency ?? null,
    state: filters.state ?? null,
    sort: filters.sort,
    pageSize: filters.pageSize
  };
  return createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex');
}

export function encodeSalesCursor(cursor: SalesCursor): string {
  const parsed = cursorSchema.safeParse(cursor);
  if (!parsed.success) return invalidInput();
  const bytes = Buffer.from(JSON.stringify(parsed.data), 'utf8');
  if (bytes.length > SALES_CURSOR_MAX_DECODED_BYTES) return invalidInput();
  const encoded = bytes.toString('base64url');
  if (encoded.length > SALES_CURSOR_MAX_ENCODED_LENGTH) return invalidInput();
  return encoded;
}

export function decodeSalesCursor(
  value: string,
  expectedFilterFingerprint: string
): SalesCursor {
  if (
    value.length < 1 ||
    value.length > SALES_CURSOR_MAX_ENCODED_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(value) ||
    !fingerprintSchema.safeParse(expectedFilterFingerprint).success
  ) {
    return invalidInput();
  }
  let decoded: unknown;
  try {
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.length > SALES_CURSOR_MAX_DECODED_BYTES) return invalidInput();
    if (bytes.toString('base64url') !== value) return invalidInput();
    decoded = JSON.parse(bytes.toString('utf8'));
  } catch {
    return invalidInput();
  }
  const parsed = cursorSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.filterFingerprint !== expectedFilterFingerprint) {
    return invalidInput();
  }
  const canonicalValue = Buffer.from(JSON.stringify(parsed.data), 'utf8').toString('base64url');
  if (canonicalValue !== value) return invalidInput();
  return parsed.data;
}

export function parseSalesOverviewFilters(url: URL, now: Date): SalesOverviewFilters {
  if (!Number.isFinite(now.getTime())) return invalidInput();
  const parsed = rawFiltersSchema.safeParse(rawQuery(url));
  if (!parsed.success) return invalidInput();

  const range = parsed.data.range ?? '30';
  const hasCustomDates = parsed.data.from !== undefined || parsed.data.to !== undefined;
  if (range === 'custom') {
    if (parsed.data.from === undefined || parsed.data.to === undefined) return invalidInput();
  } else if (hasCustomDates) {
    return invalidInput();
  }
  if (
    parsed.data.settlementCurrency === 'pending' &&
    (parsed.data.state === 'fee_reconciled' || parsed.data.state === 'payout_reconciled')
  ) {
    return invalidInput();
  }

  let from: Date | undefined;
  let to: Date | undefined;
  if (range === 'custom') {
    from = parseUtcCalendarDate(parsed.data.from!);
    const inclusiveTo = parseUtcCalendarDate(parsed.data.to!);
    if (from > inclusiveTo) return invalidInput();
    to = addUtcDays(inclusiveTo, 1);
  } else if (range !== 'all') {
    to = utcDay(now);
    from = addUtcDays(to, -Number(range));
  }

  const filters: SalesOverviewFilters = {
    range,
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(parsed.data.titleId === undefined ? {} : { titleId: parsed.data.titleId }),
    ...(parsed.data.format === undefined ? {} : { format: parsed.data.format }),
    ...(parsed.data.presentmentCurrency === undefined
      ? {}
      : { presentmentCurrency: parsed.data.presentmentCurrency }),
    ...(parsed.data.settlementCurrency === undefined
      ? {}
      : { settlementCurrency: parsed.data.settlementCurrency }),
    ...(parsed.data.state === undefined ? {} : { state: parsed.data.state }),
    sort: parsed.data.sort ?? 'gross_desc',
    pageSize: SALES_PAGE_SIZE
  };

  if (parsed.data.cursor === undefined) return filters;
  const cursor = decodeSalesCursor(parsed.data.cursor, fingerprintSalesFilters(filters));
  if (
    (filters.sort === 'gross_desc' && typeof cursor.primary !== 'number') ||
    (filters.sort === 'title_asc' && typeof cursor.primary !== 'string')
  ) {
    return invalidInput();
  }
  return {
    ...filters,
    cursor
  };
}
