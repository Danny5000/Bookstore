import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar
} from 'drizzle-orm/pg-core';
import { user } from './auth';
import { titleFormat, titles } from './catalog';
import { guestIdentities } from './identity';

export const commerceOrderStatusValues = [
  'checkout_pending',
  'checkout_open',
  'payment_pending',
  'paid',
  'expired',
  'failed',
  'exception'
] as const;
export const commercePaymentStatusValues = ['pending', 'succeeded', 'failed'] as const;
export const commerceRefundStatusValues = [
  'pending',
  'succeeded',
  'failed',
  'canceled'
] as const;
export const commerceDisputeStatusValues = ['open', 'won', 'lost'] as const;
export const entitlementGrantSourceValues = ['purchase', 'preserved', 'administrative'] as const;
export const entitlementGrantStatusValues = [
  'unclaimed',
  'active',
  'suspended',
  'revoked'
] as const;
export const refundAllocationSourceValues = ['automatic', 'administrative'] as const;
export const stripeEventStatusValues = ['pending', 'processed', 'exception'] as const;
export const financialEvidenceStatusValues = [
  'pending',
  'fee_reconciled',
  'exception'
] as const;
export const refundAllocationStatusValues = [
  'not_applicable',
  'needs_review',
  'draft',
  'finalized',
  'exception'
] as const;

export const orderStatus = pgEnum('commerce_order_status', commerceOrderStatusValues);
export const paymentStatus = pgEnum('commerce_payment_status', commercePaymentStatusValues);
export const refundStatus = pgEnum('commerce_refund_status', commerceRefundStatusValues);
export const disputeStatus = pgEnum('commerce_dispute_status', commerceDisputeStatusValues);
export const entitlementGrantSource = pgEnum(
  'entitlement_grant_source',
  entitlementGrantSourceValues
);
export const entitlementGrantStatus = pgEnum(
  'entitlement_grant_status',
  entitlementGrantStatusValues
);
export const refundAllocationSource = pgEnum(
  'refund_allocation_source',
  refundAllocationSourceValues
);
export const stripeEventStatus = pgEnum('stripe_event_status', stripeEventStatusValues);
export const financialEvidenceStatusEnum = pgEnum(
  'financial_evidence_status',
  financialEvidenceStatusValues
);
export const refundAllocationStatusEnum = pgEnum(
  'refund_allocation_status',
  refundAllocationStatusValues
);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    status: orderStatus('status').default('checkout_pending').notNull(),
    initiatingUserId: uuid('initiating_user_id').references(() => user.id, {
      onDelete: 'restrict'
    }),
    guestIdentityId: uuid('guest_identity_id').references(() => guestIdentities.id, {
      onDelete: 'restrict'
    }),
    purchaseEmail: varchar('purchase_email', { length: 320 }),
    currency: varchar('currency', { length: 3 }).notNull(),
    subtotalMinor: integer('subtotal_minor').notNull(),
    taxMinor: integer('tax_minor'),
    totalMinor: integer('total_minor'),
    clientCheckoutAttemptId: uuid('client_checkout_attempt_id').notNull(),
    quoteFingerprintSha256: varchar('quote_fingerprint_sha256', { length: 64 }).notNull(),
    stripeCheckoutSessionId: varchar('stripe_checkout_session_id', { length: 255 }),
    statusTokenSha256: varchar('status_token_sha256', { length: 64 }).notNull(),
    checkoutExpiresAt: timestamp('checkout_expires_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('orders_checkout_attempt_unique').on(table.clientCheckoutAttemptId),
    uniqueIndex('orders_stripe_checkout_session_unique')
      .on(table.stripeCheckoutSessionId)
      .where(sql`${table.stripeCheckoutSessionId} is not null`),
    index('orders_user_created_idx').on(table.initiatingUserId, table.createdAt),
    index('orders_guest_created_idx').on(table.guestIdentityId, table.createdAt),
    index('orders_status_updated_idx').on(table.status, table.updatedAt),
    check(
      'orders_money_nonnegative',
      sql`${table.subtotalMinor} >= 0 and (${table.taxMinor} is null or ${table.taxMinor} >= 0) and (${table.totalMinor} is null or ${table.totalMinor} >= 0)`
    ),
    check('orders_currency_iso', sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check(
      'orders_status_digest_sha256',
      sql`${table.statusTokenSha256} ~ '^[a-f0-9]{64}$'`
    ),
    check(
      'orders_quote_digest_sha256',
      sql`${table.quoteFingerprintSha256} ~ '^[a-f0-9]{64}$'`
    ),
    check(
      'orders_purchase_email_normalized',
      sql`${table.purchaseEmail} is null or (${table.purchaseEmail} = lower(btrim(${table.purchaseEmail})) and char_length(${table.purchaseEmail}) > 0)`
    ),
    check(
      'orders_single_owner',
      sql`${table.initiatingUserId} is null or ${table.guestIdentityId} is null`
    ),
    check(
      'orders_checkout_session_complete',
      sql`(${table.stripeCheckoutSessionId} is null) = (${table.checkoutExpiresAt} is null)`
    ),
    check(
      'orders_total_consistent',
      sql`(
        ${table.taxMinor} is null and ${table.totalMinor} is null
      ) or (
        ${table.taxMinor} is not null and ${table.totalMinor} = ${table.subtotalMinor} + ${table.taxMinor}
      )`
    ),
    check(
      'orders_paid_identity_consistent',
      sql`${table.status} <> 'paid' or (
        ${table.purchaseEmail} is not null and
        ${table.paidAt} is not null and
        ${table.taxMinor} is not null and
        ${table.totalMinor} is not null and
        ((${table.initiatingUserId} is not null)::integer + (${table.guestIdentityId} is not null)::integer) = 1
      )`
    )
  ]
);

