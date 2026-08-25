import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import { applicationRateLimits } from '$lib/server/db/schema';
import type { DatabaseExecutor } from '$lib/server/db/transaction';
import {
  InvalidRateLimitInputError,
  cleanupExpiredRateLimits,
  consumeRateLimit,
  rateLimitScopeDigest
} from './rate-limit';

const dialect = new PgDialect();
const validDigest = 'a'.repeat(64);
const validNamespace = 'shared.rate-limit';
const user = {
  type: 'user',
  id: '00000000-0000-4000-8000-000000000001',
  roles: ['customer']
} satisfies Actor;

function normalizedSql(statement: SQL): { sql: string; params: unknown[] } {
  const compiled = dialect.sqlToQuery(statement);
  return {
    sql: compiled.sql.replaceAll(/\s+/gu, ' ').trim(),
    params: compiled.params
  };
}

function expectInvalidRateLimitInput(error: unknown, rejectedInput?: string): void {
  expect(error).toBeInstanceOf(InvalidRateLimitInputError);
  expect(error).toMatchObject({
    code: 'invalid_rate_limit_input',
    message: 'Rate-limit input is invalid.',
    name: 'InvalidRateLimitInputError'
  });
  if (rejectedInput) expect(JSON.stringify(error)).not.toContain(rejectedInput);
}

function captureThrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected action to throw');
}

async function captureRejected(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected action to reject');
}

interface FakeExecutorOptions {
  readonly count?: number | null;
  readonly deleted?: number;
}

interface InsertedRateLimit {
  readonly namespace: string;
  readonly scopeSha256: string;
  readonly windowStart: Date;
  readonly count: number;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface ConflictUpdate {
  readonly target: readonly unknown[];
  readonly set: { readonly count: SQL; readonly updatedAt: Date };
}

function fakeExecutor(options: FakeExecutorOptions = {}) {
  const returning = vi.fn(async (_selection: unknown) =>
    options.count === null ? [] : [{ count: options.count ?? 1 }]
  );
  const onConflictDoUpdate = vi.fn((_update: ConflictUpdate) => ({ returning }));
  const values = vi.fn((_value: InsertedRateLimit) => ({ onConflictDoUpdate }));
  const insert = vi.fn((_table: unknown) => ({ values }));
  const execute = vi.fn(async (_statement: SQL) => ({
    rows: Array.from({ length: options.deleted ?? 0 }, () => ({ deleted: 1 }))
  }));
  return {
    database: { insert, execute } as unknown as DatabaseExecutor,
    execute,
    insert,
    onConflictDoUpdate,
    returning,
    values
  };
}

describe('shared rate-limit scope digest', () => {
  it('hashes the exact authenticated user scope independently of IP and secret', () => {
    const digest = rateLimitScopeDigest({
      actor: user,
      requestIp: '198.51.100.10',
      applicationSecret: 'test-only-application-secret-123456789'
    });

    expect(digest).toBe(createHash('sha256').update(`user:${user.id}`, 'utf8').digest('hex'));
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(digest).toHaveLength(64);
    expect(digest).not.toContain(user.id);
    expect(
      rateLimitScopeDigest({
        actor: user,
        requestIp: '203.0.113.22',
        applicationSecret: 'different-secret-that-does-not-matter'
      })
    ).toBe(digest);
  });

  it('HMACs the exact trimmed anonymous IP with the untrimmed application secret', () => {
    const requestIp = ' 198.51.100.10 ';
    const applicationSecret = ' secret-with-significant-surrounding-whitespace ';
    const digest = rateLimitScopeDigest({
      actor: { type: 'anonymous' },
      requestIp,
      applicationSecret
    });

    expect(digest).toBe(
      createHmac('sha256', applicationSecret).update('ip:198.51.100.10', 'utf8').digest('hex')
    );
    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(digest).not.toContain('198.51.100.10');
    expect(
      rateLimitScopeDigest({
        actor: { type: 'anonymous' },
        requestIp: '198.51.100.10',
        applicationSecret: '   '
      })
    ).toBe(createHmac('sha256', '   ').update('ip:198.51.100.10', 'utf8').digest('hex'));
  });

  it.each([
    { actor: { type: 'anonymous' } as Actor, label: 'anonymous' },
    { actor: { type: 'guest', id: 'unused-guest-id' } as Actor, label: 'guest' },
    { actor: { type: 'system', id: 'unused-system-id' } as Actor, label: 'system' }
  ])('uses the same non-user IP-HMAC branch for $label actors', ({ actor }) => {
    const input = {
      actor,
      requestIp: ' 203.0.113.8 ',
      applicationSecret: 'shared-non-user-secret'
    };
    expect(rateLimitScopeDigest(input)).toBe(
      createHmac('sha256', input.applicationSecret)
        .update('ip:203.0.113.8', 'utf8')
        .digest('hex')
    );
  });

  it.each([
    { requestIp: '', applicationSecret: 'secret', rejectedInput: undefined },
    { requestIp: ' private-ip-marker ', applicationSecret: '', rejectedInput: 'private-ip-marker' },
    { requestIp: '   ', applicationSecret: 'secret', rejectedInput: undefined }
  ])('rejects an invalid anonymous scope without echoing it: %#', (input) => {
    const error = captureThrown(() =>
      rateLimitScopeDigest({ actor: { type: 'anonymous' }, ...input })
    );
    expectInvalidRateLimitInput(error, input.rejectedInput);
  });

  it('has no dependency on the commerce layer', () => {
    const source = readFileSync(new URL('./rate-limit.ts', import.meta.url), 'utf8').replaceAll(
      '\r\n',
      '\n'
    );
    const importSpecifiers = Array.from(
      source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/gu),
      (match) => match[1]
    );
    expect(importSpecifiers.some((specifier) => specifier?.includes('/commerce/'))).toBe(false);
    expect(importSpecifiers.some((specifier) => specifier?.startsWith('../commerce'))).toBe(false);
  });
});

