import {
  parseFinancialAdminPrivateCommand,
  type FinancialAdminPrivateCommand
} from '$lib/server/commerce/financial/admin-commands/contracts';
import { decodeFinancialIssueCursor } from '$lib/server/commerce/reporting/review';
import { readBoundedBody } from '$lib/server/http/strict-json';

const MAX_FORM_BYTES = 16 * 1024;
const MAX_REVIEW_CURSOR_LENGTH = 1_024;
const MAX_COMMAND_ITEMS = 25;
const SAFE_MONEY_MAX = 99_999_999;
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CANONICAL_INTEGER = /^(?:0|[1-9][0-9]*)$/u;
const URLENCODED_CONTENT_TYPE =
  /^application\/x-www-form-urlencoded(?:\s*;\s*charset\s*=\s*utf-8)?$/iu;

export interface RefundReviewReturnContext {
  readonly reviewCursor: string | null;
}

interface RefundReviewReturnContextDependencies {
  readonly validateCursor?: (value: string) => unknown;
}

export interface RefundDraftSaveSubmission {
  readonly idempotencyKey: string;
  readonly command: Extract<FinancialAdminPrivateCommand, { kind: 'refund_draft_save' }>;
}

export interface RefundDraftDiscardSubmission {
  readonly idempotencyKey: string;
  readonly command: Extract<FinancialAdminPrivateCommand, { kind: 'refund_draft_discard' }>;
}

export interface RefundFinalizationPrepareInput {
  readonly refundId: string;
  readonly expectedActiveDraftVersion: number;
}

export interface RefundFinalizationSubmission {
  readonly idempotencyKey: string;
  readonly command: Extract<
    FinancialAdminPrivateCommand,
    { kind: 'refund_allocation_finalize' }
  >;
}

export type ReportingCorrectionPrepareInput = Omit<
  Extract<FinancialAdminPrivateCommand, {
    kind: 'refund_reporting_correction_create';
  }>,
  'kind' | 'previewFingerprint' | 'confirmation'
>;

export interface RefundReportingCorrectionSubmission {
  readonly idempotencyKey: string;
  readonly command: Extract<
    FinancialAdminPrivateCommand,
    { kind: 'refund_reporting_correction_create' }
  >;
}

export class RefundReviewInputError extends Error {
  readonly fieldKey: string | null;

  constructor(fieldKey: string | null = null) {
    super('The refund review input is invalid.');
    this.name = 'RefundReviewInputError';
    this.fieldKey = fieldKey !== null && CANONICAL_UUID.test(fieldKey)
      ? fieldKey
      : null;
  }
}

function invalidInput(fieldKey: string | null = null): never {
  throw new RefundReviewInputError(fieldKey);
}

function canonicalUuid(value: string | undefined): string {
  if (value === undefined || !CANONICAL_UUID.test(value)) return invalidInput();
  return value;
}

function canonicalSha256(value: string | undefined): string {
  if (value === undefined || !SHA256.test(value)) return invalidInput();
  return value;
}

function canonicalInteger(
  value: string | undefined,
  minimum: number,
  maximum: number,
  fieldKey: string | null = null
): number {
  if (value === undefined || !CANONICAL_INTEGER.test(value)) {
    return invalidInput(fieldKey);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return invalidInput(fieldKey);
  }
  return parsed;
}

function exactlyOne(input: URLSearchParams, key: string): string {
  const values = input.getAll(key);
  if (values.length !== 1) return invalidInput();
  return values[0]!;
}

function exactKeys(input: URLSearchParams, allowed: ReadonlySet<string>): void {
  for (const key of new Set(input.keys())) {
    if (!allowed.has(key)) return invalidInput();
  }
}

async function readForm(request: Request): Promise<URLSearchParams> {
  try {
    const contentType = request.headers.get('content-type')?.trim() ?? '';
    if (!URLENCODED_CONTENT_TYPE.test(contentType)) return invalidInput();
    const bytes = await readBoundedBody(request, { maxBytes: MAX_FORM_BYTES });
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return new URLSearchParams(text);
  } catch (error) {
    if (error instanceof RefundReviewInputError) throw error;
    return invalidInput();
  }
}