export const orderItems = pgTable(
  'order_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    titleId: uuid('title_id')
      .notNull()
      .references(() => titles.id, { onDelete: 'restrict' }),
    titleSnapshot: text('title_snapshot').notNull(),
    creatorNameSnapshot: text('creator_name_snapshot').notNull(),
    format: titleFormat('format').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    unitSubtotalMinor: integer('unit_subtotal_minor').notNull(),
    taxMinor: integer('tax_minor'),
    totalMinor: integer('total_minor'),
    stripeLineItemId: varchar('stripe_line_item_id', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('order_items_order_title_unique').on(table.orderId, table.titleId),
    uniqueIndex('order_items_stripe_line_item_unique')
      .on(table.stripeLineItemId)
      .where(sql`${table.stripeLineItemId} is not null`),
    index('order_items_title_idx').on(table.titleId, table.createdAt),
    check(
      'order_items_money_nonnegative',
      sql`${table.unitSubtotalMinor} >= 0 and (${table.taxMinor} is null or ${table.taxMinor} >= 0) and (${table.totalMinor} is null or ${table.totalMinor} >= 0)`
    ),
    check('order_items_currency_iso', sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check(
      'order_items_total_consistent',
      sql`(
        ${table.taxMinor} is null and ${table.totalMinor} is null
      ) or (
        ${table.taxMinor} is not null and ${table.totalMinor} = ${table.unitSubtotalMinor} + ${table.taxMinor}
      )`
    )
  ]
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    stripePaymentIntentId: varchar('stripe_payment_intent_id', { length: 255 }).notNull(),
    stripeLatestChargeId: varchar('stripe_latest_charge_id', { length: 255 }),
    status: paymentStatus('status').default('pending').notNull(),
    amountMinor: integer('amount_minor').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    paymentMethodCategory: varchar('payment_method_category', { length: 50 }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    financialEvidenceStatus: financialEvidenceStatusEnum('financial_evidence_status')
      .default('pending')
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('payments_order_unique').on(table.orderId),
    uniqueIndex('payments_stripe_payment_intent_unique').on(table.stripePaymentIntentId),
    uniqueIndex('payments_stripe_latest_charge_unique')
      .on(table.stripeLatestChargeId)
      .where(sql`${table.stripeLatestChargeId} is not null`),
    index('payments_status_updated_idx').on(table.status, table.updatedAt),
    check('payments_amount_nonnegative', sql`${table.amountMinor} >= 0`),
    check('payments_currency_iso', sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check(
      'payments_method_category_safe',
      sql`${table.paymentMethodCategory} is null or ${table.paymentMethodCategory} ~ '^[a-z0-9_]{1,50}$'`
    ),
    check(
      'payments_paid_timestamp_consistent',
      sql`(${table.status} = 'succeeded') = (${table.paidAt} is not null)`
    )
  ]
);

export const refunds = pgTable(
  'refunds',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'restrict' }),
    stripeRefundId: varchar('stripe_refund_id', { length: 255 }).notNull(),
    status: refundStatus('status').default('pending').notNull(),
    amountMinor: integer('amount_minor').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    reason: varchar('reason', { length: 100 }),
    providerCreatedAt: timestamp('provider_created_at', { withTimezone: true }).notNull(),
    allocationStatus: refundAllocationStatusEnum('allocation_status')
      .default('not_applicable')
      .notNull(),
    financialEvidenceStatus: financialEvidenceStatusEnum('financial_evidence_status')
      .default('pending')
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('refunds_stripe_refund_unique').on(table.stripeRefundId),
    index('refunds_payment_created_idx').on(table.paymentId, table.providerCreatedAt),
    index('refunds_status_updated_idx').on(table.status, table.updatedAt),
    check('refunds_amount_nonnegative', sql`${table.amountMinor} >= 0`),
    check('refunds_currency_iso', sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check('refunds_reason_safe', sql`${table.reason} is null or char_length(${table.reason}) > 0`)
  ]
);

