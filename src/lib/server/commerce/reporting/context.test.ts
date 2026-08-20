import { describe, expect, it } from 'vitest';
import {
  FINANCIAL_REQUEST_CONTEXT_KEYS,
  type FinancialRequestContext
} from './context';

describe('FinancialRequestContext', () => {
  it('contains only a bounded correlation identity and optional safe audit metadata', () => {
    const withoutMetadata: FinancialRequestContext = { correlationId: 'request-1' };
    const withMetadata: FinancialRequestContext = {
      correlationId: 'request-2',
      requestMetadata: { method: 'POST', routeId: '/admin/sales/refunds/[refundId]' }
    };

    expect(withoutMetadata).toEqual({ correlationId: 'request-1' });
    expect(withMetadata).toEqual({
      correlationId: 'request-2',
      requestMetadata: { method: 'POST', routeId: '/admin/sales/refunds/[refundId]' }
    });
    expect(FINANCIAL_REQUEST_CONTEXT_KEYS).toEqual(['correlationId', 'requestMetadata']);
    expect(Object.keys(withMetadata)).not.toContain('request');
  });
});
