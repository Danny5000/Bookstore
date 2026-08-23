import { randomBytes, randomUUID } from 'node:crypto';
import { asc, count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Actor, AdministratorActor } from '$lib/server/auth/admin-policy';
import {
  FINANCIAL_ADMIN_COMMAND_JOB,
  FinancialAdminConflictError,
  createFinancialAdminCommandHandler,
  type FinancialAdminCommandExecutor
} from '$lib/server/commerce/financial/admin-commands/handler';
import {
  getAuditEventDetail,
  listAuditEvents,
  parseAuditFilters
} from '$lib/server/audit/query';
import { submitFinancialAdminCommand } from '$lib/server/commerce/financial/admin-commands/repository';
import { auditEvents } from '$lib/server/db/schema';
import { createPostgresJobRepository } from '$lib/server/jobs/repository';
import { FINANCIAL_ADMIN_COMMAND_KINDS } from '$lib/types/financial-reporting';
import {
  applicationConfig,
  databaseClient,
  ownerDatabaseClient,
  workerDatabaseClient
} from './database';

const admin: Actor = { type: 'user', id: randomUUID(), roles: ['admin'] };
const customer: Actor = { type: 'user', id: randomUUID(), roles: ['customer'] };

function row(overrides: Partial<typeof auditEvents.$inferInsert> = {}): typeof auditEvents.$inferInsert {
  return {
    id: randomUUID(),
    occurredAt: new Date('2026-08-09T12:00:00.000Z'),
    actorType: 'user',
    actorId: admin.type === 'user' ? admin.id : 'admin',
    action: 'catalog.title.update',
    outcome: 'succeeded',
    resourceType: 'title',
    resourceId: randomUUID(),
    correlationId: randomUUID(),
    ...overrides
  };
}

