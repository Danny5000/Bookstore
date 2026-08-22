import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { appendAuditEvent } from '$lib/server/audit/service';
import type { FinancialAdminPrivateCommand } from '$lib/server/commerce/financial/admin-commands/contracts';
import {
  FinancialAdminConflictError,
  FinancialAdminPermanentError,
  type FinancialAdminCommandExecutorContext
} from '$lib/server/commerce/financial/admin-commands/handler';
import { lockOrder } from '$lib/server/commerce/lock';
import {
  lockPaymentPurchaseFacts,
  type PaymentPurchaseFacts
} from '$lib/server/commerce/reconciliation';
import type {
  RefundAllocationDraftItemRow,
  RefundAllocationDraftRow,
  RefundRow
} from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import type { FinancialAdminCommandSafeResultByCode } from '$lib/types/financial-reporting';

const MAX_COMMAND_ITEMS = 25;
const SAFE_MONEY_MAX = 99_999_999;
const postgresTimestampPattern =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.][0-9]{1,6})?(?:Z|[+-][0-9]{2}(?::?[0-9]{2})?)$/u;

function timestampDate(value: Date | string): Date {
  if (value instanceof Date) return value;
  let normalized = value.replace(' ', 'T');
  normalized = normalized.replace(/([+-][0-9]{2})$/u, '$1:00');
  normalized = normalized.replace(/([+-][0-9]{2})([0-9]{2})$/u, '$1:$2');
  return new Date(normalized);
}

const databaseTimestampSchema = z.union([
  z.date(),
  z.string().regex(postgresTimestampPattern)
]).refine((value) => Number.isFinite(timestampDate(value).getTime()))
  .transform((value) => timestampDate(value));
const canonicalUuidSchema = z.uuid().refine((value) => value === value.toLowerCase());
const discoverySchema = z.strictObject({
  paymentId: canonicalUuidSchema,
  orderId: canonicalUuidSchema
});
const lockedOrderSchema = z.strictObject({
  id: canonicalUuidSchema,
  status: z.enum([
    'checkout_pending', 'checkout_open', 'payment_pending', 'paid', 'expired',
    'failed', 'exception'
  ]),
  currency: z.string().regex(/^[A-Z]{3}$/u),
  totalMinor: z.number().int().min(0).max(SAFE_MONEY_MAX).nullable(),
  paidAt: databaseTimestampSchema.nullable()
});
const lockedPaymentSchema = z.strictObject({
  id: canonicalUuidSchema,
  orderId: canonicalUuidSchema,
  status: z.enum(['pending', 'succeeded', 'failed']),
  amountMinor: z.number().int().min(0).max(SAFE_MONEY_MAX),
  currency: z.string().regex(/^[A-Z]{3}$/u),
  paidAt: databaseTimestampSchema.nullable()
});
const draftWriteSchema = z.strictObject({
  id: canonicalUuidSchema,
  version: z.number().int().min(1).max(2_147_483_647)
});
const exactIdSchema = z.strictObject({ id: canonicalUuidSchema });

type QueryResult = { readonly rows?: readonly unknown[] };

interface PreparedRefundDraftFacts {
  readonly refund: RefundRow;
  readonly facts: PaymentPurchaseFacts;
  readonly activeDraft: RefundAllocationDraftRow | null;
  readonly activeDraftItems: readonly RefundAllocationDraftItemRow[];
  readonly capacityByItemId: ReadonlyMap<string, number>;
}

interface SnapshotItem {
  readonly orderItemId: string;
  readonly totalPresentmentMinor: number;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Refund draft command execution was aborted.', 'AbortError');
  }
}

function permanentFailure(): never {
  throw new FinancialAdminPermanentError('command_failed');
}

function staleState(): never {
  throw new FinancialAdminConflictError('stale_state');
}

function notEligible(): never {
  throw new FinancialAdminConflictError('not_eligible');
}

function rows(value: unknown): readonly unknown[] {
  if (!value || typeof value !== 'object') return permanentFailure();
  const resultRows = (value as QueryResult).rows;
  if (!Array.isArray(resultRows)) return permanentFailure();
  return resultRows;
}

