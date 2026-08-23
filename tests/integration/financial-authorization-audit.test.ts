import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import type {
  Actor,
  AdminCapability,
  AdministratorActor,
  CapabilityResolver,
  FinancialAuthorizationDependencies
} from '$lib/server/auth/admin-policy';
import {
  getFinancialAdminCommandStatus,
  submitFinancialAdminCommand
} from '$lib/server/commerce/financial/admin-commands/repository';
import type { FinancialAdminPrivateCommand } from '$lib/server/commerce/financial/admin-commands/contracts';
import {
  getReportingCorrectionSeed,
  previewReportingCorrection
} from '$lib/server/commerce/financial/refund-review/corrections';
import { previewRefundFinalization } from '$lib/server/commerce/financial/refund-review/finalize';
import { getRefundReviewDetail } from '$lib/server/commerce/financial/refund-review/query';
import {
  getAdministrativeRecoverySeed,
  previewAdministrativeRecovery,
  previewAdministrativeRecoveryDeactivation
} from '$lib/server/commerce/financial/refund-review/recovery';
import {
  SALES_CSV_DEADLINE_MS,
  exportSalesCsv
} from '$lib/server/commerce/reporting/csv';
import {
  fingerprintSalesFilters,
  parseSalesOverviewFilters,
  type SalesOverviewFilters
} from '$lib/server/commerce/reporting/filters';
import { listSalesOverview } from '$lib/server/commerce/reporting/overview';
import {
  PAYOUT_PAGE_SIZE,
  getPayoutDetail,
  listPayouts
} from '$lib/server/commerce/reporting/payouts';
import {
  FINANCIAL_ISSUE_PAGE_SIZE,
  getFinancialIssueDetail,
  listFinancialIssues
} from '$lib/server/commerce/reporting/review';
import { FINANCIAL_ADMIN_COMMAND_KINDS } from '$lib/types/financial-reporting';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { databaseClient, ownerDatabaseClient } from './database';

const NOW = new Date('2026-08-22T12:00:00.000Z');
const REQUEST_CONTEXT = { correlationId: 'financial-authorization-matrix' } as const;
const ALL_FINANCIAL_CAPABILITIES = [
  'sales.read',
  'sales.export',
  'reconciliation.manage'
] as const satisfies readonly AdminCapability[];

let sequence = 0;

function token(prefix: string): string {
  sequence += 1;
  return `${prefix}_${sequence}_${randomUUID().replaceAll('-', '')}`;
}

function capabilityResolver(
  capabilities: readonly AdminCapability[]
): CapabilityResolver {
  return () => new Set(capabilities);
}

function dependencies(
  capabilities: readonly AdminCapability[]
): FinancialAuthorizationDependencies {
  return { capabilityResolver: capabilityResolver(capabilities) };
}

