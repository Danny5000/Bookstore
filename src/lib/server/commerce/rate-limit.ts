import type { DatabaseExecutor } from '$lib/server/db/transaction';
import {
  InvalidRateLimitInputError,
  cleanupExpiredRateLimits as cleanupShared,
  consumeRateLimit as consumeShared,
  rateLimitScopeDigest as digestShared
} from '$lib/server/security/rate-limit';
import type {
  CleanupExpiredRateLimitsInput,
  ConsumeRateLimitInput,
  RateLimitDecision,
  RateLimitScopeInput
} from '$lib/server/security/rate-limit';
import { PermanentCommerceError } from './errors';

export type {
  CleanupExpiredRateLimitsInput,
  ConsumeRateLimitInput,
  RateLimitDecision,
  RateLimitScopeInput
};

function mapInvalidInput(error: unknown): never {
  if (error instanceof InvalidRateLimitInputError) {
    throw new PermanentCommerceError({ cause: error });
  }
  throw error;
}

export function rateLimitScopeDigest(input: RateLimitScopeInput): string {
  try {
    return digestShared(input);
  } catch (error) {
    return mapInvalidInput(error);
  }
}

export async function consumeRateLimit(
  database: DatabaseExecutor,
  input: ConsumeRateLimitInput
): Promise<RateLimitDecision> {
  try {
    return await consumeShared(database, input);
  } catch (error) {
    return mapInvalidInput(error);
  }
}

export async function cleanupExpiredRateLimits(
  database: DatabaseExecutor,
  input: CleanupExpiredRateLimitsInput
): Promise<number> {
  try {
    return await cleanupShared(database, input);
  } catch (error) {
    return mapInvalidInput(error);
  }
}
