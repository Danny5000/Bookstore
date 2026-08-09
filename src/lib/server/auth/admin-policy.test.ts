import { describe, expect, it } from 'vitest';
import {
  AuthorizationError,
  requireCapability,
  type Actor
} from './admin-policy';

describe('requireCapability', () => {
  it('allows an administrator to manage catalog records', () => {
    const actor: Actor = { type: 'user', id: 'admin-1', roles: ['admin'] };
    expect(() => requireCapability(actor, 'catalog.manage')).not.toThrow();
  });

  it.each(['admin.access', 'roles.manage'] as const)(
    'allows an administrator to use %s',
    (capability) => {
      const actor: Actor = { type: 'user', id: 'admin-1', roles: ['customer', 'admin'] };
      expect(() => requireCapability(actor, capability)).not.toThrow();
    }
  );

  it('rejects an anonymous actor as unauthenticated', () => {
    expect(() => requireCapability({ type: 'anonymous' }, 'audit.read')).toThrow(
      new AuthorizationError('unauthenticated', 401)
    );
  });

  it('rejects a customer as forbidden', () => {
    const actor: Actor = { type: 'user', id: 'customer-1', roles: ['customer'] };
    expect(() => requireCapability(actor, 'jobs.retry')).toThrow(
      new AuthorizationError('forbidden', 403)
    );
  });

  it('does not treat a background system actor as an administrator', () => {
    expect(() =>
      requireCapability({ type: 'system', id: 'worker-1' }, 'catalog.manage')
    ).toThrow(AuthorizationError);
  });

  it('does not allow a guest to manage roles', () => {
    expect(() => requireCapability({ type: 'guest', id: 'guest-1' }, 'roles.manage')).toThrow(
      new AuthorizationError('forbidden', 403)
    );
  });
});