export const refundAllocations = pgTable(
  'refund_allocations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    refundId: uuid('refund_id')
      .notNull()
      .references(() => refunds.id, { onDelete: 'restrict' }),
    orderItemId: uuid('order_item_id')
      .notNull()
      .references(() => orderItems.id, { onDelete: 'restrict' }),
    amountMinor: integer('amount_minor').notNull(),
    source: refundAllocationSource('source').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('refund_allocations_refund_item_unique').on(table.refundId, table.orderItemId),
    unique('refund_allocations_provenance_unique').on(
      table.id,
      table.refundId,
      table.orderItemId
    ),
    index('refund_allocations_item_idx').on(table.orderItemId, table.createdAt),
    check('refund_allocations_amount_nonnegative', sql`${table.amountMinor} >= 0`)
  ]
);

export const disputes = pgTable(
  'disputes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'restrict' }),
    stripeDisputeId: varchar('stripe_dispute_id', { length: 255 }).notNull(),
    status: disputeStatus('status').default('open').notNull(),
    amountMinor: integer('amount_minor').notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    reason: varchar('reason', { length: 100 }),
    providerCreatedAt: timestamp('provider_created_at', { withTimezone: true }).notNull(),
    providerUpdatedAt: timestamp('provider_updated_at', { withTimezone: true }).notNull(),
    financialEvidenceStatus: financialEvidenceStatusEnum('financial_evidence_status')
      .default('pending')
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('disputes_stripe_dispute_unique').on(table.stripeDisputeId),
    index('disputes_payment_created_idx').on(table.paymentId, table.providerCreatedAt),
    index('disputes_status_updated_idx').on(table.status, table.updatedAt),
    check('disputes_amount_nonnegative', sql`${table.amountMinor} >= 0`),
    check('disputes_currency_iso', sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check('disputes_reason_safe', sql`${table.reason} is null or char_length(${table.reason}) > 0`),
    check(
      'disputes_provider_timestamp_order',
      sql`${table.providerUpdatedAt} >= ${table.providerCreatedAt}`
    )
  ]
);

export const entitlementGrants = pgTable(
  'entitlement_grants',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    titleId: uuid('title_id')
      .notNull()
      .references(() => titles.id, { onDelete: 'restrict' }),
    userId: uuid('user_id').references(() => user.id, { onDelete: 'restrict' }),
    source: entitlementGrantSource('source').notNull(),
    orderItemId: uuid('order_item_id').references(() => orderItems.id, {
      onDelete: 'restrict'
    }),
    recoveryRefundAllocationId: uuid('recovery_refund_allocation_id').references(
      () => refundAllocations.id,
      { onDelete: 'restrict' }
    ),
    state: entitlementGrantStatus('state').notNull(),
    stateReason: varchar('state_reason', { length: 100 }).notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).defaultNow().notNull(),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('entitlement_grants_purchase_item_unique')
      .on(table.orderItemId)
      .where(sql`${table.source} = 'purchase'`),
    uniqueIndex('entitlement_grants_preserved_user_title_unique')
      .on(table.userId, table.titleId)
      .where(sql`${table.source} = 'preserved'`),
    uniqueIndex('entitlement_grants_administrative_recovery_unique')
      .on(table.recoveryRefundAllocationId)
      .where(sql`${table.source} = 'administrative'`),
    unique('entitlement_grants_purchase_provenance_unique').on(
      table.id,
      table.orderItemId
    ),
    index('entitlement_grants_user_title_idx').on(table.userId, table.titleId, table.state),
    index('entitlement_grants_title_state_idx').on(table.titleId, table.state),
    check(
      'grants_unclaimed_has_no_user',
      sql`${table.state} <> 'unclaimed' or ${table.userId} is null`
    ),
    check(
      'grants_active_has_user',
      sql`${table.state} <> 'active' or ${table.userId} is not null`
    ),
    check(
      'grants_source_consistent',
      sql`(
        ${table.source} = 'purchase' and
        ${table.orderItemId} is not null and
        ${table.recoveryRefundAllocationId} is null and
        ${table.stateReason} <> 'refund_allocation_recovery'
      ) or (
        ${table.source} = 'preserved' and
        ${table.userId} is not null and
        ${table.orderItemId} is null and
        ${table.recoveryRefundAllocationId} is null and
        ${table.stateReason} <> 'refund_allocation_recovery'
      ) or (
        ${table.source} = 'administrative' and
        ${table.userId} is not null and
        ${table.orderItemId} is null and
        ${table.recoveryRefundAllocationId} is not null and
        ${table.stateReason} = 'refund_allocation_recovery' and
        ${table.state} in ('active', 'revoked')
      )`
    ),
    check(
      'grants_state_reason_safe',
      sql`char_length(${table.stateReason}) between 1 and 100`
    ),
    check(
      'grants_state_timestamps_consistent',
      sql`(
        ${table.state} in ('unclaimed', 'active') and
        ${table.suspendedAt} is null and ${table.revokedAt} is null
      ) or (
        ${table.state} = 'suspended' and
        ${table.suspendedAt} is not null and ${table.revokedAt} is null
      ) or (
        ${table.state} = 'revoked' and ${table.revokedAt} is not null
      )`
    ),
    check(
      'grants_state_timestamps_after_grant',
      sql`(${table.suspendedAt} is null or ${table.suspendedAt} >= ${table.grantedAt}) and (${table.revokedAt} is null or ${table.revokedAt} >= ${table.grantedAt})`
    )
  ]
);