describe('shared rate-limit validation', () => {
  it.each([
    { field: 'namespace', value: '' },
    { field: 'namespace', value: 'Uppercase' },
    { field: 'namespace', value: `a${'b'.repeat(100)}` },
    { field: 'scopeSha256', value: 'A'.repeat(64) },
    { field: 'scopeSha256', value: 'a'.repeat(63) },
    { field: 'windowSeconds', value: 0 },
    { field: 'windowSeconds', value: 1.5 },
    { field: 'maxAttempts', value: 0 },
    { field: 'maxAttempts', value: 1.5 }
  ])('rejects invalid consume input $field=$value with the shared contract', async ({ field, value }) => {
    const fixture = fakeExecutor();
    const input = {
      namespace: validNamespace,
      scopeSha256: validDigest,
      windowSeconds: 60,
      maxAttempts: 3,
      [field]: value
    };
    const error = await captureRejected(() => consumeRateLimit(fixture.database, input));
    expectInvalidRateLimitInput(error, typeof value === 'string' && value ? value : undefined);
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.insert).not.toHaveBeenCalled();
  });

  it.each([0, 1001, 1.5])('rejects invalid cleanup limit %s with the shared contract', async (limit) => {
    const fixture = fakeExecutor();
    const error = await captureRejected(() =>
      cleanupExpiredRateLimits(fixture.database, {
        namespace: validNamespace,
        limit
      })
    );
    expectInvalidRateLimitInput(error);
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it.each(['', 'Uppercase', `a${'b'.repeat(100)}`])(
    'rejects invalid cleanup namespace %s with the shared contract',
    async (namespace) => {
      const fixture = fakeExecutor();
      const error = await captureRejected(() =>
        cleanupExpiredRateLimits(fixture.database, { namespace })
      );
      expectInvalidRateLimitInput(error, namespace || undefined);
      expect(fixture.execute).not.toHaveBeenCalled();
    }
  );
});

describe('shared rate-limit SQL and decisions', () => {
  it('cleans 100 rows first and reuses the caller executor and time for a fixed window upsert', async () => {
    const fixture = fakeExecutor({ count: 1 });
    const now = new Date('2026-08-10T12:00:59.250Z');

    await consumeRateLimit(fixture.database, {
      namespace: validNamespace,
      scopeSha256: validDigest,
      windowSeconds: 60,
      maxAttempts: 3,
      now
    });

    expect(fixture.execute.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.insert.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
    );
    expect(fixture.insert).toHaveBeenCalledWith(applicationRateLimits);
    const inserted = fixture.values.mock.calls[0]?.[0];
    expect(inserted).toMatchObject({
      namespace: validNamespace,
      scopeSha256: validDigest,
      count: 1
    });
    expect(inserted?.windowStart).toEqual(new Date('2026-08-10T12:00:00.000Z'));
    expect(inserted?.expiresAt).toEqual(new Date('2026-08-10T12:01:00.000Z'));
    expect(inserted?.createdAt).toBe(now);
    expect(inserted?.updatedAt).toBe(now);

    const cleanup = normalizedSql(fixture.execute.mock.calls[0]?.[0] as SQL);
    expect(cleanup.params).toEqual([validNamespace, now, 100]);
  });

  it('uses the exact composite conflict target and a saturated count update', async () => {
    const fixture = fakeExecutor({ count: 2 });
    const now = new Date('2026-08-10T12:00:00.000Z');
    await consumeRateLimit(fixture.database, {
      namespace: validNamespace,
      scopeSha256: validDigest,
      windowSeconds: 60,
      maxAttempts: 3,
      now
    });

    const conflict = fixture.onConflictDoUpdate.mock.calls[0]?.[0];
    expect(conflict?.target).toEqual([
      applicationRateLimits.namespace,
      applicationRateLimits.scopeSha256,
      applicationRateLimits.windowStart
    ]);
    expect(conflict?.set.updatedAt).toBe(now);
    const countUpdate = normalizedSql(conflict?.set.count as SQL);
    expect(countUpdate.sql).toBe('least("application_rate_limits"."count" + 1, $1)');
    expect(countUpdate.params).toEqual([4]);
  });

  it.each([
    { count: 1, allowed: true, remaining: 2, retryAfterSeconds: 0 },
    { count: 3, allowed: true, remaining: 0, retryAfterSeconds: 0 },
    { count: 4, allowed: false, remaining: 0, retryAfterSeconds: 25 }
  ])('returns the bounded decision for stored count $count', async (expected) => {
    const fixture = fakeExecutor({ count: expected.count });
    await expect(
      consumeRateLimit(fixture.database, {
        namespace: validNamespace,
        scopeSha256: validDigest,
        windowSeconds: 60,
        maxAttempts: 3,
        now: new Date('2026-08-10T12:00:35.100Z')
      })
    ).resolves.toEqual({
      allowed: expected.allowed,
      limit: 3,
      remaining: expected.remaining,
      retryAfterSeconds: expected.retryAfterSeconds
    });
  });

  it.each([
    { now: '2026-08-10T12:00:00.000Z', retryAfterSeconds: 60 },
    { now: '2026-08-10T12:00:59.999Z', retryAfterSeconds: 1 }
  ])('clamps denied retry-after for $now', async ({ now, retryAfterSeconds }) => {
    const fixture = fakeExecutor({ count: 4 });
    await expect(
      consumeRateLimit(fixture.database, {
        namespace: validNamespace,
        scopeSha256: validDigest,
        windowSeconds: 60,
        maxAttempts: 3,
        now: new Date(now)
      })
    ).resolves.toMatchObject({ retryAfterSeconds });
  });

  it.each([
    { suppliedLimit: undefined, expectedLimit: 500, deleted: 2 },
    { suppliedLimit: 1, expectedLimit: 1, deleted: 1 },
    { suppliedLimit: 1000, expectedLimit: 1000, deleted: 3 }
  ])(
    'cleans with limit $expectedLimit and returns the deleted row count',
    async ({ suppliedLimit, expectedLimit, deleted }) => {
      const fixture = fakeExecutor({ deleted });
      const now = new Date('2026-08-10T12:01:00.000Z');
      await expect(
        cleanupExpiredRateLimits(fixture.database, {
          namespace: validNamespace,
          now,
          ...(suppliedLimit === undefined ? {} : { limit: suppliedLimit })
        })
      ).resolves.toBe(deleted);
      const cleanup = normalizedSql(fixture.execute.mock.calls[0]?.[0] as SQL);
      expect(cleanup.params).toEqual([validNamespace, now, expectedLimit]);
    }
  );

  it('keeps bounded cleanup ordering, locking, and deletion keys in the compiled SQL', async () => {
    const fixture = fakeExecutor();
    const now = new Date('2026-08-10T12:01:00.000Z');
    await cleanupExpiredRateLimits(fixture.database, {
      namespace: validNamespace,
      now,
      limit: 17
    });

    const cleanup = normalizedSql(fixture.execute.mock.calls[0]?.[0] as SQL);
    expect(cleanup.sql).toContain(
      'order by expires_at asc, scope_sha256 asc, window_start asc for update skip locked limit $3'
    );
    expect(cleanup.sql).toContain(
      'where target.namespace = candidates.namespace and target.scope_sha256 = candidates.scope_sha256 and target.window_start = candidates.window_start'
    );
    expect(cleanup.params).toEqual([validNamespace, now, 17]);
  });

  it('throws the unrelated exact error when the upsert returns no row', async () => {
    const fixture = fakeExecutor({ count: null });
    const error = await captureRejected(() =>
      consumeRateLimit(fixture.database, {
        namespace: validNamespace,
        scopeSha256: validDigest,
        windowSeconds: 60,
        maxAttempts: 3
      })
    );
    expect(error).toEqual(new Error('Rate-limit upsert returned no row'));
    expect(error).not.toBeInstanceOf(InvalidRateLimitInputError);
  });
});