function privateCommand<T extends FinancialAdminPrivateCommand>(value: T): T {
  try {
    return parseFinancialAdminPrivateCommand(value) as T;
  } catch {
    return invalidInput();
  }
}

export function parseRefundReviewReturnContext(
  url: URL,
  dependencies: RefundReviewReturnContextDependencies = {}
): RefundReviewReturnContext {
  const keys = [...new Set(url.searchParams.keys())];
  if (keys.some((key) => key !== 'reviewCursor')) return invalidInput();
  const values = url.searchParams.getAll('reviewCursor');
  if (values.length === 0) return { reviewCursor: null };
  if (values.length !== 1) return invalidInput();
  const cursor = values[0]!;
  if (
    cursor.length < 1 ||
    cursor.length > MAX_REVIEW_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(cursor)
  ) {
    return invalidInput();
  }
  try {
    (dependencies.validateCursor ?? decodeFinancialIssueCursor)(cursor);
  } catch {
    return invalidInput();
  }
  return { reviewCursor: cursor };
}

export async function parseRefundDraftSaveRequest(
  request: Request,
  refundId: string
): Promise<RefundDraftSaveSubmission> {
  const input = await readForm(request);
  exactKeys(input, new Set([
    'idempotencyKey', 'expectedVersion', 'orderItemId', 'totalPresentmentMinor'
  ]));
  const idempotencyKey = canonicalUuid(exactlyOne(input, 'idempotencyKey'));
  const parsedRefundId = canonicalUuid(refundId);
  const expectedVersionInput = exactlyOne(input, 'expectedVersion');
  const expectedVersion = expectedVersionInput === ''
    ? null
    : canonicalInteger(expectedVersionInput, 1, POSTGRES_INTEGER_MAX);
  const itemIds = input.getAll('orderItemId');
  const amounts = input.getAll('totalPresentmentMinor');
  if (
    itemIds.length < 1 ||
    itemIds.length > MAX_COMMAND_ITEMS ||
    itemIds.length !== amounts.length
  ) {
    return invalidInput();
  }
  const seen = new Set<string>();
  const items = itemIds.map((value, index) => {
    const orderItemId = canonicalUuid(value);
    if (seen.has(orderItemId)) return invalidInput();
    seen.add(orderItemId);
    return {
      orderItemId,
      totalPresentmentMinor: canonicalInteger(
        amounts[index],
        0,
        SAFE_MONEY_MAX,
        orderItemId
      )
    };
  }).sort((left, right) => left.orderItemId.localeCompare(right.orderItemId));

  return {
    idempotencyKey,
    command: privateCommand({
      kind: 'refund_draft_save',
      refundId: parsedRefundId,
      expectedVersion,
      items
    })
  };
}

export async function parseRefundDraftDiscardRequest(
  request: Request,
  refundId: string
): Promise<RefundDraftDiscardSubmission> {
  const input = await readForm(request);
  exactKeys(input, new Set(['idempotencyKey', 'expectedActiveDraftVersion']));
  const idempotencyKey = canonicalUuid(exactlyOne(input, 'idempotencyKey'));
  const parsedRefundId = canonicalUuid(refundId);
  const expectedActiveDraftVersion = canonicalInteger(
    exactlyOne(input, 'expectedActiveDraftVersion'),
    1,
    POSTGRES_INTEGER_MAX
  );
  return {
    idempotencyKey,
    command: privateCommand({
      kind: 'refund_draft_discard',
      refundId: parsedRefundId,
      expectedActiveDraftVersion
    })
  };
}

export async function parseRefundFinalizationPrepareRequest(
  request: Request,
  refundId: string
): Promise<RefundFinalizationPrepareInput> {
  const input = await readForm(request);
  exactKeys(input, new Set(['expectedActiveDraftVersion']));
  return {
    refundId: canonicalUuid(refundId),
    expectedActiveDraftVersion: canonicalInteger(
      exactlyOne(input, 'expectedActiveDraftVersion'),
      1,
      POSTGRES_INTEGER_MAX
    )
  };
}

