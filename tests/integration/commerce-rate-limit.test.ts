import { count, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  cleanupExpiredRateLimits,
  consumeRateLimit,
  rateLimitScopeDigest
} from '$lib/server/commerce/rate-limit';
import { applicationRateLimits } from '$lib/server/db/schema';
import { databaseClient } from './database';

const scope = (value: string): string => value.repeat(64).slice(0, 64);

describe('application commerce rate limits', () => {
  it('allows the first N attempts, denies N+1 with bounded retry-after, and resets next window', async () => {
    const now = new Date('2026-08-10T12:00:00.000Z');
    const input = {
      namespace: 'commerce.quote',
      scopeSha256: scope('a'),
      windowSeconds: 60,
      maxAttempts: 3,
      now
    };

    await expect(consumeRateLimit(databaseClient.db, input)).resolves.toEqual({
      allowed: true,
      limit: 3,
      remaining: 2,
      retryAfterSeconds: 0
    });
    expect((await consumeRateLimit(databaseClient.db, input)).allowed).toBe(true);
    expect((await consumeRateLimit(databaseClient.db, input)).remaining).toBe(0);
    await expect(consumeRateLimit(databaseClient.db, input)).resolves.toEqual({
      allowed: false,
      limit: 3,
      remaining: 0,
      retryAfterSeconds: 60
    });

    await expect(
      consumeRateLimit(databaseClient.db, {
        ...input,
        now: new Date('2026-08-10T12:01:00.000Z')
      })
    ).resolves.toMatchObject({ allowed: true, remaining: 2 });
  });

  it('cleans expired rows by namespace in bounded idempotent batches', async () => {
    const namespace = 'commerce.cleanup-test';
    await consumeRateLimit(databaseClient.db, {
      namespace,
      scopeSha256: scope('b'),
      windowSeconds: 60,
      maxAttempts: 2,
      now: new Date('2026-08-10T12:00:00.000Z')
    });
    await consumeRateLimit(databaseClient.db, {
      namespace,
      scopeSha256: scope('c'),
      windowSeconds: 60,
      maxAttempts: 2,
      now: new Date('2026-08-10T12:02:00.000Z')
    });

    await expect(
      cleanupExpiredRateLimits(databaseClient.db, {
        namespace,
        now: new Date('2026-08-10T12:01:00.000Z'),
        limit: 10
      })
    ).resolves.toBe(1);
    await expect(
      cleanupExpiredRateLimits(databaseClient.db, {
        namespace,
        now: new Date('2026-08-10T12:01:00.000Z'),
        limit: 10
      })
    ).resolves.toBe(0);
    const [remaining] = await databaseClient.db
      .select({ value: count() })
      .from(applicationRateLimits)
      .where(eq(applicationRateLimits.namespace, namespace));
    expect(remaining?.value).toBe(1);
  });

  it('never allows more than N of 20 concurrent attempts', async () => {
    const input = {
      namespace: 'commerce.concurrent-test',
      scopeSha256: scope('d'),
      windowSeconds: 60,
      maxAttempts: 5,
      now: new Date('2026-08-10T12:00:00.000Z')
    };

    const decisions = await Promise.all(
      Array.from({ length: 20 }, () => consumeRateLimit(databaseClient.db, input))
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(5);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(15);
    const [stored] = await databaseClient.db
      .select()
      .from(applicationRateLimits)
      .where(eq(applicationRateLimits.namespace, input.namespace));
    expect(stored?.count).toBe(6);
  });

  it('stores only a namespaced digest rather than IP, token, email, or user agent', async () => {
    const requestIp = '198.51.100.77';
    const applicationSecret = 'test-only-secret-containing-no-production-data';
    const scopeSha256 = rateLimitScopeDigest({
      actor: { type: 'anonymous' },
      requestIp,
      applicationSecret
    });
    await consumeRateLimit(databaseClient.db, {
      namespace: 'commerce.quote',
      scopeSha256,
      windowSeconds: 60,
      maxAttempts: 5,
      now: new Date('2026-08-10T12:00:00.000Z')
    });

    const [stored] = await databaseClient.db
      .select()
      .from(applicationRateLimits)
      .where(eq(applicationRateLimits.scopeSha256, scopeSha256));
    expect(stored?.scopeSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(stored)).not.toMatch(
      /198\.51\.100\.77|reader@example\.com|authorization|user-agent|token/iu
    );
  });
});
