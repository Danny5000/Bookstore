import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { OrderItemRow, OrderRow } from '$lib/server/db/schema';
import {
  acceptedOrderInsertQuery,
  acceptedOrderItemsInsertQuery,
  insertAcceptedOrder,
  insertAcceptedOrderItems
} from './orders';

function rendered(query: SQL): { sql: string; params: unknown[] } {
  return query.toQuery({
    casing: {} as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value}'`
  });
}

describe('accepted checkout insert authority', () => {
  it('targets only the seven runtime-granted order columns', () => {
    const query = rendered(acceptedOrderInsertQuery({
      initiatingUserId: null,
      purchaseEmail: null,
      currency: 'USD',
      subtotalMinor: 1000,
      clientCheckoutAttemptId: '00000000-0000-4000-8000-000000000001',
      quoteFingerprintSha256: 'a'.repeat(64),
      statusTokenSha256: 'b'.repeat(64)
    }));
    const normalized = query.sql.replace(/\s+/gu, ' ').trim();
    expect(normalized).toMatch(
      /^insert into "public"\."orders" \(\s*"initiating_user_id", "purchase_email", "currency", "subtotal_minor", "client_checkout_attempt_id", "quote_fingerprint_sha256", "status_token_sha256"\s*\) values /u
    );
    expect(normalized.slice(0, normalized.indexOf(' values '))).not.toMatch(
      /"(?:id|status|guest_identity_id|tax_minor|total_minor|stripe_checkout_session_id|checkout_expires_at|paid_at|created_at|updated_at)"/u
    );
    expect(normalized).toMatch(/returning "id"$/u);
  });

  it('targets only the seven runtime-granted item columns for every row', () => {
    const query = rendered(acceptedOrderItemsInsertQuery([
      {
        orderId: '00000000-0000-4000-8000-000000000001',
        titleId: '00000000-0000-4000-8000-000000000002',
        titleSnapshot: 'First',
        creatorNameSnapshot: 'Creator',
        format: 'prose',
        currency: 'USD',
        unitSubtotalMinor: 1000
      },
      {
        orderId: '00000000-0000-4000-8000-000000000001',
        titleId: '00000000-0000-4000-8000-000000000003',
        titleSnapshot: 'Second',
        creatorNameSnapshot: 'Creator',
        format: 'comic',
        currency: 'USD',
        unitSubtotalMinor: 1500
      }
    ]));
    const normalized = query.sql.replace(/\s+/gu, ' ').trim();
    expect(normalized).toMatch(
      /^insert into "public"\."order_items" \(\s*"order_id", "title_id", "title_snapshot", "creator_name_snapshot", "format", "currency", "unit_subtotal_minor"\s*\) values /u
    );
    expect(normalized.slice(0, normalized.indexOf(' values '))).not.toMatch(
      /"(?:id|tax_minor|total_minor|stripe_line_item_id|created_at)"/u
    );
    expect(query.params).toHaveLength(14);
    expect(normalized).toMatch(/returning "id"$/u);
  });

  it('hydrates orders and items through schema-aware SELECTs before returning dates', async () => {
    const createdAt = new Date('2026-08-15T12:00:00.000Z');
    const order: OrderRow = {
      id: '00000000-0000-4000-8000-000000000001',
      status: 'checkout_pending',
      initiatingUserId: null,
      guestIdentityId: null,
      purchaseEmail: 'reader@example.com',
      currency: 'USD',
      subtotalMinor: 2500,
      taxMinor: null,
      totalMinor: null,
      clientCheckoutAttemptId: '00000000-0000-4000-8000-000000000002',
      quoteFingerprintSha256: 'a'.repeat(64),
      stripeCheckoutSessionId: null,
      statusTokenSha256: 'b'.repeat(64),
      checkoutExpiresAt: null,
      paidAt: null,
      createdAt,
      updatedAt: createdAt
    };
    const items: OrderItemRow[] = [
      {
        id: '00000000-0000-4000-8000-000000000003',
        orderId: order.id,
        titleId: '00000000-0000-4000-8000-000000000004',
        titleSnapshot: 'First',
        creatorNameSnapshot: 'Creator',
        format: 'prose',
        currency: 'USD',
        unitSubtotalMinor: 1000,
        taxMinor: null,
        totalMinor: null,
        stripeLineItemId: null,
        createdAt
      },
      {
        id: '00000000-0000-4000-8000-000000000005',
        orderId: order.id,
        titleId: '00000000-0000-4000-8000-000000000006',
        titleSnapshot: 'Second',
        creatorNameSnapshot: 'Creator',
        format: 'comic',
        currency: 'USD',
        unitSubtotalMinor: 1500,
        taxMinor: null,
        totalMinor: null,
        stripeLineItemId: null,
        createdAt
      }
    ];
    const selectedRows = [[order], [...items]];
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: order.id }] })
      .mockResolvedValueOnce({ rows: items.map((item) => ({ id: item.id })) });
    const select = vi.fn(() => ({
      from: () => ({ where: async () => selectedRows.shift() ?? [] })
    }));
    const database = { execute, select } as never;

    const hydratedOrder = await insertAcceptedOrder(database, {
      initiatingUserId: order.initiatingUserId,
      purchaseEmail: order.purchaseEmail,
      currency: order.currency,
      subtotalMinor: order.subtotalMinor,
      clientCheckoutAttemptId: order.clientCheckoutAttemptId,
      quoteFingerprintSha256: order.quoteFingerprintSha256,
      statusTokenSha256: order.statusTokenSha256
    });
    const hydratedItems = await insertAcceptedOrderItems(database, items.map((item) => ({
      orderId: item.orderId,
      titleId: item.titleId,
      titleSnapshot: item.titleSnapshot,
      creatorNameSnapshot: item.creatorNameSnapshot,
      format: item.format,
      currency: item.currency,
      unitSubtotalMinor: item.unitSubtotalMinor
    })));

    expect(hydratedOrder).toEqual(order);
    expect(hydratedOrder?.createdAt).toBeInstanceOf(Date);
    expect(hydratedItems).toEqual(items);
    expect(hydratedItems.every((item) => item.createdAt instanceof Date)).toBe(true);
    expect(select).toHaveBeenCalledTimes(2);
  });
});
