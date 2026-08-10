import { describe, expect, it } from 'vitest';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import {
  applicationRateLimits,
  disputeStatus,
  disputes,
  entitlementGrantSource,
  entitlementGrantStatus,
  entitlementGrants,
  financialReconciliationStatus,
  orderItems,
  orderStatus,
  orders,
  paymentStatus,
  payments,
  refundAllocationSource,
  refundAllocations,
  refundStatus,
  refunds,
  stripeEventStatus,
  stripeEvents
} from './commerce';

const TABLES = [
  orders,
  orderItems,
  payments,
  refunds,
  refundAllocations,
  disputes,
  entitlementGrants,
  stripeEvents,
  applicationRateLimits
] as const;

const configFor = (table: PgTable) => getTableConfig(table);
const indexNames = (table: PgTable) => configFor(table).indexes.map((item) => item.config.name);
const checkNames = (table: PgTable) => configFor(table).checks.map((item) => item.name);

describe('commerce schema declarations', () => {
  it('declares the complete commerce table and enum vocabulary', () => {
    expect(TABLES.map((table) => configFor(table).name)).toEqual([
      'orders',
      'order_items',
      'payments',
      'refunds',
      'refund_allocations',
      'disputes',
      'entitlement_grants',
      'stripe_events',
      'application_rate_limits'
    ]);
    expect(orderStatus.enumValues).toEqual([
      'checkout_pending',
      'checkout_open',
      'payment_pending',
      'paid',
      'expired',
      'failed',
      'exception'
    ]);
    expect(paymentStatus.enumValues).toEqual(['pending', 'succeeded', 'failed']);
    expect(refundStatus.enumValues).toEqual(['pending', 'succeeded', 'failed', 'canceled']);
    expect(disputeStatus.enumValues).toEqual(['open', 'won', 'lost']);
    expect(entitlementGrantSource.enumValues).toEqual(['purchase', 'preserved']);
    expect(entitlementGrantStatus.enumValues).toEqual([
      'unclaimed',
      'active',
      'suspended',
      'revoked'
    ]);
    expect(refundAllocationSource.enumValues).toEqual(['automatic', 'administrative']);
    expect(stripeEventStatus.enumValues).toEqual(['pending', 'processed', 'exception']);
    expect(financialReconciliationStatus.enumValues).toEqual([
      'pending',
      'reconciled',
      'exception'
    ]);
  });

  it('declares stable unique provider, order, and grant-source indexes', () => {
    expect(indexNames(orders)).toEqual(
      expect.arrayContaining([
        'orders_checkout_attempt_unique',
        'orders_stripe_checkout_session_unique'
      ])
    );
    expect(indexNames(orderItems)).toEqual(
      expect.arrayContaining([
        'order_items_order_title_unique',
        'order_items_stripe_line_item_unique'
      ])
    );
    expect(indexNames(payments)).toEqual(
      expect.arrayContaining([
        'payments_order_unique',
        'payments_stripe_payment_intent_unique',
        'payments_stripe_latest_charge_unique'
      ])
    );
    expect(indexNames(refunds)).toContain('refunds_stripe_refund_unique');
    expect(indexNames(refundAllocations)).toContain('refund_allocations_refund_item_unique');
    expect(indexNames(disputes)).toContain('disputes_stripe_dispute_unique');
    expect(indexNames(entitlementGrants)).toEqual(
      expect.arrayContaining([
        'entitlement_grants_purchase_item_unique',
        'entitlement_grants_preserved_user_title_unique'
      ])
    );
    expect(indexNames(stripeEvents)).toContain('stripe_events_provider_event_unique');
  });

  it('declares money, currency, digest, identity, and grant consistency checks', () => {
    expect(checkNames(orders)).toEqual(
      expect.arrayContaining([
        'orders_money_nonnegative',
        'orders_currency_iso',
        'orders_status_digest_sha256',
        'orders_quote_digest_sha256',
        'orders_paid_identity_consistent'
      ])
    );
    expect(checkNames(orderItems)).toEqual(
      expect.arrayContaining(['order_items_money_nonnegative', 'order_items_currency_iso'])
    );
    expect(checkNames(payments)).toEqual(
      expect.arrayContaining(['payments_amount_nonnegative', 'payments_currency_iso'])
    );
    expect(checkNames(refunds)).toEqual(
      expect.arrayContaining(['refunds_amount_nonnegative', 'refunds_currency_iso'])
    );
    expect(checkNames(refundAllocations)).toContain('refund_allocations_amount_nonnegative');
    expect(checkNames(disputes)).toEqual(
      expect.arrayContaining(['disputes_amount_nonnegative', 'disputes_currency_iso'])
    );
    expect(checkNames(entitlementGrants)).toEqual(
      expect.arrayContaining([
        'grants_unclaimed_has_no_user',
        'grants_active_has_user',
        'grants_source_consistent'
      ])
    );
    expect(checkNames(stripeEvents)).toContain('stripe_events_payload_digest_sha256');
    expect(checkNames(applicationRateLimits)).toEqual(
      expect.arrayContaining([
        'application_rate_limits_scope_digest_sha256',
        'application_rate_limits_count_positive'
      ])
    );
  });

  it('keeps raw provider payloads, URLs, billing/card data, and secrets out of persistence', () => {
    const columnNames = TABLES.flatMap((table) =>
      configFor(table).columns.map((column) => column.name)
    );

    expect(columnNames).not.toEqual(
      expect.arrayContaining([
        'raw_payload',
        'provider_payload',
        'checkout_url',
        'receipt_url',
        'action_url',
        'billing_address',
        'card_number',
        'client_secret',
        'secret_key',
        'webhook_secret'
      ])
    );
    expect(columnNames.some((name) => /(checkout|receipt|action)_url/.test(name))).toBe(false);
    expect(columnNames.some((name) => /(billing|card|secret)/.test(name))).toBe(false);
  });

  it('uses restrictive foreign keys for retained commerce history', () => {
    for (const table of TABLES.slice(0, 8)) {
      for (const foreignKey of configFor(table).foreignKeys) {
        expect(foreignKey.onDelete).toBe('restrict');
      }
    }
  });
});
