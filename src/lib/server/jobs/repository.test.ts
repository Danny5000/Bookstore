import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { JobRow } from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { createFinancialSourceScanJob } from '$lib/server/commerce/financial/jobs';
import { enqueueActiveEntityJob } from './repository';

const SOURCE_ID = '00000000-0000-4000-8000-000000001611';
const NOW = new Date('2026-08-12T12:00:00.000Z');

function jobRow(overrides: Partial<JobRow> = {}): JobRow {
  return {
    id: '00000000-0000-4000-8000-000000001612',
    type: 'commerce.financial-source',
    payload: {
      sourceKind: 'refund', sourceId: SOURCE_ID,
      trigger: { kind: 'event', providerEventId: 'evt_repository_1611' }
    },
    deduplicationKey: 'stripe:financial-source:event:evt_repository_1611',
    status: 'pending',
    runAt: NOW,
    attempts: 0,
    maxAttempts: 12,
    lockedAt: null,
    lockedBy: null,
    lastError: null,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

function transaction(responses: readonly unknown[][]): {
  readonly calls: SQL[];
  readonly transaction: DatabaseTransaction;
} {
  const calls: SQL[] = [];
  let index = 0;
  return {
    calls,
    transaction: {
      rollback: vi.fn(() => { throw new Error('rollback should not be called'); }),
      execute: vi.fn(async (query: SQL) => {
        calls.push(query);
        return { rows: responses[index++] ?? [] };
      })
    } as never
  };
}

function sourceInput(activeEntity: {
  sourceKind: 'payment' | 'refund' | 'dispute';
  sourceId: string;
} = {
  sourceKind: 'refund', sourceId: SOURCE_ID
}) {
  return {
    type: 'commerce.financial-source' as const,
    payload: {
      sourceKind: 'refund', sourceId: SOURCE_ID,
      trigger: { kind: 'event', providerEventId: 'evt_repository_1611' }
    },
    deduplicationKey: 'stripe:financial-source:event:evt_repository_1611',
    maxAttempts: 12,
    activeEntity
  };
}

function rendered(query: SQL): { sql: string; params: unknown[] } {
  return query.toQuery({
    casing: {} as never,
    escapeName: (name) => `"${name}"`,
    escapeParam: (index) => `$${index + 1}`,
    escapeString: (value) => `'${value}'`
  });
}

describe('active entity jobs', () => {
  async function expectSafeInvalid(input: unknown): Promise<void> {
    const database = transaction([]);
    const failure = await enqueueActiveEntityJob(database.transaction, input as never)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toHaveProperty('cause');
    expect(String(failure)).not.toContain('private-canary');
    expect(database.calls).toHaveLength(0);
  }

  it('returns the exact permanent-dedupe row before considering another active generation', async () => {
    const exact = jobRow({
      status: 'succeeded', completedAt: NOW
    });
    const database = transaction([[], [exact]]);

    await expect(enqueueActiveEntityJob(database.transaction, sourceInput()))
      .resolves.toEqual(exact);
    expect(database.calls).toHaveLength(2);
    expect(rendered(database.calls[1]!).sql).toContain('deduplication_key');
  });

  it('fails closed when a permanent key resolves to a different job identity', async () => {
    const collision = jobRow({
      payload: {
        sourceKind: 'refund',
        sourceId: '00000000-0000-4000-8000-000000001699',
        trigger: { kind: 'event', providerEventId: 'evt_repository_1611' }
      }
    });
    const database = transaction([[], [collision]]);

    let failure: unknown;
    try {
      await enqueueActiveEntityJob(database.transaction, sourceInput());
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toHaveProperty('cause');
    expect(String(failure)).not.toContain('00000000-0000-4000-8000-000000001699');
    expect(database.calls).toHaveLength(2);
  });

  it('uses a JSON subset to return the existing pending or running entity job', async () => {
    const active = jobRow({ status: 'running', attempts: 1, lockedAt: NOW, lockedBy: 'worker-a' });
    const database = transaction([[], [], [active]]);
    const scan = createFinancialSourceScanJob({
      sourceKind: 'refund',
      sourceId: SOURCE_ID,
      scanRunId: '00000000-0000-4000-8000-000000001613',
      scanGenerationHour: '2026-08-12T12:00:00.000Z'
    });

    await expect(enqueueActiveEntityJob(database.transaction, {
      ...scan,
      activeEntity: { sourceKind: scan.payload.sourceKind, sourceId: scan.payload.sourceId }
    })).resolves.toEqual(active);

    const activeQuery = rendered(database.calls[2]!);
    expect(activeQuery.sql).toContain("status in ('pending', 'running')");
    expect(activeQuery.sql).toContain('payload @>');
    expect(activeQuery.sql).toContain('order by created_at, id');
    expect(activeQuery.params).toContain(JSON.stringify({ sourceId: SOURCE_ID, sourceKind: 'refund' }));
  });

  it('derives one code-point-canonical advisory identity independent of object insertion order', async () => {
    const first = transaction([[], [], [jobRow()]]);
    const second = transaction([[], [], [jobRow()]]);
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare')
      .mockImplementation(() => { throw new Error('locale ordering is not deterministic'); });
    try {
      await enqueueActiveEntityJob(first.transaction, sourceInput({
        sourceKind: 'refund', sourceId: SOURCE_ID
      }));
      await enqueueActiveEntityJob(second.transaction, sourceInput({
        sourceId: SOURCE_ID, sourceKind: 'refund'
      }));
    } finally {
      localeCompare.mockRestore();
    }

    const firstKey = rendered(first.calls[0]!).params[0];
    const secondKey = rendered(second.calls[0]!).params[0];
    expect(firstKey).toBe(secondKey);
    expect(firstKey).toBe(
      'pale-orbit:jobs:active-entity:commerce.financial-source:' +
      JSON.stringify({ sourceId: SOURCE_ID, sourceKind: 'refund' })
    );
  });

  it('fails closed before SQL when entity identity is mismatched, nonfinancial, or private', async () => {
    const database = transaction([]);
    const inheritedEntity = Object.create({ email: 'private@example.com' });
    Object.assign(inheritedEntity, { sourceKind: 'refund', sourceId: SOURCE_ID });
    const inheritedTrigger = Object.create({ email: 'private@example.com' });
    Object.assign(inheritedTrigger, { kind: 'event', providerEventId: 'evt_repository_1611' });
    for (const input of [
      sourceInput({ sourceKind: 'payment', sourceId: SOURCE_ID }),
      { ...sourceInput(), type: 'commerce.email' },
      { ...sourceInput(), activeEntity: {
        sourceKind: 'refund', sourceId: SOURCE_ID, email: 'private@example.com'
      } },
      { ...sourceInput(), activeEntity: inheritedEntity },
      {
        ...sourceInput(),
        payload: { sourceKind: 'refund', sourceId: SOURCE_ID, trigger: inheritedTrigger }
      }
    ]) {
      let failure: unknown;
      try {
        await enqueueActiveEntityJob(database.transaction, input as never);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toHaveProperty('cause');
      expect(String(failure)).not.toContain('private@example.com');
    }
    expect(database.calls).toHaveLength(0);
  });

  it('validates the complete canonical Task 7 identity before SQL', async () => {
    const privateSymbol = Symbol('private-canary');
    const cases: unknown[] = [
      { ...sourceInput(), payload: { ...sourceInput().payload, privateField: 'private-canary' } },
      { ...sourceInput(), payload: { ...sourceInput().payload, [privateSymbol]: 'private-canary' } },
      { ...sourceInput(), payload: {
        ...sourceInput().payload, trigger: { kind: 'bogus', providerEventId: 'private-canary' }
      } },
      { ...sourceInput(), maxAttempts: 11 },
      { ...sourceInput(), deduplicationKey: 'private-canary' },
      { ...sourceInput(), runAt: new Date(Number.NaN) },
      { ...sourceInput(), privateField: 'private-canary' }
    ];
    for (const input of cases) await expectSafeInvalid(input);
  });

  it('accepts every canonical UUID version accepted by Task 7', async () => {
    const sourceId = '00000000-0000-7000-8000-000000000001';
    const input = {
      ...sourceInput(),
      payload: {
        sourceKind: 'refund' as const,
        sourceId,
        trigger: { kind: 'event' as const, providerEventId: 'evt_repository_uuid_v7' }
      },
      deduplicationKey: 'stripe:financial-source:event:evt_repository_uuid_v7',
      activeEntity: { sourceKind: 'refund' as const, sourceId }
    };
    const exact = jobRow({
      payload: input.payload,
      deduplicationKey: input.deduplicationKey
    });
    const database = transaction([[], [exact]]);
    await expect(enqueueActiveEntityJob(database.transaction, input)).resolves.toEqual(exact);
    expect(rendered(database.calls[0]!).params[0]).toContain(sourceId);
  });

  it('rejects a base database executor before taking a statement-scoped advisory lock', async () => {
    const execute = vi.fn();
    const failure = await enqueueActiveEntityJob({ execute } as never, sourceInput())
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toHaveProperty('cause');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a malformed active row instead of suppressing canonical work', async () => {
    const malformed = jobRow({
      deduplicationKey: 'private-canary',
      payload: { ...jobRow().payload, privateField: 'private-canary' }
    });
    const database = transaction([[], [], [malformed]]);
    const failure = await enqueueActiveEntityJob(database.transaction, {
      ...sourceInput(),
      deduplicationKey:
        'financial:source:scan:refund:' + SOURCE_ID + ':2026-08-12T12:00:00.000Z'
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toHaveProperty('cause');
    expect(String(failure)).not.toContain('private-canary');
  });
});
