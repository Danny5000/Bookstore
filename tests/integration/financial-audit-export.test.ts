import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AdministratorActor } from '$lib/server/auth/admin-policy';
import { exportSalesCsv } from '$lib/server/commerce/reporting/csv';
import {
  fingerprintSalesFilters,
  parseSalesOverviewFilters,
  type SalesOverviewFilters
} from '$lib/server/commerce/reporting/filters';
import { SALES_CSV_ROW_DTO_KEYS } from '$lib/types/financial-reporting';
import { databaseClient, ownerDatabaseClient } from './database';

const NOW = new Date('2026-08-22T12:00:00.000Z');
let sequence = 0;

function token(prefix: string): string {
  sequence += 1;
  return `${prefix}_${sequence}_${randomUUID().replaceAll('-', '')}`;
}

async function createAdministrator(label: string): Promise<AdministratorActor> {
  const id = randomUUID();
  await ownerDatabaseClient.pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, $2, $3, true)`,
    [id, `CSV administrator ${label}`, `${label}-${id}@example.test`]
  );
  await ownerDatabaseClient.pool.query(
    `insert into user_roles (user_id, role) values ($1, 'admin')`,
    [id]
  );
  return { type: 'user', id, roles: ['admin'] };
}

interface PendingSaleFixture {
  readonly titleId: string;
  readonly buyerEmail: string;
  readonly chargeProviderId: string;
  readonly paymentIntentProviderId: string;
}

async function createPendingSale(label: string): Promise<PendingSaleFixture> {
  const titleId = randomUUID();
  const buyerId = randomUUID();
  const buyerEmail = `${token(`${label}_private_buyer`).toLowerCase()}@example.test`;
  const chargeProviderId = token(`${label}_private_charge`);
  const paymentIntentProviderId = token(`${label}_private_intent`);
  await ownerDatabaseClient.pool.query(
    `insert into titles
       (id, slug, title, description, creator_name, format, price_minor, currency, visibility)
     values ($1, $2, '=SUM(PRIVATE1)', 'CSV integration fixture',
             'Safe Creator', 'comic', 1250, 'USD', 'private')`,
    [titleId, `csv-${label}-${randomUUID().replaceAll('-', '')}`]
  );
  await ownerDatabaseClient.pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, 'Private CSV buyer', $2, true)`,
    [buyerId, buyerEmail]
  );
  const order = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into orders
       (status, initiating_user_id, purchase_email, currency, subtotal_minor, tax_minor,
        total_minor, client_checkout_attempt_id, quote_fingerprint_sha256,
        status_token_sha256, paid_at)
     values ('paid', $1, $2, 'USD', 1000, 250, 1250, $3,
             repeat('a', 64), repeat('b', 64), '2026-08-01T09:00:00.000Z')
     returning id`,
    [buyerId, buyerEmail, randomUUID()]
  );
  await ownerDatabaseClient.pool.query(
    `insert into order_items
       (order_id, title_id, title_snapshot, creator_name_snapshot, format, currency,
        unit_subtotal_minor, tax_minor, total_minor, stripe_line_item_id)
     values ($1, $2, 'Sold Snapshot', 'Safe Creator', 'comic', 'USD',
             1000, 250, 1250, $3)`,
    [order.rows[0]!.id, titleId, token(`${label}_private_line`)]
  );
  await ownerDatabaseClient.pool.query(
    `insert into payments
       (order_id, stripe_payment_intent_id, stripe_latest_charge_id, status,
        amount_minor, currency, payment_method_category, paid_at, financial_evidence_status)
     values ($1, $2, $3, 'succeeded', 1250, 'USD', 'card',
             '2026-08-01T09:00:00.000Z', 'pending')`,
    [order.rows[0]!.id, paymentIntentProviderId, chargeProviderId]
  );
  return { titleId, buyerEmail, chargeProviderId, paymentIntentProviderId };
}

function titleFilters(titleId: string): SalesOverviewFilters {
  return parseSalesOverviewFilters(
    new URL(
      `https://books.example.test/admin/sales?range=all&titleId=${titleId}&sort=title_asc`
    ),
    NOW
  );
}

