import { types as nodeTypes } from 'node:util';
import { sql, type SQL } from 'drizzle-orm';
import type { AdministratorActor } from '$lib/server/auth/admin-policy';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import type { FinancialRequestContext } from './context';
import { SalesReportingInputError } from './filters';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

const ISSUE_ROUTE_ID = '/admin/sales/review/[issueId]';
const REFUND_ROUTE_ID = '/admin/sales/refunds/[refundId]';
const PAYOUT_ROUTE_ID = '/admin/sales/payouts/[payoutId]';
const EXPORT_ROUTE_ID = '/admin/sales/export.csv';

export interface FinancialIssueReadAuditInput {
  readonly actor: AdministratorActor;
  readonly issueId: string;
  readonly context: FinancialRequestContext;
}

export interface FinancialRefundReadAuditInput {
  readonly actor: AdministratorActor;
  readonly refundId: string;
  readonly context: FinancialRequestContext;
}

export interface FinancialPayoutReadAuditInput {
  readonly actor: AdministratorActor;
  readonly payoutId: string;
  readonly context: FinancialRequestContext;
}

export interface FinancialExportAuditInput {
  readonly actor: AdministratorActor;
  readonly filterFingerprint: string;
  readonly rowCount: number;
  readonly byteCount: number;
  readonly currencyPairCount: number;
  readonly context: FinancialRequestContext;
}

interface ParsedAuditEnvelope {
  readonly actorId: string;
  readonly correlationId: string;
  readonly method: 'GET';
}

class FinancialReportingAuditError extends Error {
  constructor() {
    super('The financial reporting audit could not be recorded.');
    this.name = 'FinancialReportingAuditError';
  }
}

function invalidInput(): never {
  throw new SalesReportingInputError();
}

function exactDataObject(
  value: unknown,
  keys: readonly string[]
): Readonly<Record<string, unknown>> | null {
  try {
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      nodeTypes.isProxy(value)
    ) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      !ownKeys.every((key) => typeof key === 'string' && keys.includes(key)) ||
      !keys.every((key) => Object.hasOwn(value, key))
    ) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const parsed: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        return null;
      }
      parsed[key] = descriptor.value;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isAdministratorRoles(value: unknown): boolean {
  try {
    if (
      !Array.isArray(value) ||
      nodeTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length < 1 ||
      value.length > 2
    ) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const expectedKeys = [
      ...Array.from({ length: value.length }, (_, index) => String(index)),
      'length'
    ];
    if (
      Reflect.ownKeys(value).length !== expectedKeys.length ||
      !Reflect.ownKeys(value).every(
        (key) => typeof key === 'string' && expectedKeys.includes(key)
      )
    ) {
      return false;
    }
    const roles: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        return false;
      }
      roles.push(descriptor.value);
    }
    return (
      roles.every((role) => role === 'admin' || role === 'customer') &&
      new Set(roles).size === roles.length &&
      roles.includes('admin')
    );
  } catch {
    return false;
  }
}

function parseActor(value: unknown): string {
  const actor = exactDataObject(value, ['type', 'id', 'roles']);
  if (
    actor === null ||
    actor.type !== 'user' ||
    typeof actor.id !== 'string' ||
    !UUID_PATTERN.test(actor.id) ||
    !isAdministratorRoles(actor.roles)
  ) {
    return invalidInput();
  }
  return actor.id;
}

function parseContext(value: unknown, expectedRouteId: string): {
  readonly correlationId: string;
  readonly method: 'GET';
} {
  const context =
    exactDataObject(value, ['correlationId']) ??
    exactDataObject(value, ['correlationId', 'requestMetadata']);
  if (
    context === null ||
    typeof context.correlationId !== 'string' ||
    !CORRELATION_ID_PATTERN.test(context.correlationId)
  ) {
    return invalidInput();
  }
  if (!Object.hasOwn(context, 'requestMetadata')) {
    return { correlationId: context.correlationId, method: 'GET' };
  }
  const metadata = exactDataObject(context.requestMetadata, ['method', 'routeId']);
  if (metadata === null || metadata.method !== 'GET' || metadata.routeId !== expectedRouteId) {
    return invalidInput();
  }
  return { correlationId: context.correlationId, method: metadata.method };
}

