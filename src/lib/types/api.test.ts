import { describe, expect, it } from 'vitest';
import { parseCheckoutRequest, parseDeliveryRequest } from './api';

describe('API request guards', () => {
  it('accepts a complete checkout request', () => {
    expect(
      parseCheckoutRequest({
        titleId: 'salt',
        email: 'reader@example.com',
        emailCopy: true
      })
    ).toEqual({
      titleId: 'salt',
      email: 'reader@example.com',
      emailCopy: true
    });
  });

  it('rejects malformed checkout and delivery payloads', () => {
    expect(parseCheckoutRequest({ titleId: 1 })).toBeNull();
    expect(parseDeliveryRequest({ titleId: 'salt', channel: 'fax' })).toBeNull();
  });
});