export const stripeEvents = pgTable(
  'stripe_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    providerEventId: varchar('provider_event_id', { length: 255 }).notNull(),
    eventType: varchar('event_type', { length: 100 }).notNull(),
    objectId: varchar('object_id', { length: 255 }).notNull(),
    liveMode: boolean('live_mode').notNull(),
    apiVersion: varchar('api_version', { length: 100 }),
    providerCreatedAt: timestamp('provider_created_at', { withTimezone: true }).notNull(),
    rawBodySha256: varchar('raw_body_sha256', { length: 64 }).notNull(),
    status: stripeEventStatus('status').default('pending').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('stripe_events_provider_event_unique').on(table.providerEventId),
    index('stripe_events_status_created_idx').on(table.status, table.createdAt),
    index('stripe_events_object_idx').on(table.objectId, table.providerCreatedAt),
    check(
      'stripe_events_payload_digest_sha256',
      sql`${table.rawBodySha256} ~ '^[a-f0-9]{64}$'`
    ),
    check(
      'stripe_events_identifier_safe',
      sql`char_length(${table.providerEventId}) > 0 and char_length(${table.eventType}) > 0 and char_length(${table.objectId}) > 0`
    ),
    check(
      'stripe_events_processed_timestamp_consistent',
      sql`(${table.status} = 'pending') = (${table.processedAt} is null)`
    )
  ]
);

export const applicationRateLimits = pgTable(
  'application_rate_limits',
  {
    namespace: varchar('namespace', { length: 100 }).notNull(),
    scopeSha256: varchar('scope_sha256', { length: 64 }).notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').default(1).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    primaryKey({
      name: 'application_rate_limits_pk',
      columns: [table.namespace, table.scopeSha256, table.windowStart]
    }),
    index('application_rate_limits_expiry_idx').on(table.expiresAt),
    index('application_rate_limits_claim_idx').on(
      table.namespace,
      table.scopeSha256,
      table.windowStart,
      table.expiresAt
    ),
    check(
      'application_rate_limits_scope_digest_sha256',
      sql`${table.scopeSha256} ~ '^[a-f0-9]{64}$'`
    ),
    check('application_rate_limits_count_positive', sql`${table.count} > 0`),
    check(
      'application_rate_limits_expiry_after_window',
      sql`${table.expiresAt} > ${table.windowStart}`
    ),
    check(
      'application_rate_limits_namespace_safe',
      sql`${table.namespace} ~ '^[a-z0-9][a-z0-9._-]{0,99}$'`
    )
  ]
);

export type OrderRow = typeof orders.$inferSelect;
export type NewOrderRow = typeof orders.$inferInsert;
export type OrderItemRow = typeof orderItems.$inferSelect;
export type NewOrderItemRow = typeof orderItems.$inferInsert;
export type PaymentRow = typeof payments.$inferSelect;
export type NewPaymentRow = typeof payments.$inferInsert;
export type RefundRow = typeof refunds.$inferSelect;
export type NewRefundRow = typeof refunds.$inferInsert;
export type RefundAllocationRow = typeof refundAllocations.$inferSelect;
export type NewRefundAllocationRow = typeof refundAllocations.$inferInsert;
export type DisputeRow = typeof disputes.$inferSelect;
export type NewDisputeRow = typeof disputes.$inferInsert;
export type EntitlementGrantRow = typeof entitlementGrants.$inferSelect;
export type NewEntitlementGrantRow = typeof entitlementGrants.$inferInsert;
export type StripeEventRow = typeof stripeEvents.$inferSelect;
export type NewStripeEventRow = typeof stripeEvents.$inferInsert;
export type ApplicationRateLimitRow = typeof applicationRateLimits.$inferSelect;
export type NewApplicationRateLimitRow = typeof applicationRateLimits.$inferInsert;