async function executeRows(
  transaction: DatabaseTransaction,
  statement: SQL
): Promise<readonly unknown[]> {
  return rows(await transaction.execute(statement));
}

function parseOne<T>(schema: z.ZodType<T>, values: readonly unknown[]): T {
  if (values.length !== 1) return permanentFailure();
  const parsed = schema.safeParse(values[0]);
  if (!parsed.success) return permanentFailure();
  return parsed.data;
}

function safeTotal(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0 || value > SAFE_MONEY_MAX) {
      return permanentFailure();
    }
    total += value;
    if (!Number.isSafeInteger(total) || total > SAFE_MONEY_MAX) return permanentFailure();
  }
  return total;
}

function exactActiveSnapshot(
  facts: PaymentPurchaseFacts,
  draft: RefundAllocationDraftRow,
  draftItems: readonly RefundAllocationDraftItemRow[]
): Map<string, number> {
  if (draftItems.length !== facts.orderItems.length) return staleState();
  const currentIds = new Set(facts.orderItems.map((item) => item.id));
  const snapshot = new Map<string, number>();
  for (const item of draftItems) {
    if (
      item.draftId !== draft.id ||
      !currentIds.has(item.orderItemId) ||
      snapshot.has(item.orderItemId) ||
      !Number.isSafeInteger(item.proposedTotalPresentmentMinor) ||
      item.proposedTotalPresentmentMinor < 0 ||
      item.proposedTotalPresentmentMinor > SAFE_MONEY_MAX
    ) {
      return staleState();
    }
    snapshot.set(item.orderItemId, item.proposedTotalPresentmentMinor);
  }
  return snapshot;
}

function validateLockedFacts(
  facts: PaymentPurchaseFacts,
  discovery: z.infer<typeof discoverySchema>
): Pick<PreparedRefundDraftFacts, 'facts' | 'capacityByItemId'> {
  if (
    facts.order.id !== discovery.orderId ||
    facts.payment.id !== discovery.paymentId ||
    facts.payment.orderId !== discovery.orderId ||
    facts.order.status !== 'paid' ||
    facts.payment.status !== 'succeeded' ||
    facts.order.totalMinor === null ||
    facts.payment.amountMinor !== facts.order.totalMinor ||
    facts.payment.currency !== facts.order.currency ||
    facts.orderItems.length < 1 ||
    facts.orderItems.length > MAX_COMMAND_ITEMS
  ) {
    return permanentFailure();
  }
  const itemIds = new Set<string>();
  let paidTotal = 0;
  const capacityByItemId = new Map<string, number>();
  for (const item of facts.orderItems) {
    if (
      itemIds.has(item.id) ||
      item.orderId !== discovery.orderId ||
      item.currency !== facts.order.currency ||
      item.taxMinor === null ||
      item.totalMinor === null ||
      item.totalMinor !== item.unitSubtotalMinor + item.taxMinor
    ) {
      return permanentFailure();
    }
    itemIds.add(item.id);
    paidTotal += item.totalMinor;
    if (!Number.isSafeInteger(paidTotal) || paidTotal > SAFE_MONEY_MAX) {
      return permanentFailure();
    }
    capacityByItemId.set(item.id, item.totalMinor);
  }
  if (paidTotal !== facts.payment.amountMinor) return permanentFailure();

  const refundById = new Map<string, RefundRow>();
  for (const refund of facts.refunds) {
    if (refundById.has(refund.id) || refund.paymentId !== discovery.paymentId) {
      return permanentFailure();
    }
    refundById.set(refund.id, refund);
  }
  const componentByAllocationId = new Map(
    facts.refundComponents.map((component) => [component.refundAllocationId, component])
  );
  if (componentByAllocationId.size !== facts.refundComponents.length) return permanentFailure();
  for (const allocation of facts.refundAllocations) {
    const refund = refundById.get(allocation.refundId);
    const component = componentByAllocationId.get(allocation.id);
    if (
      refund === undefined ||
      refund.status !== 'succeeded' ||
      !itemIds.has(allocation.orderItemId) ||
      component === undefined ||
      component.refundId !== allocation.refundId ||
      component.orderItemId !== allocation.orderItemId ||
      component.totalMinor !== allocation.amountMinor ||
      component.totalMinor !== component.subtotalMinor + component.taxMinor ||
      component.currency !== facts.order.currency
    ) {
      return permanentFailure();
    }
    const remaining = capacityByItemId.get(allocation.orderItemId)! - allocation.amountMinor;
    if (remaining < 0) return permanentFailure();
    capacityByItemId.set(allocation.orderItemId, remaining);
  }
  if (facts.refundComponents.length !== facts.refundAllocations.length) {
    return permanentFailure();
  }

  return {
    facts,
    capacityByItemId
  };
}