function parseEnvelope(
  input: unknown,
  keys: readonly string[],
  expectedRouteId: string
): { readonly input: Readonly<Record<string, unknown>> } & ParsedAuditEnvelope {
  const parsed = exactDataObject(input, keys);
  if (parsed === null) return invalidInput();
  const actorId = parseActor(parsed.actor);
  const context = parseContext(parsed.context, expectedRouteId);
  return { input: parsed, actorId, ...context };
}

function parseUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) return invalidInput();
  return value;
}

function parseCount(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > POSTGRES_INTEGER_MAX
  ) {
    return invalidInput();
  }
  return value;
}

async function executeAudit(tx: DatabaseTransaction, statement: SQL): Promise<void> {
  try {
    await tx.execute(statement);
  } catch {
    throw new FinancialReportingAuditError();
  }
}

export async function auditFinancialIssueDetailRead(
  tx: DatabaseTransaction,
  input: FinancialIssueReadAuditInput
): Promise<void> {
  const parsed = parseEnvelope(input, ['actor', 'issueId', 'context'], ISSUE_ROUTE_ID);
  const issueId = parseUuid(parsed.input.issueId);
  await executeAudit(
    tx,
    sql`select public.append_financial_issue_view_audit(${parsed.actorId}::uuid, ${issueId}::uuid, ${parsed.correlationId}::text, ${parsed.method}::text, ${`/admin/sales/issues/${issueId}`}::text)`
  );
}

export async function auditFinancialRefundDetailRead(
  tx: DatabaseTransaction,
  input: FinancialRefundReadAuditInput
): Promise<void> {
  const parsed = parseEnvelope(input, ['actor', 'refundId', 'context'], REFUND_ROUTE_ID);
  const refundId = parseUuid(parsed.input.refundId);
  await executeAudit(
    tx,
    sql`select public.append_financial_refund_review_view_audit(${parsed.actorId}::uuid, ${refundId}::uuid, ${parsed.correlationId}::text, ${parsed.method}::text, ${`/admin/sales/refunds/${refundId}`}::text)`
  );
}

export async function auditFinancialPayoutDetailRead(
  tx: DatabaseTransaction,
  input: FinancialPayoutReadAuditInput
): Promise<void> {
  const parsed = parseEnvelope(input, ['actor', 'payoutId', 'context'], PAYOUT_ROUTE_ID);
  const payoutId = parseUuid(parsed.input.payoutId);
  await executeAudit(
    tx,
    sql`select public.append_financial_payout_view_audit(${parsed.actorId}::uuid, ${payoutId}::uuid, ${parsed.correlationId}::text, ${parsed.method}::text, ${`/admin/sales/payouts/${payoutId}`}::text)`
  );
}

export async function auditFinancialExportCompleted(
  tx: DatabaseTransaction,
  input: FinancialExportAuditInput
): Promise<void> {
  const parsed = parseEnvelope(
    input,
    [
      'actor',
      'filterFingerprint',
      'rowCount',
      'byteCount',
      'currencyPairCount',
      'context'
    ],
    EXPORT_ROUTE_ID
  );
  if (
    typeof parsed.input.filterFingerprint !== 'string' ||
    !FINGERPRINT_PATTERN.test(parsed.input.filterFingerprint)
  ) {
    return invalidInput();
  }
  const rowCount = parseCount(parsed.input.rowCount);
  const byteCount = parseCount(parsed.input.byteCount);
  const currencyPairCount = parseCount(parsed.input.currencyPairCount);
  await executeAudit(
    tx,
    sql`select public.append_financial_sales_export_audit(${parsed.actorId}::uuid, ${parsed.input.filterFingerprint}::text, ${parsed.correlationId}::text, ${rowCount}::integer, ${byteCount}::integer, ${currencyPairCount}::integer, ${parsed.method}::text, ${EXPORT_ROUTE_ID}::text)`
  );
}