async function createUser(
  label: string,
  role: 'admin' | 'customer'
): Promise<Extract<Actor, { type: 'user' }>> {
  const id = randomUUID();
  await ownerDatabaseClient.pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, $2, $3, true)`,
    [id, `Financial ${role} ${label}`, `${label}-${id}@example.test`]
  );
  await ownerDatabaseClient.pool.query(
    `insert into user_roles (user_id, role) values ($1, $2)`,
    [id, role]
  );
  return { type: 'user', id, roles: [role] };
}

async function createAdministrator(label: string): Promise<AdministratorActor> {
  return await createUser(label, 'admin') as AdministratorActor;
}

interface FinancialFixture {
  readonly actor: AdministratorActor;
  readonly customerEmail: string;
  readonly titleId: string;
  readonly refundId: string;
  readonly issueId: string;
  readonly payoutId: string;
  readonly providerValues: readonly string[];
  readonly filters: SalesOverviewFilters;
}

async function createFinancialFixture(label: string): Promise<FinancialFixture> {
  const actor = await createAdministrator(label);
  const customerId = randomUUID();
  const customerEmail = `${token(`${label}_private_customer`).toLowerCase()}@example.test`;
  const titleId = randomUUID();
  const chargeProviderId = token(`${label}_private_charge`);
  const paymentIntentProviderId = token(`${label}_private_intent`);
  const refundProviderId = token(`${label}_private_refund`);
  const payoutProviderId = token(`${label}_private_payout`);

  await ownerDatabaseClient.pool.query(
    `insert into "user" (id, name, email, email_verified)
     values ($1, 'Private financial customer', $2, true)`,
    [customerId, customerEmail]
  );
  await ownerDatabaseClient.pool.query(
    `insert into titles
       (id, slug, title, description, creator_name, format, price_minor, currency, visibility)
     values ($1, $2, 'Financial audit title', 'Financial audit fixture',
             'Safe audit creator', 'prose', 1000, 'USD', 'private')`,
    [titleId, `financial-audit-${randomUUID().replaceAll('-', '')}`]
  );
  const order = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into orders
       (status, initiating_user_id, purchase_email, currency, subtotal_minor, tax_minor,
        total_minor, client_checkout_attempt_id, quote_fingerprint_sha256,
        status_token_sha256, paid_at)
     values ('paid', $1, $2, 'USD', 900, 100, 1000, $3,
             repeat('a', 64), repeat('b', 64), '2026-08-20T09:00:00.000Z')
     returning id`,
    [customerId, customerEmail, randomUUID()]
  );
  await ownerDatabaseClient.pool.query(
    `insert into order_items
       (order_id, title_id, title_snapshot, creator_name_snapshot, format, currency,
        unit_subtotal_minor, tax_minor, total_minor)
     values ($1, $2, 'Financial sold-as title', 'Financial sold-as creator',
             'prose', 'USD', 900, 100, 1000)`,
    [order.rows[0]!.id, titleId]
  );
  const payment = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into payments
       (order_id, stripe_payment_intent_id, stripe_latest_charge_id, status,
        amount_minor, currency, payment_method_category, paid_at, financial_evidence_status)
     values ($1, $2, $3, 'succeeded', 1000, 'USD', 'card',
             '2026-08-20T09:00:00.000Z', 'pending')
     returning id`,
    [order.rows[0]!.id, paymentIntentProviderId, chargeProviderId]
  );
  const refund = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into refunds
       (payment_id, stripe_refund_id, status, amount_minor, currency,
        provider_created_at, allocation_status, financial_evidence_status)
     values ($1, $2, 'succeeded', 500, 'USD', '2026-08-20T10:00:00.000Z',
             'needs_review', 'pending')
     returning id`,
    [payment.rows[0]!.id, refundProviderId]
  );
  const issue = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into financial_reconciliation_issues
       (resource_type, resource_id, safe_code, impact, first_observed_at,
        last_observed_at, correlation_id)
     values ('refund', $1, 'allocation_incomplete', 'pending',
             '2026-08-20T10:00:00.000Z', '2026-08-20T10:00:00.000Z', $2)
     returning id`,
    [refund.rows[0]!.id, token(`${label}_private_issue_correlation`)]
  );
  const payout = await ownerDatabaseClient.pool.query<{ id: string }>(
    `insert into stripe_payouts
       (provider_id, live_mode, amount_minor, currency, automatic, method, status,
        reconciliation_status, provider_created_at, arrival_at, retrieved_at,
        financial_generation, fingerprint_sha256)
     values ($1, false, 800, 'USD', true, 'standard', 'paid', 'completed',
             '2026-08-21T08:00:00.000Z', '2026-08-22T08:00:00.000Z',
             '2026-08-21T09:00:00.000Z', 1, repeat('c', 64))
     returning id`,
    [payoutProviderId]
  );

  return {
    actor,
    customerEmail,
    titleId,
    refundId: refund.rows[0]!.id,
    issueId: issue.rows[0]!.id,
    payoutId: payout.rows[0]!.id,
    providerValues: [
      chargeProviderId,
      paymentIntentProviderId,
      refundProviderId,
      payoutProviderId
    ],
    filters: parseSalesOverviewFilters(new URL(
      `https://books.example.test/admin/sales?range=all&titleId=${titleId}&sort=title_asc`
    ), NOW)
  };
}

async function auditCount(correlationId?: string): Promise<number> {
  const result = correlationId === undefined
    ? await ownerDatabaseClient.pool.query<{ count: number }>(
        `select count(*)::integer as count from audit_events`
      )
    : await ownerDatabaseClient.pool.query<{ count: number }>(
        `select count(*)::integer as count from audit_events where correlation_id = $1`,
        [correlationId]
      );
  return result.rows[0]!.count;
}