describe('audit browsing queries', () => {
  it('paginates tied timestamps newest-first without gaps or duplicates', async () => {
    const inserted = [
      row({ occurredAt: new Date('2026-08-09T13:00:00Z') }),
      row(), row(), row(),
      row({ occurredAt: new Date('2026-08-09T11:00:00Z') })
    ];
    await databaseClient.db.insert(auditEvents).values(inserted);
    const expected = [...inserted].sort((left, right) => {
      const time = right.occurredAt!.getTime() - left.occurredAt!.getTime();
      return time || String(right.id).localeCompare(String(left.id));
    }).map((event) => event.id);

    const collected: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listAuditEvents(databaseClient.db, admin, parseAuditFilters(
        new URLSearchParams({ pageSize: '2', ...(cursor ? { cursor } : {}) })
      ));
      for (const event of page.events) {
        collected.push(event.id);
        expect(event).not.toHaveProperty('before');
        expect(event).not.toHaveProperty('after');
        expect(event).not.toHaveProperty('requestMetadata');
      }
      cursor = page.nextCursor;
    } while (cursor);

    expect(collected).toEqual(expected);
    expect(new Set(collected).size).toBe(inserted.length);
  });

  it('combines every supplied filter with AND semantics and does not audit listing', async () => {
    const resourceId = randomUUID();
    const matching = row({ resourceId });
    await databaseClient.db.insert(auditEvents).values([
      matching,
      row({ resourceId, action: 'catalog.title.create' }),
      row({ resourceId: randomUUID(), outcome: 'failed' }),
      row({ actorId: customer.type === 'user' ? customer.id : 'customer' })
    ]);
    const filters = parseAuditFilters(new URLSearchParams({
      actorId: matching.actorId!,
      action: matching.action,
      resourceType: matching.resourceType,
      resourceId,
      outcome: matching.outcome!,
      from: '2026-08-09T11:59:00Z',
      to: '2026-08-09T12:01:00Z',
      pageSize: '50'
    }));
    const result = await listAuditEvents(databaseClient.db, admin, filters);
    expect(result.events.map((event) => event.id)).toEqual([matching.id]);
    const [total] = await databaseClient.db.select({ value: count() }).from(auditEvents);
    expect(total?.value).toBe(4);
  });

  it('authorizes and audits sanitized detail access without recursive behavior', async () => {
    const [source] = await databaseClient.db.insert(auditEvents).values(row({
      requestMetadata: { routeId: '/admin', authorization: 'unsafe' },
      before: { title: 'Before', password: 'unsafe' },
      after: { title: 'After', token: 'unsafe' }
    })).returning();
    if (!source) throw new Error('Expected audit source');

    await expect(getAuditEventDetail(databaseClient.db, {
      actor: customer, eventId: source.id, correlationId: 'denied'
    })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(getAuditEventDetail(databaseClient.db, {
      actor: admin, eventId: randomUUID(), correlationId: 'missing'
    })).resolves.toBeNull();

    const detail = await getAuditEventDetail(databaseClient.db, {
      actor: admin, eventId: source.id, correlationId: 'view-source'
    });
    expect(detail).toMatchObject({
      id: source.id,
      requestMetadata: { routeId: '/admin', authorization: '[redacted]' },
      before: { title: 'Before', password: '[redacted]' },
      after: { title: 'After', token: '[redacted]' }
    });
    const views = await databaseClient.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'audit.event.view'))
      .orderBy(asc(auditEvents.occurredAt));
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      resourceType: 'audit_event',
      resourceId: source.id,
      correlationId: 'view-source',
      after: { viewedEventId: source.id }
    });

    await getAuditEventDetail(databaseClient.db, {
      actor: admin, eventId: views[0]!.id, correlationId: 'view-the-view'
    });
    const [total] = await databaseClient.db.select({ value: count() }).from(auditEvents);
    expect(total?.value).toBe(3);
  });

  it('exposes customer download audits through the existing admin filters and detail view', async () => {
    const titleId = randomUUID();
    const revisionId = randomUUID();
    const customerId = randomUUID();
    const [download] = await databaseClient.db
      .insert(auditEvents)
      .values(
        row({
          actorId: customerId,
          action: 'library.original.download',
          resourceType: 'title_revision',
          resourceId: revisionId,
          correlationId: 'download-correlation',
          after: { titleId, activeRevisionId: revisionId, range: false }
        })
      )
      .returning();
    if (!download) throw new Error('Expected download event');

    const page = await listAuditEvents(
      databaseClient.db,
      admin,
      parseAuditFilters(
        new URLSearchParams({
          actorId: customerId,
          action: 'library.original.download',
          resourceType: 'title_revision',
          resourceId: revisionId
        })
      )
    );
    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({ id: download.id, correlationId: 'download-correlation' });
    expect(page.events[0]).not.toHaveProperty('after');

    const detail = await getAuditEventDetail(databaseClient.db, {
      actor: admin,
      eventId: download.id,
      correlationId: 'view-download'
    });
    expect(detail).toMatchObject({
      requestMetadata: null,
      after: { titleId, activeRevisionId: revisionId, range: false }
    });
  });

  it('exposes only fixed minimized financial detail/export audit metadata', async () => {
    const privateEmail = `private-audit-${randomUUID()}@example.test`;
    const privateProviderId = `ch_private_${randomUUID().replaceAll('-', '')}`;
    const privateIdempotencyKey = randomUUID();
    const privateCommand = {
      kind: 'refund_draft_save',
      refundId: randomUUID(),
      expectedVersion: null,
      items: [{ orderItemId: randomUUID(), totalPresentmentMinor: 725 }]
    } as const;
    const privateCommandPayload = JSON.stringify(privateCommand);
    await ownerDatabaseClient.pool.query(
      `insert into "user" (id, name, email, email_verified)
       values ($1, 'Audit query administrator', $2, true)`,
      [admin.type === 'user' ? admin.id : randomUUID(), privateEmail]
    );
    await ownerDatabaseClient.pool.query(
      `insert into user_roles (user_id, role) values ($1, 'admin')`,
      [admin.type === 'user' ? admin.id : randomUUID()]
    );
    const storedPayout = await ownerDatabaseClient.pool.query<{ id: string }>(
      `insert into stripe_payouts
         (provider_id, live_mode, amount_minor, currency, automatic, method, status,
          reconciliation_status, provider_created_at, arrival_at, retrieved_at,
          financial_generation, fingerprint_sha256)
       values ($1, false, 100, 'USD', false, 'standard', 'pending', 'not_applicable',
               '2026-08-09T10:00:00.000Z', '2026-08-10T10:00:00.000Z',
               '2026-08-09T11:00:00.000Z', 1, repeat('a', 64))
       returning id`,
      [privateProviderId]
    );
    const commandCorrelation = `private-command-${randomUUID()}`;
    const submittedCommand = await submitFinancialAdminCommand(databaseClient.db, {
      actor: admin as AdministratorActor,
      idempotencyKey: privateIdempotencyKey,
      command: privateCommand,
      context: { correlationId: commandCorrelation }
    });
    const leaseCapability = randomBytes(32).toString('base64url');
    const commandRepository = createPostgresJobRepository(
      workerDatabaseClient.db,
      { ...applicationConfig.jobs, leaseMs: 5_000 },
      undefined,
      'local-only',
      { classifierVersion: 1, allocationAlgorithmVersion: 1 },
      () => leaseCapability
    );
    const conflictExecutors = new Map(FINANCIAL_ADMIN_COMMAND_KINDS.map((kind) => {
      const executor: FinancialAdminCommandExecutor = async () => {
        throw new FinancialAdminConflictError('stale_state');
      };
      return [kind, executor] as const;
    }));
    const commandHandler = createFinancialAdminCommandHandler({
      database: workerDatabaseClient.db,
      executors: conflictExecutors,
      accessMessages: {
        enqueueAccessChange: async () => undefined
      }
    });
    const commandWorkerId = `audit-query-terminal-${randomUUID()}`;
    const commandJob = await commandRepository.claimNext(commandWorkerId);
    expect(commandJob).toMatchObject({
      type: FINANCIAL_ADMIN_COMMAND_JOB,
      payload: { commandId: submittedCommand.commandId },
      financialAdminLeaseCapability: leaseCapability
    });
    if (!commandJob?.financialAdminLeaseCapability) {
      throw new Error('Expected a claimed financial administrator command');
    }
    await expect(
      commandHandler(commandJob, new AbortController().signal)
    ).rejects.toThrow('Financial administrator command conflicted with current state.');
    await expect(commandRepository.fail(
      commandJob.id,
      commandWorkerId,
      'Financial administrator command conflicted with current state.',
      false,
      commandJob.financialAdminLeaseCapability
    )).resolves.toBe(true);

    const issueId = randomUUID();
    const refundId = randomUUID();
    const payoutId = storedPayout.rows[0]!.id;
    const fingerprint = 'd'.repeat(64);
    const issueCorrelation = `audit-financial-issue-${randomUUID()}`;
    const refundCorrelation = `audit-financial-refund-${randomUUID()}`;
    const payoutCorrelation = `audit-financial-payout-${randomUUID()}`;
    const exportCorrelation = `audit-financial-export-${randomUUID()}`;
    const sources = [
      {
        correlationId: issueCorrelation,
        action: 'financial.issue.view',
        resourceType: 'financial_issue',
        resourceId: issueId,
        requestMetadata: {
          method: 'GET', route: `/admin/sales/issues/${issueId}`
        },
        append: () => databaseClient.pool.query(
          `select public.append_financial_issue_view_audit($1::uuid, $2::uuid, $3, 'GET', $4)`,
          [admin.type === 'user' ? admin.id : null, issueId,
            issueCorrelation, `/admin/sales/issues/${issueId}`]
        )
      },
      {
        correlationId: refundCorrelation,
        action: 'financial.refund_review.view',
        resourceType: 'refund',
        resourceId: refundId,
        requestMetadata: {
          method: 'GET', route: `/admin/sales/refunds/${refundId}`
        },
        append: () => databaseClient.pool.query(
          `select public.append_financial_refund_review_view_audit($1::uuid, $2::uuid, $3, 'GET', $4)`,
          [admin.type === 'user' ? admin.id : null, refundId,
            refundCorrelation, `/admin/sales/refunds/${refundId}`]
        )
      },
      {
        correlationId: payoutCorrelation,
        action: 'financial.payout.view',
        resourceType: 'payout',
        resourceId: payoutId,
        requestMetadata: {
          method: 'GET', route: `/admin/sales/payouts/${payoutId}`
        },
        append: () => databaseClient.pool.query(
          `select public.append_financial_payout_view_audit($1::uuid, $2::uuid, $3, 'GET', $4)`,
          [admin.type === 'user' ? admin.id : null, payoutId,
            payoutCorrelation, `/admin/sales/payouts/${payoutId}`]
        )
      },
      {
        correlationId: exportCorrelation,
        action: 'financial.sales_export',
        resourceType: 'financial_sales_export',
        resourceId: fingerprint,
        requestMetadata: {
          filterFingerprint: fingerprint,
          rowCount: 7,
          byteCount: 4096,
          currencyPairCount: 2,
          method: 'GET',
          route: '/admin/sales/export.csv'
        },
        append: () => databaseClient.pool.query(
          `select public.append_financial_sales_export_audit(
             $1::uuid, $2, $3, 7, 4096, 2, 'GET', '/admin/sales/export.csv'
          )`,
          [admin.type === 'user' ? admin.id : null, fingerprint,
            exportCorrelation]
        )
      }
    ] as const;

    const expected = [] as Array<{
      action: string;
      resourceType: string;
      resourceId: string;
      correlationId: string;
      requestMetadata: Record<string, unknown>;
    }>;
    for (const source of sources) {
      await source.append();
      const inserted = await ownerDatabaseClient.pool.query<{
        correlation_id: string;
      }>(
        `select correlation_id from audit_events
         where action = $1 and resource_id = $2`,
        [source.action, source.resourceId]
      );
      expected.push({
        action: source.action,
        resourceType: source.resourceType,
        resourceId: source.resourceId,
        correlationId: source.correlationId,
        requestMetadata: source.requestMetadata
      });
      expect(inserted.rows).toEqual([{ correlation_id: source.correlationId }]);
    }

    const details = [];
    for (const source of expected) {
      const page = await listAuditEvents(
        databaseClient.db,
        admin,
        parseAuditFilters(new URLSearchParams({
          action: source.action,
          resourceType: source.resourceType,
          resourceId: source.resourceId
        }))
      );
      expect(page.events).toEqual([expect.objectContaining({
        action: source.action,
        resourceType: source.resourceType,
        resourceId: source.resourceId,
        correlationId: source.correlationId
      })]);
      expect(page.events[0]).not.toHaveProperty('requestMetadata');
      expect(page.events[0]).not.toHaveProperty('before');
      expect(page.events[0]).not.toHaveProperty('after');

      const detail = await getAuditEventDetail(databaseClient.db, {
        actor: admin,
        eventId: page.events[0]!.id,
        correlationId: `view-${source.action.replaceAll('.', '-')}`
      });
      expect(detail).toMatchObject({
        action: source.action,
        resourceType: source.resourceType,
        resourceId: source.resourceId,
        requestMetadata: source.requestMetadata,
        before: null,
        after: null
      });
      expect(Object.keys(detail!.requestMetadata as object).sort()).toEqual(
        Object.keys(source.requestMetadata).sort()
      );
      expect(Object.keys(detail!).sort()).toEqual([
        'action',
        'actorId',
        'actorType',
        'after',
        'before',
        'correlationId',
        'id',
        'occurredAt',
        'outcome',
        'requestMetadata',
        'resourceId',
        'resourceType'
      ].sort());
      details.push(detail);
    }

    const commandPage = await listAuditEvents(
      databaseClient.db,
      admin,
      parseAuditFilters(new URLSearchParams({
        action: 'financial.admin_command.conflict',
        resourceType: 'financial_admin_command',
        resourceId: submittedCommand.commandId
      }))
    );
    expect(commandPage.events).toEqual([expect.objectContaining({
      actorType: 'user',
      actorId: admin.type === 'user' ? admin.id : null,
      action: 'financial.admin_command.conflict',
      outcome: 'failed',
      resourceType: 'financial_admin_command',
      resourceId: submittedCommand.commandId,
      correlationId: commandCorrelation
    })]);
    expect(commandPage.events[0]).not.toHaveProperty('requestMetadata');
    expect(commandPage.events[0]).not.toHaveProperty('before');
    expect(commandPage.events[0]).not.toHaveProperty('after');
    const commandDetail = await getAuditEventDetail(databaseClient.db, {
      actor: admin,
      eventId: commandPage.events[0]!.id,
      correlationId: `view-financial-command-${randomUUID()}`
    });
    expect(commandDetail).toMatchObject({
      actorType: 'user',
      actorId: admin.type === 'user' ? admin.id : null,
      action: 'financial.admin_command.conflict',
      outcome: 'failed',
      resourceType: 'financial_admin_command',
      resourceId: submittedCommand.commandId,
      correlationId: commandCorrelation,
      requestMetadata: null,
      before: null,
      after: {
        commandKind: 'refund_draft_save',
        safeResultCode: 'stale_state'
      }
    });
    expect(Object.keys(commandDetail!.after as object).sort()).toEqual([
      'commandKind',
      'safeResultCode'
    ]);
    expect(Object.keys(commandDetail!).sort()).toEqual([
      'action',
      'actorId',
      'actorType',
      'after',
      'before',
      'correlationId',
      'id',
      'occurredAt',
      'outcome',
      'requestMetadata',
      'resourceId',
      'resourceType'
    ].sort());

    const serialized = JSON.stringify({
      expected,
      details,
      commandPage,
      commandDetail,
      pages: await Promise.all(expected.map((source) => listAuditEvents(
        databaseClient.db,
        admin,
        parseAuditFilters(new URLSearchParams({ action: source.action }))
      )))
    });
    for (const privateValue of [
      privateEmail,
      privateProviderId,
      privateCommandPayload,
      privateIdempotencyKey,
      privateCommand.refundId,
      privateCommand.items[0]!.orderItemId
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(serialized).not.toMatch(
      /privateInput|commandPayload|payload|idempotencyKey|jobId|attempts|lastError|capability|generation|expiresAt|providerId|email|arbitrary/iu
    );
  });
});