async function prepareRefundDraftFacts(
  context: FinancialAdminCommandExecutorContext,
  refundId: string
): Promise<PreparedRefundDraftFacts> {
  throwIfAborted(context.signal);
  const discoveredRows = await executeRows(context.transaction, sql`
    select refund.payment_id as "paymentId", payment.order_id as "orderId"
    from refunds refund
    join payments payment on payment.id = refund.payment_id
    where refund.id = ${refundId}::uuid
  `);
  if (discoveredRows.length === 0) return notEligible();
  const discovery = parseOne(discoverySchema, discoveredRows);
  throwIfAborted(context.signal);
  await lockOrder(context.transaction, discovery.orderId);
  const lockedOrder = parseOne(lockedOrderSchema, await executeRows(context.transaction, sql`
    select id, status, currency, total_minor as "totalMinor", paid_at as "paidAt"
    from orders where id = ${discovery.orderId}::uuid for update
  `));
  const lockedPayment = parseOne(lockedPaymentSchema, await executeRows(context.transaction, sql`
    select id, order_id as "orderId", status, amount_minor as "amountMinor",
      currency, paid_at as "paidAt"
    from payments where id = ${discovery.paymentId}::uuid for update
  `));
  if (
    lockedOrder.id !== discovery.orderId ||
    lockedPayment.id !== discovery.paymentId ||
    lockedPayment.orderId !== discovery.orderId
  ) {
    return permanentFailure();
  }
  throwIfAborted(context.signal);
  const facts = await lockPaymentPurchaseFacts(
    context.transaction,
    lockedPayment as never,
    lockedOrder
  );
  const validated = validateLockedFacts(facts, discovery);
  const matchingRefunds = facts.refunds.filter((refund) => refund.id === refundId);
  if (matchingRefunds.length !== 1) return permanentFailure();
  const refund = matchingRefunds[0]!;
  if (
    refund.status !== 'succeeded' ||
    refund.currency !== facts.order.currency ||
    refund.amountMinor < 1 ||
    refund.amountMinor > SAFE_MONEY_MAX ||
    !['needs_review', 'draft'].includes(refund.allocationStatus)
  ) {
    return notEligible();
  }
  if (facts.refundAllocations.some((allocation) => allocation.refundId === refundId)) {
    return notEligible();
  }
  const activeDrafts = facts.refundDrafts.filter((draft) =>
    draft.refundId === refundId && draft.state === 'active'
  );
  if (activeDrafts.length > 1) return permanentFailure();
  const activeDraft = activeDrafts[0] ?? null;
  const activeDraftItems = activeDraft === null
    ? []
    : facts.refundDraftItems.filter((item) => item.draftId === activeDraft.id);
  if (
    (activeDraft === null && refund.allocationStatus === 'draft') ||
    (activeDraft !== null && refund.allocationStatus !== 'draft')
  ) {
    return permanentFailure();
  }
  return {
    ...validated,
    refund,
    activeDraft,
    activeDraftItems
  };
}

function completeSnapshot(
  prepared: PreparedRefundDraftFacts,
  submitted: readonly SnapshotItem[]
): readonly SnapshotItem[] {
  const submittedByItemId = new Map<string, number>();
  for (const item of submitted) {
    if (
      submittedByItemId.has(item.orderItemId) ||
      !prepared.capacityByItemId.has(item.orderItemId) ||
      !Number.isSafeInteger(item.totalPresentmentMinor) ||
      item.totalPresentmentMinor < 0 ||
      item.totalPresentmentMinor > prepared.capacityByItemId.get(item.orderItemId)!
    ) {
      return staleState();
    }
    submittedByItemId.set(item.orderItemId, item.totalPresentmentMinor);
  }
  const snapshot = prepared.facts.orderItems
    .map((item) => ({
      orderItemId: item.id,
      totalPresentmentMinor: submittedByItemId.get(item.id) ?? 0
    }))
    .sort((left, right) => left.orderItemId.localeCompare(right.orderItemId));
  if (safeTotal(snapshot.map((item) => item.totalPresentmentMinor)) !== prepared.refund.amountMinor) {
    return staleState();
  }
  return snapshot;
}