type TestQueryRow = Readonly<Record<string, unknown>>;

function databaseWithQueryRowMutation(
  mutate: (row: TestQueryRow) => TestQueryRow
): typeof databaseClient.db {
  return new Proxy(databaseClient.db, {
    get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver);
      return (
        callback: (transaction: DatabaseTransaction) => Promise<unknown>,
        config: unknown
      ) => target.transaction(async (transaction) => {
        const wrapped = new Proxy(transaction, {
          get(transactionTarget, transactionProperty, transactionReceiver) {
            if (transactionProperty !== 'execute') {
              return Reflect.get(transactionTarget, transactionProperty, transactionReceiver);
            }
            return async (query: Parameters<DatabaseTransaction['execute']>[0]) => {
              const result = await transaction.execute(query);
              const rows = result !== null && typeof result === 'object' &&
                'rows' in result && Array.isArray(result.rows)
                ? result.rows
                : [];
              return rows.length === 0
                ? result
                : {
                    ...result,
                    rows: rows.map((row) => row !== null && typeof row === 'object'
                      ? mutate(row as TestQueryRow)
                      : row)
                  };
            };
          }
        }) as DatabaseTransaction;
        return await callback(wrapped);
      }, config as never);
    }
  });
}

function databaseWithMalformedIssueDto(): typeof databaseClient.db {
  return databaseWithQueryRowMutation((row) => Object.hasOwn(row, 'issueId')
    ? { ...row, safeCode: 'private_future_issue_code' }
    : row);
}

function databaseWithOversizedSalesDto(): typeof databaseClient.db {
  const titleSuffix = String.fromCodePoint(30_028).repeat(295);
  const creatorSuffix = String.fromCodePoint(35_486).repeat(295);
  const variants = Array.from({ length: 6_200 }, (_, index) => ({
    title: `${String(index).padStart(5, '0')}${titleSuffix}`,
    creatorName: `${String(index).padStart(5, '0')}${creatorSuffix}`,
    format: 'prose'
  }));
  return databaseWithQueryRowMutation((row) => Object.hasOwn(row, 'soldAsVariants')
    ? { ...row, soldAsVariants: variants }
    : row);
}

function malformedCommand(kind: FinancialAdminPrivateCommand['kind']): FinancialAdminPrivateCommand {
  return { kind } as FinancialAdminPrivateCommand;
}

type ServiceInvocation = (
  actor: Actor,
  authorization: FinancialAuthorizationDependencies
) => Promise<unknown>;

interface CapabilitySurface {
  readonly name: string;
  readonly required: readonly AdminCapability[];
  readonly invoke: ServiceInvocation;
}

