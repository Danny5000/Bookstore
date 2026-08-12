import { describe, expect, it } from 'vitest';
import { PermanentFinancialError, RetryableFinancialError } from './errors';

describe('financial errors', () => {
  it('keeps worker failures generic and bounded', () => {
    const permanent = new PermanentFinancialError('immutable_mismatch');
    const retryable = new RetryableFinancialError('provider_unavailable');

    expect(permanent.safeCode).toBe('immutable_mismatch');
    expect(retryable.safeCode).toBe('provider_unavailable');
    expect(Object.hasOwn(permanent, 'cause')).toBe(false);
    expect(Object.hasOwn(retryable, 'cause')).toBe(false);
  });
});
