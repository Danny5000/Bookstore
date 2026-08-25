import { createHash, createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Actor } from '$lib/server/auth/admin-policy';
import { applicationRateLimits } from '$lib/server/db/schema';
import type { DatabaseExecutor } from '$lib/server/db/transaction';

const AUTOMATIC_CLEANUP_LIMIT = 100;

export class InvalidRateLimitInputError extends Error {
  readonly code = 'invalid_rate_limit_input' as const;

  constructor() {
    super('Rate-limit input is invalid.');
    this.name = 'InvalidRateLimitInputError';
  }
}

export interface RateLimitScopeInput {
  actor: Actor;
  requestIp: string;
  applicationSecret: string;
}

export function rateLimitScopeDigest(input: RateLimitScopeInput): string {
  if (input.actor.type === 'user') {
    return createHash('sha256').update(`user:${input.actor.id}`, 'utf8').digest('hex');
  }
  const requestIp = input.requestIp.trim();
  if (!requestIp || !input.applicationSecret) throw new InvalidRateLimitInputError();
  return createHmac('sha256', input.applicationSecret)
    .update(`ip:${requestIp}`, 'utf8')
    .digest('hex');
}

export interface ConsumeRateLimitInput {
  namespace: string;
  scopeSha256: string;
  windowSeconds: number;
  maxAttempts: number;
  now?: Date;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

function validateLimitInput(input: ConsumeRateLimitInput): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/u.test(input.namespace)) {
    throw new InvalidRateLimitInputError();
  }
  if (!/^[a-f0-9]{64}$/u.test(input.scopeSha256)) throw new InvalidRateLimitInputError();
  if (!Number.isInteger(input.windowSeconds) || input.windowSeconds < 1) {
    throw new InvalidRateLimitInputError();
  }
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
    throw new InvalidRateLimitInputError();
  }
}

export async function consumeRateLimit(
  database: DatabaseExecutor,
  input: ConsumeRateLimitInput
): Promise<RateLimitDecision> {
  validateLimitInput(input);
  const now = input.now ?? new Date();
  await cleanupExpiredRateLimits(database, {
    namespace: input.namespace,
    now,
    limit: AUTOMATIC_CLEANUP_LIMIT
  });
  const windowMilliseconds = input.windowSeconds * 1000;
  const windowStart = new Date(
    Math.floor(now.getTime() / windowMilliseconds) * windowMilliseconds
  );
  const expiresAt = new Date(windowStart.getTime() + windowMilliseconds);
  const [row] = await database
    .insert(applicationRateLimits)
    .values({
      namespace: input.namespace,
      scopeSha256: input.scopeSha256,
      windowStart,
      count: 1,
      expiresAt,
      createdAt: now,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: [
        applicationRateLimits.namespace,
        applicationRateLimits.scopeSha256,
        applicationRateLimits.windowStart
      ],
      set: {
        count: sql`least(${applicationRateLimits.count} + 1, ${input.maxAttempts + 1})`,
        updatedAt: now
      }
    })
    .returning({ count: applicationRateLimits.count });
  if (!row) throw new Error('Rate-limit upsert returned no row');

  const allowed = row.count <= input.maxAttempts;
  const retryAfterSeconds = allowed
    ? 0
    : Math.max(
        1,
        Math.min(
          input.windowSeconds,
          Math.ceil((expiresAt.getTime() - now.getTime()) / 1000)
        )
      );
  return {
    allowed,
    limit: input.maxAttempts,
    remaining: Math.max(0, input.maxAttempts - row.count),
    retryAfterSeconds
  };
}

export interface CleanupExpiredRateLimitsInput {
  namespace: string;
  now?: Date;
  limit?: number;
}

export async function cleanupExpiredRateLimits(
  database: DatabaseExecutor,
  input: CleanupExpiredRateLimitsInput
): Promise<number> {
  const limit = input.limit ?? 500;
  if (
    !/^[a-z0-9][a-z0-9._-]{0,99}$/u.test(input.namespace) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000
  ) {
    throw new InvalidRateLimitInputError();
  }
  const now = input.now ?? new Date();
  const deleted = await database.execute<{ deleted: number }>(sql`
    with candidates as (
      select namespace, scope_sha256, window_start
      from application_rate_limits
      where namespace = ${input.namespace}
        and expires_at <= ${now}
      order by expires_at asc, scope_sha256 asc, window_start asc
      for update skip locked
      limit ${limit}
    )
    delete from application_rate_limits target
    using candidates
    where target.namespace = candidates.namespace
      and target.scope_sha256 = candidates.scope_sha256
      and target.window_start = candidates.window_start
    returning 1 as deleted
  `);
  return deleted.rows.length;
}
