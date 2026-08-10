import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { databaseClient } from './database';

let sequence = 0;

async function createUser(): Promise<string> {
  sequence += 1;
  const result = await databaseClient.pool.query<{ id: string }>(
    `insert into "user" (name, email, email_verified)
     values ($1, $2, true)
     returning id`,
    [`Commerce User ${sequence}`, `commerce-${sequence}@example.com`]
  );
  return result.rows[0]!.id;
}

async function createTitle(format: 'prose' | 'comic' = 'prose'): Promise<string> {
  sequence += 1;
  const result = await databaseClient.pool.query<{ id: string }>(
    `insert into titles
       (slug, title, description, creator_name, format, price_minor, currency)
     values ($1, $2, 'Description', 'Creator', $3, 1000, 'USD')
     returning id`,
    [`commerce-title-${sequence}`, `Commerce Title ${sequence}`, format]
  );
  return result.rows[0]!.id;
}

interface OrderOptions {
  userId?: string | null;
  guestIdentityId?: string | null;
  purchaseEmail?: string | null;
  status?: 'checkout_pending' | 'paid';
  sessionId?: string | null;
}

async function createOrder(options: OrderOptions = {}): Promise<string> {
  const status = options.status ?? 'checkout_pending';
  const paid = status === 'paid';
  const sessionId = options.sessionId ?? null;
  const result = await databaseClient.pool.query<{ id: string }>(
    `insert into orders
       (status, initiating_user_id, guest_identity_id, purchase_email, currency,
        subtotal_minor, tax_minor, total_minor, client_checkout_attempt_id,
        quote_fingerprint_sha256, stripe_checkout_session_id, status_token_sha256,
        checkout_expires_at, paid_at)
     values ($1, $2, $3, $4, 'USD', 1000, $5, $6, $7,
             repeat('a', 64), $8, repeat('b', 64), $9, $10)
     returning id`,
    [
      status,
      options.userId ?? null,
      options.guestIdentityId ?? null,
      options.purchaseEmail ?? null,
      paid ? 100 : null,
      paid ? 1100 : null,
      randomUUID(),
      sessionId,
      sessionId ? new Date(Date.now() + 30 * 60 * 1000) : null,
      paid ? new Date() : null
    ]
  );
  return result.rows[0]!.id;
}

async function createOrderItem(
  orderId: string,
  titleId: string,
  stripeLineItemId: string | null = null
): Promise<string> {
  const result = await databaseClient.pool.query<{ id: string }>(
    `insert into order_items
       (order_id, title_id, title_snapshot, creator_name_snapshot, format, currency,
        unit_subtotal_minor, stripe_line_item_id)
     values ($1, $2, 'Safe title snapshot', 'Safe creator snapshot', 'prose', 'USD', 1000, $3)
     returning id`,
    [orderId, titleId, stripeLineItemId]
  );
  return result.rows[0]!.id;
}

async function createPayment(
  orderId: string,
  paymentIntentId = `pi_test_${randomUUID()}`,
  chargeId: string | null = null
): Promise<string> {
  const result = await databaseClient.pool.query<{ id: string }>(
    `insert into payments
       (order_id, stripe_payment_intent_id, stripe_latest_charge_id, status,
        amount_minor, currency)
     values ($1, $2, $3, 'pending', 1100, 'USD')
     returning id`,
    [orderId, paymentIntentId, chargeId]
  );
  return result.rows[0]!.id;
}

function expectConstraint(
  promise: Promise<unknown>,
  code: '23001' | '23503' | '23505' | '23514'
) {
  return expect(promise).rejects.toMatchObject({ code });
}

