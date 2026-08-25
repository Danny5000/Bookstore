import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { DatabaseExecutor } from '$lib/server/db/transaction';
import { InvalidRateLimitInputError } from '$lib/server/security/rate-limit';
import { PermanentCommerceError } from './errors';
import * as adapter from './rate-limit';

const validDigest = 'a'.repeat(64);

function expectMappedInvalidInput(error: unknown): void {
  expect(error).toBeInstanceOf(PermanentCommerceError);
  expect((error as PermanentCommerceError).cause).toBeInstanceOf(InvalidRateLimitInputError);
}

async function captureRejected(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected action to reject');
}

describe('commerce rate-limit compatibility adapter', () => {
  it('maps synchronous shared digest validation to a permanent commerce error with cause', () => {
    let thrown: unknown;
    try {
      adapter.rateLimitScopeDigest({
        actor: { type: 'anonymous' },
        requestIp: '   ',
        applicationSecret: 'test-secret'
      });
    } catch (error) {
      thrown = error;
    }
    expectMappedInvalidInput(thrown);
  });

  it('maps asynchronous shared consume validation to a permanent commerce error with cause', async () => {
    const database = {} as DatabaseExecutor;
    const error = await captureRejected(() =>
      adapter.consumeRateLimit(database, {
        namespace: 'Uppercase',
        scopeSha256: validDigest,
        windowSeconds: 60,
        maxAttempts: 3
      })
    );
    expectMappedInvalidInput(error);
  });

  it('maps asynchronous shared cleanup validation to a permanent commerce error with cause', async () => {
    const database = {} as DatabaseExecutor;
    const error = await captureRejected(() =>
      adapter.cleanupExpiredRateLimits(database, {
        namespace: 'commerce.quote',
        limit: 0
      })
    );
    expectMappedInvalidInput(error);
  });

  it('does not re-export the shared validation error', () => {
    expect(Reflect.has(adapter, 'InvalidRateLimitInputError')).toBe(false);
  });

  it('rethrows a valid-input database failure by object identity', async () => {
    const databaseFailure = new Error('database unavailable');
    const execute = vi.fn().mockRejectedValue(databaseFailure);
    const database = { execute } as unknown as DatabaseExecutor;
    const error = await captureRejected(() =>
      adapter.consumeRateLimit(database, {
        namespace: 'commerce.quote',
        scopeSha256: validDigest,
        windowSeconds: 60,
        maxAttempts: 3
      })
    );
    expect(error).toBe(databaseFailure);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('contains no hashing, SQL, schema, or validation engine implementation', () => {
    const source = readFileSync(new URL('./rate-limit.ts', import.meta.url), 'utf8')
      .replaceAll('\r\n', '\n')
      .toLowerCase();
    for (const forbidden of [
      'node:crypto',
      'drizzle-orm',
      'applicationratelimits',
      'automatic_cleanup_limit',
      'onconflictdoupdate',
      'skip locked',
      '[a-z0-9._-]'
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
