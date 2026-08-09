import { describe, expect, it } from 'vitest';
import { safeAuditRequestMetadata } from './request-metadata';

describe('safeAuditRequestMetadata', () => {
  it('retains only the method and matched route identifier', () => {
    const request = new Request('https://books.example.com/admin/catalog/secret?token=private', {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret',
        cookie: 'session=secret',
        'user-agent': 'private-client',
        'x-forwarded-for': '192.0.2.1'
      }
    });

    const metadata = safeAuditRequestMetadata(request, '/admin/catalog/[titleId]');

    expect(metadata).toEqual({ method: 'POST', routeId: '/admin/catalog/[titleId]' });
    expect(JSON.stringify(metadata)).not.toContain('secret');
    expect(JSON.stringify(metadata)).not.toContain('192.0.2.1');
  });

  it('uses null for an unmatched route and bounds both retained values', () => {
    const request = new Request('https://books.example.com/', {
      method: 'M'.repeat(100)
    });

    expect(safeAuditRequestMetadata(new Request('https://books.example.com/'), null)).toEqual({
      method: 'GET',
      routeId: null
    });
    const bounded = safeAuditRequestMetadata(request, `/${'r'.repeat(1_000)}`);
    expect(bounded.method).toHaveLength(16);
    expect(bounded.routeId).toHaveLength(500);
  });
});