export async function parseRefundFinalizationConfirmRequest(
  request: Request,
  refundId: string
): Promise<RefundFinalizationSubmission> {
  const input = await readForm(request);
  exactKeys(input, new Set([
    'idempotencyKey',
    'expectedActiveDraftVersion',
    'previewFingerprint',
    'confirmation'
  ]));
  const idempotencyKey = canonicalUuid(exactlyOne(input, 'idempotencyKey'));
  const confirmation = exactlyOne(input, 'confirmation');
  if (confirmation !== 'finalize_refund_allocation') return invalidInput();
  return {
    idempotencyKey,
    command: privateCommand({
      kind: 'refund_allocation_finalize',
      refundId: canonicalUuid(refundId),
      expectedActiveDraftVersion: canonicalInteger(
        exactlyOne(input, 'expectedActiveDraftVersion'),
        1,
        POSTGRES_INTEGER_MAX
      ),
      previewFingerprint: exactlyOne(input, 'previewFingerprint'),
      confirmation
    })
  };
}

const REPORTING_CORRECTION_PREPARE_KEYS = new Set([
  'reason',
  'expectedNextCorrectionVersion',
  'expectedBaseAllocationSetId',
  'expectedSourceFingerprint',
  'orderItemId',
  'totalPresentmentMinor'
]);

function parseReportingCorrectionInput(
  input: URLSearchParams,
  refundId: string
): ReportingCorrectionPrepareInput {
  const reason = exactlyOne(input, 'reason');
  if (reason !== 'allocation_attribution_correction') return invalidInput();
  const itemIds = input.getAll('orderItemId');
  const amounts = input.getAll('totalPresentmentMinor');
  if (
    itemIds.length < 1 ||
    itemIds.length > MAX_COMMAND_ITEMS ||
    itemIds.length !== amounts.length
  ) return invalidInput();

  const seen = new Set<string>();
  const items = itemIds.map((value, index) => {
    const orderItemId = canonicalUuid(value);
    if (seen.has(orderItemId)) return invalidInput();
    seen.add(orderItemId);
    return {
      orderItemId,
      totalPresentmentMinor: canonicalInteger(
        amounts[index],
        0,
        SAFE_MONEY_MAX,
        orderItemId
      )
    };
  }).sort((left, right) => left.orderItemId.localeCompare(right.orderItemId));

  return {
    refundId: canonicalUuid(refundId),
    reason,
    expectedNextCorrectionVersion: canonicalInteger(
      exactlyOne(input, 'expectedNextCorrectionVersion'),
      1,
      POSTGRES_INTEGER_MAX
    ),
    expectedBaseAllocationSetId: canonicalUuid(
      exactlyOne(input, 'expectedBaseAllocationSetId')
    ),
    expectedSourceFingerprint: canonicalSha256(
      exactlyOne(input, 'expectedSourceFingerprint')
    ),
    items
  };
}

export async function parseRefundReportingCorrectionPrepareRequest(
  request: Request,
  refundId: string
): Promise<ReportingCorrectionPrepareInput> {
  const input = await readForm(request);
  exactKeys(input, REPORTING_CORRECTION_PREPARE_KEYS);
  return parseReportingCorrectionInput(input, refundId);
}

export async function parseRefundReportingCorrectionConfirmRequest(
  request: Request,
  refundId: string
): Promise<RefundReportingCorrectionSubmission> {
  const input = await readForm(request);
  exactKeys(input, new Set([
    ...REPORTING_CORRECTION_PREPARE_KEYS,
    'idempotencyKey',
    'previewFingerprint',
    'confirmation'
  ]));
  const prepare = parseReportingCorrectionInput(input, refundId);
  const confirmation = exactlyOne(input, 'confirmation');
  if (confirmation !== 'create_reporting_correction') return invalidInput();
  const idempotencyKey = canonicalUuid(exactlyOne(input, 'idempotencyKey'));
  return {
    idempotencyKey,
    command: privateCommand({
      kind: 'refund_reporting_correction_create',
      ...prepare,
      previewFingerprint: canonicalSha256(exactlyOne(input, 'previewFingerprint')),
      confirmation
    })
  };
}