async function updateRefundStatus(
  transaction: DatabaseTransaction,
  refundId: string,
  current: 'needs_review' | 'draft',
  next: 'needs_review' | 'draft'
): Promise<void> {
  const updated = await executeRows(transaction, sql`
    update refunds set allocation_status = ${next},
      updated_at = pg_catalog.statement_timestamp()
    where id = ${refundId}::uuid and allocation_status = ${current}
    returning id
  `);
  parseOne(exactIdSchema, updated);
}

async function insertSnapshotItems(
  transaction: DatabaseTransaction,
  draftId: string,
  snapshot: readonly SnapshotItem[]
): Promise<void> {
  const values = sql.join(snapshot.map((item) => sql`(
    ${draftId}::uuid, ${item.orderItemId}::uuid, ${item.totalPresentmentMinor}
  )`), sql`, `);
  await executeRows(transaction, sql`
    insert into refund_allocation_draft_items
      (draft_id, order_item_id, proposed_total_presentment_minor)
    values ${values}
  `);
}

async function upsertSnapshotItems(
  transaction: DatabaseTransaction,
  draftId: string,
  snapshot: readonly SnapshotItem[]
): Promise<void> {
  const values = sql.join(snapshot.map((item) => sql`(
    ${draftId}::uuid, ${item.orderItemId}::uuid, ${item.totalPresentmentMinor}
  )`), sql`, `);
  await executeRows(transaction, sql`
    insert into refund_allocation_draft_items
      (draft_id, order_item_id, proposed_total_presentment_minor)
    values ${values}
    on conflict (draft_id, order_item_id) do update
      set proposed_total_presentment_minor = excluded.proposed_total_presentment_minor,
        updated_at = pg_catalog.statement_timestamp()
  `);
}

function snapshotChanged(
  current: ReadonlyMap<string, number>,
  next: readonly SnapshotItem[]
): boolean {
  return next.some((item) => current.get(item.orderItemId) !== item.totalPresentmentMinor);
}