describe('Plan 6A commerce migration and constraints', () => {
  it('backfills only active pre-commerce entitlements and remains idempotent', async () => {
    const userId = await createUser();
    const activeTitleId = await createTitle();
    const revokedTitleId = await createTitle();
    await databaseClient.pool.query(
      `insert into entitlements (user_id, title_id)
       values ($1, $2), ($1, $3)`,
      [userId, activeTitleId, revokedTitleId]
    );
    await databaseClient.pool.query(
      `update entitlements
       set revoked_at = clock_timestamp(), updated_at = clock_timestamp()
       where user_id = $1 and title_id = $2`,
      [userId, revokedTitleId]
    );

    const migration = readFileSync(
      fileURLToPath(new URL('../../drizzle/0005_public_firelord.sql', import.meta.url)),
      'utf8'
    );
    const backfill = migration.match(
      /INSERT INTO "entitlement_grants"[\s\S]+?ON CONFLICT DO NOTHING;/u
    )?.[0];
    expect(backfill).toBeDefined();
    await databaseClient.pool.query(backfill!);
    await databaseClient.pool.query(backfill!);

    const grants = await databaseClient.pool.query<{
      title_id: string;
      source: string;
      state: string;
      state_reason: string;
    }>(
      `select title_id, source, state, state_reason
       from entitlement_grants
       where user_id = $1
       order by title_id`,
      [userId]
    );
    expect(grants.rows).toEqual([
      {
        title_id: activeTitleId,
        source: 'preserved',
        state: 'active',
        state_reason: 'pre_commerce_entitlement'
      }
    ]);
  });

  it('rejects inconsistent grant source, item, user, and state shapes', async () => {
    const userId = await createUser();
    const titleId = await createTitle();
    const itemId = await createOrderItem(await createOrder(), titleId);

    await expectConstraint(
      databaseClient.pool.query(
        `insert into entitlement_grants
           (title_id, user_id, source, state, state_reason)
         values ($1, $2, 'purchase', 'active', 'invalid')`,
        [titleId, userId]
      ),
      '23514'
    );
    await expectConstraint(
      databaseClient.pool.query(
        `insert into entitlement_grants
           (title_id, user_id, source, order_item_id, state, state_reason)
         values ($1, $2, 'preserved', $3, 'active', 'invalid')`,
        [titleId, userId, itemId]
      ),
      '23514'
    );
    await expectConstraint(
      databaseClient.pool.query(
        `insert into entitlement_grants
           (title_id, source, state, state_reason)
         values ($1, 'preserved', 'suspended', 'invalid')`,
        [titleId]
      ),
      '23514'
    );
    await expectConstraint(
      databaseClient.pool.query(
        `insert into entitlement_grants
           (title_id, user_id, source, order_item_id, state, state_reason)
         values ($1, $2, 'purchase', $3, 'unclaimed', 'invalid')`,
        [titleId, userId, itemId]
      ),
      '23514'
    );
    await expectConstraint(
      databaseClient.pool.query(
        `insert into entitlement_grants
           (title_id, source, order_item_id, state, state_reason)
         values ($1, 'purchase', $2, 'active', 'invalid')`,
        [titleId, itemId]
      ),
      '23514'
    );
  });

  it('allows no-user purchase grants to be unclaimed, suspended, or revoked but not active', async () => {
    const titleId = await createTitle();
    const itemIds = await Promise.all(
      [0, 1, 2].map(async () => createOrderItem(await createOrder(), titleId))
    );

    await databaseClient.pool.query(
      `insert into entitlement_grants
         (title_id, source, order_item_id, state, state_reason, suspended_at, revoked_at)
       values
         ($1, 'purchase', $2, 'unclaimed', 'awaiting_claim', null, null),
         ($1, 'purchase', $3, 'suspended', 'dispute_open', clock_timestamp(), null),
         ($1, 'purchase', $4, 'revoked', 'refunded', null, clock_timestamp())`,
      [titleId, ...itemIds]
    );

    const states = await databaseClient.pool.query<{ state: string }>(
      `select state from entitlement_grants where title_id = $1 order by state`,
      [titleId]
    );
    expect(states.rows.map((row) => row.state).sort()).toEqual([
      'revoked',
      'suspended',
      'unclaimed'
    ]);
  });

  it('enforces unique order, provider, event, and source identifiers', async () => {
    const firstTitleId = await createTitle();
    const secondTitleId = await createTitle();
    const firstOrderId = await createOrder({ sessionId: 'cs_test_unique' });
    const firstItemId = await createOrderItem(firstOrderId, firstTitleId, 'li_test_unique');

    await expectConstraint(createOrder({ sessionId: 'cs_test_unique' }), '23505');
    await expectConstraint(createOrderItem(firstOrderId, firstTitleId), '23505');
    const secondOrderId = await createOrder();
    await expectConstraint(
      createOrderItem(secondOrderId, secondTitleId, 'li_test_unique'),
      '23505'
    );

    const paymentId = await createPayment(firstOrderId, 'pi_test_unique', 'ch_test_unique');
    await expectConstraint(createPayment(secondOrderId, 'pi_test_unique'), '23505');
    const thirdOrderId = await createOrder();
    await expectConstraint(createPayment(thirdOrderId, 'pi_test_other', 'ch_test_unique'), '23505');

    await databaseClient.pool.query(
      `insert into refunds
         (payment_id, stripe_refund_id, amount_minor, currency, provider_created_at)
       values ($1, 're_test_unique', 100, 'USD', clock_timestamp())`,
      [paymentId]
    );
    await expectConstraint(
      databaseClient.pool.query(
        `insert into refunds
           (payment_id, stripe_refund_id, amount_minor, currency, provider_created_at)
         values ($1, 're_test_unique', 100, 'USD', clock_timestamp())`,
        [paymentId]
      ),
      '23505'
    );
    await databaseClient.pool.query(
      `insert into disputes
         (payment_id, stripe_dispute_id, amount_minor, currency,
          provider_created_at, provider_updated_at)
       values ($1, 'dp_test_unique', 1100, 'USD', clock_timestamp(), clock_timestamp())`,
      [paymentId]
    );
    await expectConstraint(
      databaseClient.pool.query(
        `insert into disputes
           (payment_id, stripe_dispute_id, amount_minor, currency,
            provider_created_at, provider_updated_at)
         values ($1, 'dp_test_unique', 1100, 'USD', clock_timestamp(), clock_timestamp())`,
        [paymentId]
      ),
      '23505'
    );
    await databaseClient.pool.query(
      `insert into stripe_events
         (provider_event_id, event_type, object_id, live_mode, provider_created_at,
          raw_body_sha256)
       values ('evt_test_unique', 'checkout.session.completed', 'cs_test_unique', false,
               clock_timestamp(), repeat('c', 64))`
    );
    await expectConstraint(
      databaseClient.pool.query(
        `insert into stripe_events
           (provider_event_id, event_type, object_id, live_mode, provider_created_at,
            raw_body_sha256)
         values ('evt_test_unique', 'checkout.session.completed', 'cs_test_other', false,
                 clock_timestamp(), repeat('d', 64))`
      ),
      '23505'
    );

    await databaseClient.pool.query(
      `insert into entitlement_grants
         (title_id, source, order_item_id, state, state_reason)
       values ($1, 'purchase', $2, 'unclaimed', 'awaiting_claim')`,
      [firstTitleId, firstItemId]
    );
    await expectConstraint(
      databaseClient.pool.query(
        `insert into entitlement_grants
           (title_id, source, order_item_id, state, state_reason, revoked_at)
         values ($1, 'purchase', $2, 'revoked', 'duplicate', clock_timestamp())`,
        [firstTitleId, firstItemId]
      ),
      '23505'
    );
  });

  it('rejects negative money, invalid currency/digests, and impossible paid identity', async () => {
    const invalidOrder = (
      subtotalMinor: number,
      currency: string,
      quoteDigest: string,
      statusDigest: string
    ) =>
      databaseClient.pool.query(
        `insert into orders
           (currency, subtotal_minor, client_checkout_attempt_id,
            quote_fingerprint_sha256, status_token_sha256)
         values ($1, $2, $3, $4, $5)`,
        [currency, subtotalMinor, randomUUID(), quoteDigest, statusDigest]
      );

    await expectConstraint(invalidOrder(-1, 'USD', 'a'.repeat(64), 'b'.repeat(64)), '23514');
    await expectConstraint(invalidOrder(1, 'usd', 'a'.repeat(64), 'b'.repeat(64)), '23514');
    await expectConstraint(invalidOrder(1, 'USD', 'not-a-digest', 'b'.repeat(64)), '23514');
    await expectConstraint(invalidOrder(1, 'USD', 'a'.repeat(64), 'NOT-A-DIGEST'), '23514');

    await expectConstraint(
      databaseClient.pool.query(
        `insert into orders
           (status, purchase_email, currency, subtotal_minor, tax_minor, total_minor,
            client_checkout_attempt_id, quote_fingerprint_sha256, status_token_sha256, paid_at)
         values ('paid', 'reader@example.com', 'USD', 1000, 100, 1100,
                 $1, repeat('a', 64), repeat('b', 64), clock_timestamp())`,
        [randomUUID()]
      ),
      '23514'
    );

    const orderId = await createOrder();
    const titleId = await createTitle();
    await expectConstraint(
      databaseClient.pool.query(
        `insert into order_items
           (order_id, title_id, title_snapshot, creator_name_snapshot, format,
            currency, unit_subtotal_minor)
         values ($1, $2, 'Title', 'Creator', 'prose', 'USD', -1)`,
        [orderId, titleId]
      ),
      '23514'
    );
    await expectConstraint(
      databaseClient.pool.query(
        `insert into stripe_events
           (provider_event_id, event_type, object_id, live_mode, provider_created_at,
            raw_body_sha256)
         values ('evt_bad_digest', 'checkout.session.completed', 'cs_bad', false,
                 clock_timestamp(), 'bad')`
      ),
      '23514'
    );
  });

  it('permits multiple independent purchase grants for the same user and title', async () => {
    const userId = await createUser();
    const titleId = await createTitle();
    const firstItemId = await createOrderItem(await createOrder(), titleId);
    const secondItemId = await createOrderItem(await createOrder(), titleId);

    await databaseClient.pool.query(
      `insert into entitlement_grants
         (title_id, user_id, source, order_item_id, state, state_reason)
       values
         ($1, $2, 'purchase', $3, 'active', 'paid'),
         ($1, $2, 'purchase', $4, 'active', 'paid')`,
      [titleId, userId, firstItemId, secondItemId]
    );
    const result = await databaseClient.pool.query<{ count: string }>(
      `select count(*) from entitlement_grants where user_id = $1 and title_id = $2`,
      [userId, titleId]
    );
    expect(result.rows[0]!.count).toBe('2');
  });

  it('restricts deletion of referenced users, titles, and orders', async () => {
    const userId = await createUser();
    const titleId = await createTitle();
    const orderId = await createOrder({
      userId,
      purchaseEmail: `commerce-${sequence}@example.com`,
      status: 'paid'
    });
    const itemId = await createOrderItem(orderId, titleId);
    await createPayment(orderId);
    await databaseClient.pool.query(
      `insert into entitlement_grants
         (title_id, user_id, source, order_item_id, state, state_reason)
       values ($1, $2, 'purchase', $3, 'active', 'paid')`,
      [titleId, userId, itemId]
    );

    await expectConstraint(
      databaseClient.pool.query(`delete from "user" where id = $1`, [userId]),
      '23001'
    );
    await expectConstraint(
      databaseClient.pool.query(`delete from titles where id = $1`, [titleId]),
      '23001'
    );
    await expectConstraint(
      databaseClient.pool.query(`delete from orders where id = $1`, [orderId]),
      '23001'
    );
  });
});
