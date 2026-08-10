import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Actor } from '$lib/server/auth/admin-policy';
import { decidePublicationAccess } from './access';

const anonymous = { type: 'anonymous' } satisfies Actor;
const customer = { type: 'user', id: randomUUID(), roles: ['customer'] } satisfies Actor;
const admin = { type: 'user', id: randomUUID(), roles: ['admin'] } satisfies Actor;

describe('publication access policy', () => {
  it.each([
    [anonymous, 'public', true, false, 'preview'],
    [customer, 'public', true, false, 'preview'],
    [customer, 'public', true, true, 'entitled'],
    [customer, 'private', true, true, 'entitled'],
    [customer, 'archived', true, true, 'entitled'],
    [customer, 'private', true, false, 'denied'],
    [customer, 'archived', true, false, 'denied'],
    [admin, 'private', true, false, 'admin'],
    [admin, 'archived', true, false, 'admin']
  ] as const)(
    'resolves %o with %s visibility, publication=%s, entitlement=%s as %s',
    (actor, titleVisibility, hasActivePublication, hasActiveEntitlement, expected) => {
      expect(
        decidePublicationAccess({
          actor,
          titleVisibility,
          hasActivePublication,
          hasActiveEntitlement
        })
      ).toBe(expected);
    }
  );

  it('returns unavailable only to an administrator or entitled customer', () => {
    expect(
      decidePublicationAccess({
        actor: customer,
        titleVisibility: 'private',
        hasActivePublication: false,
        hasActiveEntitlement: true
      })
    ).toBe('unavailable');
    expect(
      decidePublicationAccess({
        actor: admin,
        titleVisibility: 'private',
        hasActivePublication: false,
        hasActiveEntitlement: false
      })
    ).toBe('unavailable');
    expect(
      decidePublicationAccess({
        actor: anonymous,
        titleVisibility: 'public',
        hasActivePublication: false,
        hasActiveEntitlement: false
      })
    ).toBe('denied');
  });

  it('does not disclose a missing title regardless of actor claims', () => {
    expect(
      decidePublicationAccess({
        actor: admin,
        titleVisibility: null,
        hasActivePublication: false,
        hasActiveEntitlement: true
      })
    ).toBe('denied');
  });
});