function capabilitySurfaces(): readonly CapabilitySurface[] {
  const invalidId = 'NOT-A-CANONICAL-UUID';
  const reportingRead: readonly CapabilitySurface[] = [
    {
      name: 'sales overview list',
      required: ['sales.read'],
      invoke: (actor, authorization) => listSalesOverview(
        databaseClient.db,
        actor,
        undefined as never,
        { ...authorization, stripeEnabled: false }
      )
    },
    {
      name: 'financial issue list',
      required: ['sales.read'],
      invoke: (actor, authorization) => listFinancialIssues(
        databaseClient.db, actor, undefined as never, authorization
      )
    },
    {
      name: 'financial issue detail',
      required: ['sales.read'],
      invoke: (actor, authorization) => getFinancialIssueDetail(
        databaseClient.db, actor, invalidId, REQUEST_CONTEXT, authorization
      )
    },
    {
      name: 'refund detail',
      required: ['sales.read'],
      invoke: (actor, authorization) => getRefundReviewDetail(
        databaseClient.db, actor, invalidId, REQUEST_CONTEXT, authorization
      )
    },
    {
      name: 'payout list',
      required: ['sales.read'],
      invoke: (actor, authorization) => listPayouts(
        databaseClient.db, actor, undefined as never, authorization
      )
    },
    {
      name: 'payout detail',
      required: ['sales.read'],
      invoke: (actor, authorization) => getPayoutDetail(
        databaseClient.db, actor, invalidId, REQUEST_CONTEXT, authorization
      )
    },
    {
      name: 'financial command status',
      required: ['sales.read'],
      invoke: (actor, authorization) => getFinancialAdminCommandStatus(
        databaseClient.db, actor, invalidId, authorization
      )
    }
  ];
  const management: readonly CapabilitySurface[] = [
    {
      name: 'refund finalization preview',
      required: ['sales.read', 'reconciliation.manage'],
      invoke: (actor, authorization) => previewRefundFinalization(
        databaseClient.db, actor, undefined as never, REQUEST_CONTEXT, authorization
      )
    },
    {
      name: 'reporting correction seed',
      required: ['sales.read', 'reconciliation.manage'],
      invoke: (actor, authorization) => getReportingCorrectionSeed(
        databaseClient.db, actor, invalidId, REQUEST_CONTEXT, authorization
      )
    },
    {
      name: 'reporting correction preview',
      required: ['sales.read', 'reconciliation.manage'],
      invoke: (actor, authorization) => previewReportingCorrection(
        databaseClient.db, actor, undefined as never, REQUEST_CONTEXT, authorization
      )
    },
    {
      name: 'administrative recovery seed',
      required: ['sales.read', 'reconciliation.manage'],
      invoke: (actor, authorization) => getAdministrativeRecoverySeed(
        databaseClient.db, actor, invalidId, REQUEST_CONTEXT, authorization
      )
    },
    {
      name: 'administrative recovery activation preview',
      required: ['sales.read', 'reconciliation.manage'],
      invoke: (actor, authorization) => previewAdministrativeRecovery(
        databaseClient.db, actor, undefined as never, REQUEST_CONTEXT, authorization
      )
    },
    {
      name: 'administrative recovery deactivation preview',
      required: ['sales.read', 'reconciliation.manage'],
      invoke: (actor, authorization) => previewAdministrativeRecoveryDeactivation(
        databaseClient.db, actor, undefined as never, REQUEST_CONTEXT, authorization
      )
    },
    ...FINANCIAL_ADMIN_COMMAND_KINDS.map((kind): CapabilitySurface => ({
      name: `${kind} submission`,
      required: ['sales.read', 'reconciliation.manage'],
      invoke: (actor, authorization) => submitFinancialAdminCommand(databaseClient.db, {
        actor: actor as AdministratorActor,
        idempotencyKey: randomUUID(),
        command: malformedCommand(kind),
        context: REQUEST_CONTEXT
      }, authorization)
    }))
  ];
  return [
    ...reportingRead,
    {
      name: 'sales CSV export',
      required: ['sales.read', 'sales.export'],
      invoke: (actor, authorization) => exportSalesCsv(
        databaseClient.db, actor, undefined as never, REQUEST_CONTEXT, authorization
      )
    },
    ...management
  ];
}

async function expectAuthorizationError(
  invocation: Promise<unknown>,
  code: 'unauthenticated' | 'forbidden'
): Promise<void> {
  await expect(invocation).rejects.toMatchObject({
    name: 'AuthorizationError',
    code,
    status: code === 'unauthenticated' ? 401 : 403
  });
}

async function expectPastAuthorization(invocation: Promise<unknown>): Promise<void> {
  const outcome = await invocation.then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  );
  if ('error' in outcome) {
    expect(outcome.error).not.toMatchObject({ name: 'AuthorizationError' });
  }
}

interface AuditBarrier {
  readonly blockerPid: number;
  readonly waiterApplicationName: string;
  release(): Promise<void>;
  cleanup(): Promise<void>;
}