export async function executeRefundDraftSave(
  context: FinancialAdminCommandExecutorContext,
  command: Extract<FinancialAdminPrivateCommand, { kind: 'refund_draft_save' }>
): Promise<FinancialAdminCommandSafeResultByCode['draft_saved']> {
  const prepared = await prepareRefundDraftFacts(context, command.refundId);
  if (
    (prepared.activeDraft === null && command.expectedVersion !== null) ||
    (prepared.activeDraft !== null && command.expectedVersion !== prepared.activeDraft.version)
  ) {
    return staleState();
  }
  const snapshot = completeSnapshot(prepared, command.items);
  const proposedTotalMinor = safeTotal(snapshot.map((item) => item.totalPresentmentMinor));
  throwIfAborted(context.signal);

  if (prepared.activeDraft === null) {
    const draft = parseOne(draftWriteSchema, await executeRows(context.transaction, sql`
      insert into refund_allocation_drafts (
        refund_id, state, version, created_by_admin_id, updated_by_admin_id,
        created_correlation_id, updated_correlation_id
      ) values (
        ${command.refundId}::uuid, 'active', 1, ${context.actor.id}::uuid,
        ${context.actor.id}::uuid, ${context.correlationId}, ${context.correlationId}
      ) returning id, version
    `));
    await insertSnapshotItems(context.transaction, draft.id, snapshot);
    await updateRefundStatus(
      context.transaction, command.refundId, 'needs_review', 'draft'
    );
    throwIfAborted(context.signal);
    await appendAuditEvent(context.transaction, {
      actor: context.actor,
      action: 'financial.refund_draft.created',
      outcome: 'succeeded',
      resourceType: 'refund_allocation_draft',
      resourceId: draft.id,
      correlationId: context.correlationId,
      after: {
        refundId: command.refundId,
        draftVersion: draft.version,
        state: 'active',
        itemCount: snapshot.length,
        proposedTotalMinor
      }
    });
    return { refundId: command.refundId, draftVersion: draft.version, changed: true };
  }

  const activeDraft = prepared.activeDraft;
  const currentSnapshot = exactActiveSnapshot(
    prepared.facts, activeDraft, prepared.activeDraftItems
  );
  if (!snapshotChanged(currentSnapshot, snapshot)) {
    return { refundId: command.refundId, draftVersion: activeDraft.version, changed: false };
  }
  if (activeDraft.version >= 2_147_483_647) return staleState();
  await upsertSnapshotItems(context.transaction, activeDraft.id, snapshot);
  const nextDraft = parseOne(draftWriteSchema, await executeRows(context.transaction, sql`
    update refund_allocation_drafts set version = version + 1,
      updated_by_admin_id = ${context.actor.id}::uuid,
      updated_correlation_id = ${context.correlationId},
      updated_at = pg_catalog.statement_timestamp()
    where id = ${activeDraft.id}::uuid and state = 'active'
      and version = ${activeDraft.version}
    returning id, version
  `));
  if (nextDraft.version !== activeDraft.version + 1) return permanentFailure();
  throwIfAborted(context.signal);
  await appendAuditEvent(context.transaction, {
    actor: context.actor,
    action: 'financial.refund_draft.updated',
    outcome: 'succeeded',
    resourceType: 'refund_allocation_draft',
    resourceId: activeDraft.id,
    correlationId: context.correlationId,
    before: {
      refundId: command.refundId,
      draftVersion: activeDraft.version,
      state: 'active'
    },
    after: {
      refundId: command.refundId,
      draftVersion: nextDraft.version,
      state: 'active',
      itemCount: snapshot.length,
      proposedTotalMinor
    }
  });
  return { refundId: command.refundId, draftVersion: nextDraft.version, changed: true };
}

export async function executeRefundDraftDiscard(
  context: FinancialAdminCommandExecutorContext,
  command: Extract<FinancialAdminPrivateCommand, { kind: 'refund_draft_discard' }>
): Promise<FinancialAdminCommandSafeResultByCode['draft_discarded']> {
  const prepared = await prepareRefundDraftFacts(context, command.refundId);
  const activeDraft = prepared.activeDraft;
  if (
    activeDraft === null ||
    command.expectedActiveDraftVersion !== activeDraft.version
  ) {
    return staleState();
  }
  exactActiveSnapshot(prepared.facts, activeDraft, prepared.activeDraftItems);
  if (activeDraft.version >= 2_147_483_647) return staleState();
  throwIfAborted(context.signal);
  const nextDraft = parseOne(draftWriteSchema, await executeRows(context.transaction, sql`
    update refund_allocation_drafts set state = 'discarded', version = version + 1,
      updated_by_admin_id = ${context.actor.id}::uuid,
      updated_correlation_id = ${context.correlationId},
      updated_at = pg_catalog.statement_timestamp(),
      discarded_at = pg_catalog.statement_timestamp()
    where id = ${activeDraft.id}::uuid and state = 'active'
      and version = ${activeDraft.version}
    returning id, version
  `));
  if (nextDraft.version !== activeDraft.version + 1) return permanentFailure();
  await updateRefundStatus(context.transaction, command.refundId, 'draft', 'needs_review');
  throwIfAborted(context.signal);
  await appendAuditEvent(context.transaction, {
    actor: context.actor,
    action: 'financial.refund_draft.discarded',
    outcome: 'succeeded',
    resourceType: 'refund_allocation_draft',
    resourceId: activeDraft.id,
    correlationId: context.correlationId,
    before: {
      refundId: command.refundId,
      draftVersion: activeDraft.version,
      state: 'active'
    },
    after: {
      refundId: command.refundId,
      draftVersion: nextDraft.version,
      state: 'discarded'
    }
  });
  return { refundId: command.refundId, draftVersion: nextDraft.version, changed: true };
}
