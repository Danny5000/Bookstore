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
});