async function installAuditBarrier(correlationId: string): Promise<AuditBarrier> {
  const suffix = randomUUID().replaceAll('-', '');
  const functionName = `test_financial_audit_barrier_${suffix}`;
  const triggerName = `zz_test_financial_audit_barrier_${suffix}`;
  const lockName = `test-financial-audit-barrier-${suffix}`;
  const waiterApplicationName = `test-financial-audit-waiter-${suffix}`;
  const blocker = await ownerDatabaseClient.pool.connect();
  let released = false;

  await ownerDatabaseClient.pool.query(`
    create function public."${functionName}"() returns trigger
    language plpgsql security invoker set search_path = 'pg_catalog'
    as $barrier$
    begin
      if new.correlation_id = '${correlationId}' then
        perform pg_catalog.set_config('application_name', '${waiterApplicationName}', true);
        perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('${lockName}'));
      end if;
      return new;
    end
    $barrier$;
    create trigger "${triggerName}" before insert on public.audit_events
    for each row execute function public."${functionName}"();
  `);
  try {
    await blocker.query('begin');
    await blocker.query(
      `select pg_catalog.set_config('application_name', $1, true)`,
      [`test-financial-audit-blocker-${suffix}`]
    );
    const pid = await blocker.query<{ pid: number }>(`select pg_backend_pid() as pid`);
    await blocker.query(
      `select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1))`,
      [lockName]
    );
    return {
      blockerPid: pid.rows[0]!.pid,
      waiterApplicationName,
      release: async () => {
        if (released) return;
        released = true;
        await blocker.query('commit');
      },
      cleanup: async () => {
        if (!released) {
          released = true;
          await blocker.query('rollback');
        }
        blocker.release();
        await ownerDatabaseClient.pool.query(
          `drop trigger if exists "${triggerName}" on public.audit_events`
        );
        await ownerDatabaseClient.pool.query(
          `drop function if exists public."${functionName}"()`
        );
      }
    };
  } catch (error) {
    await blocker.query('rollback').catch(() => undefined);
    blocker.release();
    await ownerDatabaseClient.pool.query(
      `drop trigger if exists "${triggerName}" on public.audit_events`
    );
    await ownerDatabaseClient.pool.query(
      `drop function if exists public."${functionName}"()`
    );
    throw error;
  }
}

async function waitForAuditBarrier(barrier: AuditBarrier): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const activity = await ownerDatabaseClient.pool.query<{
      pid: number;
      blockers: number[];
      wait_event_type: string | null;
      query: string;
    }>(
      `select pid, pg_catalog.pg_blocking_pids(pid) as blockers,
              wait_event_type, query
       from pg_catalog.pg_stat_activity
       where application_name = $1`,
      [barrier.waiterApplicationName]
    );
    const waiter = activity.rows[0];
    if (
      activity.rows.length === 1 &&
      waiter?.wait_event_type === 'Lock' &&
      waiter.blockers.includes(barrier.blockerPid)
    ) {
      expect(waiter.query).toMatch(/append_financial_(?:issue_view|sales_export)_audit/iu);
      expect(waiter.blockers).toEqual([barrier.blockerPid]);
      return;
    }
    await delay(10);
  }
  throw new Error('Timed out waiting for the financial audit commit barrier.');
}

async function installRejectingAuditTrigger(correlationId: string): Promise<() => Promise<void>> {
  const suffix = randomUUID().replaceAll('-', '');
  const functionName = `test_reject_financial_audit_${suffix}`;
  const triggerName = `zz_test_reject_financial_audit_${suffix}`;
  await ownerDatabaseClient.pool.query(`
    create function public."${functionName}"() returns trigger
    language plpgsql security invoker set search_path = 'pg_catalog'
    as $reject$
    begin
      if new.correlation_id = '${correlationId}' then
        raise exception using errcode = '55000', message = 'forced financial audit failure';
      end if;
      return new;
    end
    $reject$;
    create trigger "${triggerName}" before insert on public.audit_events
    for each row execute function public."${functionName}"();
  `);
  return async () => {
    await ownerDatabaseClient.pool.query(
      `drop trigger if exists "${triggerName}" on public.audit_events`
    );
    await ownerDatabaseClient.pool.query(
      `drop function if exists public."${functionName}"()`
    );
  };
}

describe('financial service capability matrix', () => {
  it('authorizes every service before path, filter, preview, or private command parsing', async () => {
    const customer = await createUser('matrix-customer', 'customer');
    const administrator = await createAdministrator('matrix-administrator');

    for (const surface of capabilitySurfaces()) {
      await expectAuthorizationError(
        surface.invoke({ type: 'anonymous' }, dependencies(ALL_FINANCIAL_CAPABILITIES)),
        'unauthenticated'
      );
      await expectAuthorizationError(
        surface.invoke(customer, dependencies([])),
        'forbidden'
      );
      for (const missing of surface.required) {
        const granted = ALL_FINANCIAL_CAPABILITIES.filter((value) => value !== missing);
        await expectAuthorizationError(
          surface.invoke(administrator, dependencies(granted)),
          'forbidden'
        );
      }
      await expectPastAuthorization(
        surface.invoke(administrator, dependencies(ALL_FINANCIAL_CAPABILITIES))
      );
    }
  });

  it.each(FINANCIAL_ADMIN_COMMAND_KINDS)(
    'rejects %s before parsing even a malformed idempotency key',
    async (kind) => {
      const administrator = await createAdministrator(`idempotency-${kind}`);
      await expectAuthorizationError(submitFinancialAdminCommand(databaseClient.db, {
        actor: administrator,
        idempotencyKey: 'PRIVATE-NONCANONICAL-IDEMPOTENCY-KEY',
        command: malformedCommand(kind),
        context: REQUEST_CONTEXT
      }, dependencies(['sales.read'])), 'forbidden');
      expect(await auditCount()).toBe(0);
    }
  );
});