describe('bounded audited sales CSV export', () => {
  it('exports only fixed aggregate fields and commits exactly one minimized audit', async () => {
    const actor = await createAdministrator('success');
    const sale = await createPendingSale('success');
    const filters = titleFilters(sale.titleId);
    const correlationId = 'financial-csv-success';

    const result = await exportSalesCsv(databaseClient.db, actor, filters, {
      correlationId,
      requestMetadata: { method: 'GET', routeId: '/admin/sales/export.csv' }
    });
    const csv = new TextDecoder().decode(result.bytes);
    const cells = csv.split('\r\n')[1]!.split(',');

    expect(result.filename).toBe('pale-orbit-sales-all-time.csv');
    expect(result.rowCount).toBe(1);
    expect(csv.split('\r\n')[0]).toBe(SALES_CSV_ROW_DTO_KEYS.join(','));
    expect(csv.startsWith('\ufeff')).toBe(false);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(cells[0]).toBe("'=SUM(PRIVATE1)");
    expect(cells[4]).toBe('USD');
    expect(cells[5]).toBe('');
    expect(cells.slice(13, 21)).toEqual(['', '', '', '', '', '', '', '']);
    expect(cells[21]).toBe('false');
    expect(cells[23]).toBe('pending');
    expect(cells[25]).toBe('');
    for (const privateValue of [
      sale.buyerEmail,
      sale.chargeProviderId,
      sale.paymentIntentProviderId,
      actor.id,
      correlationId
    ]) {
      expect(csv).not.toContain(privateValue);
    }

    const fingerprint = fingerprintSalesFilters(filters);
    const audit = await ownerDatabaseClient.pool.query<{
      actor_id: string;
      action: string;
      outcome: string;
      resource_type: string;
      resource_id: string;
      correlation_id: string;
      request_metadata: Record<string, unknown>;
      before: unknown;
      after: unknown;
    }>(
      `select actor_id, action, outcome, resource_type, resource_id, correlation_id,
              request_metadata, before, after
       from audit_events where correlation_id = $1`,
      [correlationId]
    );
    expect(audit.rows).toEqual([{
      actor_id: actor.id,
      action: 'financial.sales_export',
      outcome: 'succeeded',
      resource_type: 'financial_sales_export',
      resource_id: fingerprint,
      correlation_id: correlationId,
      request_metadata: {
        filterFingerprint: fingerprint,
        rowCount: 1,
        byteCount: result.bytes.byteLength,
        currencyPairCount: 1,
        method: 'GET',
        route: '/admin/sales/export.csv'
      },
      before: null,
      after: null
    }]);
  });

  it('returns no bytes and commits no audit when the fixed audit context is invalid', async () => {
    const actor = await createAdministrator('audit-failure');
    const sale = await createPendingSale('audit-failure');

    await expect(exportSalesCsv(databaseClient.db, actor, titleFilters(sale.titleId), {
      correlationId: 'financial-csv-audit-failure',
      requestMetadata: { method: 'GET', routeId: '/admin/sales/private' }
    })).rejects.toMatchObject({
      name: 'SalesReportingInputError',
      code: 'invalid_request',
      status: 400
    });
    await expect(ownerDatabaseClient.pool.query(
      `select count(*)::integer as count from audit_events`
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it('denies a stale in-memory administrator after persisted role revocation', async () => {
    const actor = await createAdministrator('revoked');
    const sale = await createPendingSale('revoked');
    await ownerDatabaseClient.pool.query(
      `delete from user_roles where user_id = $1 and role = 'admin'`,
      [actor.id]
    );

    await expect(exportSalesCsv(databaseClient.db, actor, titleFilters(sale.titleId), {
      correlationId: 'financial-csv-revoked'
    })).rejects.toMatchObject({ name: 'AuthorizationError', code: 'forbidden' });
    await expect(ownerDatabaseClient.pool.query(
      `select count(*)::integer as count from audit_events`
    )).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });
});
