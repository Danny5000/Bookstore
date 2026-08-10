import { describe, expect, it } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import { rateLimitScopeDigest } from './rate-limit';

const user = {
  type: 'user',
  id: '00000000-0000-4000-8000-000000000001',
  roles: ['customer']
} satisfies Actor;

describe('rateLimitScopeDigest', () => {
  it('hashes authenticated user scope without storing the raw user key', () => {
    const digest = rateLimitScopeDigest({
      actor: user,
      requestIp: '198.51.100.10',
      applicationSecret: 'test-only-application-secret-123456789'
    });

    expect(digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(digest).not.toContain(user.id);
    expect(
      rateLimitScopeDigest({
        actor: user,
        requestIp: '203.0.113.22',
        applicationSecret: 'different-secret-that-does-not-matter'
      })
    ).toBe(digest);
  });

  it('HMACs anonymous IP scope with the application secret', () => {
    const first = rateLimitScopeDigest({
      actor: { type: 'anonymous' },
      requestIp: '198.51.100.10',
      applicationSecret: 'test-only-application-secret-123456789'
    });
    const same = rateLimitScopeDigest({
      actor: { type: 'anonymous' },
      requestIp: '198.51.100.10',
      applicationSecret: 'test-only-application-secret-123456789'
    });
    const differentSecret = rateLimitScopeDigest({
      actor: { type: 'anonymous' },
      requestIp: '198.51.100.10',
      applicationSecret: 'another-test-application-secret-987654'
    });

    expect(first).toBe(same);
    expect(differentSecret).not.toBe(first);
    expect(first).not.toContain('198.51.100.10');
  });

  it('rejects an empty anonymous network scope', () => {
    expect(() =>
      rateLimitScopeDigest({
        actor: { type: 'anonymous' },
        requestIp: '   ',
        applicationSecret: 'test-only-application-secret-123456789'
      })
    ).toThrow();
  });
});