describe('financial detail and export audit visibility', () => {
  it('leaves every list/filter/page unaudited and writes exactly one minimized audit per complete detail/export', async () => {
    const fixture = await createFinancialFixture('visibility');

    const overview = await listSalesOverview(
      databaseClient.db,
      fixture.actor,
      fixture.filters,
      { stripeEnabled: false }
    );
    const issues = await listFinancialIssues(databaseClient.db, fixture.actor, {
      pageSize: FINANCIAL_ISSUE_PAGE_SIZE
    });
    const payouts = await listPayouts(databaseClient.db, fixture.actor, {
      pageSize: PAYOUT_PAGE_SIZE
    });
    expect(overview.rows).toHaveLength(1);
    expect(issues.issues).toHaveLength(1);
    expect(payouts.payouts).toHaveLength(1);
    expect(await auditCount()).toBe(0);

    const correlations = {
      issue: token('financial_issue_detail'),
      refund: token('financial_refund_detail'),
      payout: token('financial_payout_detail'),
      export: token('financial_sales_export')
    } as const;
    const issue = await getFinancialIssueDetail(
      databaseClient.db,
      fixture.actor,
      fixture.issueId,
      {
        correlationId: correlations.issue,
        requestMetadata: { method: 'GET', routeId: '/admin/sales/review/[issueId]' }
      }
    );
    const refund = await getRefundReviewDetail(
      databaseClient.db,
      fixture.actor,
      fixture.refundId,
      {
        correlationId: correlations.refund,
        requestMetadata: { method: 'GET', routeId: '/admin/sales/refunds/[refundId]' }
      }
    );
    const payout = await getPayoutDetail(
      databaseClient.db,
      fixture.actor,
      fixture.payoutId,
      {
        correlationId: correlations.payout,
        requestMetadata: { method: 'GET', routeId: '/admin/sales/payouts/[payoutId]' }
      }
    );
    const exported = await exportSalesCsv(
      databaseClient.db,
      fixture.actor,
      fixture.filters,
      {
        correlationId: correlations.export,
        requestMetadata: { method: 'GET', routeId: '/admin/sales/export.csv' }
      }
    );
    expect(issue).not.toBeNull();
    expect(refund).not.toBeNull();
    expect(payout).not.toBeNull();
    expect(exported.rowCount).toBe(1);

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
      `select actor_id, action, outcome, resource_type, resource_id,
              correlation_id, request_metadata, before, after
       from audit_events order by action`
    );
    const fingerprint = fingerprintSalesFilters(fixture.filters);
    expect(audit.rows).toEqual([
      {
        actor_id: fixture.actor.id,
        action: 'financial.issue.view',
        outcome: 'succeeded',
        resource_type: 'financial_issue',
        resource_id: fixture.issueId,
        correlation_id: correlations.issue,
        request_metadata: {
          method: 'GET', route: `/admin/sales/issues/${fixture.issueId}`
        },
        before: null,
        after: null
      },
      {
        actor_id: fixture.actor.id,
        action: 'financial.payout.view',
        outcome: 'succeeded',
        resource_type: 'payout',
        resource_id: fixture.payoutId,
        correlation_id: correlations.payout,
        request_metadata: {
          method: 'GET', route: `/admin/sales/payouts/${fixture.payoutId}`
        },
        before: null,
        after: null
      },
      {
        actor_id: fixture.actor.id,
        action: 'financial.refund_review.view',
        outcome: 'succeeded',
        resource_type: 'refund',
        resource_id: fixture.refundId,
        correlation_id: correlations.refund,
        request_metadata: {
          method: 'GET', route: `/admin/sales/refunds/${fixture.refundId}`
        },
        before: null,
        after: null
      },
      {
        actor_id: fixture.actor.id,
        action: 'financial.sales_export',
        outcome: 'succeeded',
        resource_type: 'financial_sales_export',
        resource_id: fingerprint,
        correlation_id: correlations.export,
        request_metadata: {
          filterFingerprint: fingerprint,
          rowCount: 1,
          byteCount: exported.bytes.byteLength,
          currencyPairCount: 1,
          method: 'GET',
          route: '/admin/sales/export.csv'
        },
        before: null,
        after: null
      }
    ]);
    const serialized = JSON.stringify({ issue, refund, payout, audit: audit.rows });
    for (const privateValue of [fixture.customerEmail, ...fixture.providerValues]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('does not settle detail or export responses until their audit inserts can commit', async () => {
    const fixture = await createFinancialFixture('commit-coupling');
    const cases = [
      {
        label: 'detail',
        invoke: (correlationId: string) => getFinancialIssueDetail(
          databaseClient.db,
          fixture.actor,
          fixture.issueId,
          { correlationId }
        )
      },
      {
        label: 'export',
        invoke: (correlationId: string) => exportSalesCsv(
          databaseClient.db,
          fixture.actor,
          fixture.filters,
          { correlationId }
        )
      }
    ] as const;

    for (const testCase of cases) {
      const correlationId = token(`financial_${testCase.label}_commit_barrier`);
      const barrier = await installAuditBarrier(correlationId);
      let settled = false;
      const response = testCase.invoke(correlationId);
      void response.then(
        () => { settled = true; },
        () => { settled = true; }
      );
      try {
        await waitForAuditBarrier(barrier);
        expect(settled).toBe(false);
        expect(await auditCount(correlationId)).toBe(0);
        await barrier.release();
        await expect(response).resolves.not.toBeNull();
        expect(await auditCount(correlationId)).toBe(1);
      } finally {
        await barrier.cleanup();
      }
    }
  });
});

describe('financial response and audit rollback', () => {
  it('returns no detail and writes no audit when DTO validation fails', async () => {
    const fixture = await createFinancialFixture('dto-failure');
    const correlationId = token('financial_dto_failure');

    await expect(getFinancialIssueDetail(
      databaseWithMalformedIssueDto(),
      fixture.actor,
      fixture.issueId,
      { correlationId }
    )).rejects.toMatchObject({ name: 'FinancialReviewRepositoryError' });
    expect(await auditCount(correlationId)).toBe(0);
  });

  it('returns no oversized serialization and writes no export audit', async () => {
    const fixture = await createFinancialFixture('size-failure');
    const correlationId = token('financial_size_failure');

    await expect(exportSalesCsv(
      databaseWithOversizedSalesDto(),
      fixture.actor,
      fixture.filters,
      { correlationId }
    )).rejects.toMatchObject({
      name: 'SalesReportingInputError',
      code: 'invalid_request',
      status: 400
    });
    expect(await auditCount(correlationId)).toBe(0);
  });

  it('returns no bytes and writes no audit when the generation deadline expires', async () => {
    const fixture = await createFinancialFixture('deadline-failure');
    const correlationId = token('financial_deadline_failure');
    const monotonicNow = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValue(SALES_CSV_DEADLINE_MS);

    await expect(exportSalesCsv(
      databaseClient.db,
      fixture.actor,
      fixture.filters,
      { correlationId },
      { monotonicNow }
    )).rejects.toMatchObject({
      name: 'SalesReportingInputError',
      code: 'invalid_request',
      status: 400
    });
    expect(await auditCount(correlationId)).toBe(0);
  });

  it('returns no detail and commits no audit when the fixed audit insert fails', async () => {
    const fixture = await createFinancialFixture('audit-failure');
    const correlationId = token('financial_forced_audit_failure');
    const cleanup = await installRejectingAuditTrigger(correlationId);
    try {
      await expect(getFinancialIssueDetail(
        databaseClient.db,
        fixture.actor,
        fixture.issueId,
        { correlationId }
      )).rejects.toMatchObject({ name: 'FinancialReportingAuditError' });
      expect(await auditCount(correlationId)).toBe(0);
    } finally {
      await cleanup();
    }
  });
});
