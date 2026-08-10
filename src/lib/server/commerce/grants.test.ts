import { describe, expect, it } from 'vitest';
import type { EntitlementGrantRow } from '$lib/server/db/schema';
import { CommerceConflictError } from './errors';
import { assertGrantTransitionAllowed, effectiveEntitlementState } from './grants';

const grants = (
  ...states: EntitlementGrantRow['state'][]
): Array<Pick<EntitlementGrantRow, 'state'>> => states.map((state) => ({ state }));

describe('effectiveEntitlementState', () => {
  it.each([
    { label: 'no grants', input: grants(), expected: 'revoked' },
    { label: 'one active grant', input: grants('active'), expected: 'active' },
    {
      label: 'active with suspended and revoked grants',
      input: grants('suspended', 'active', 'revoked'),
      expected: 'active'
    },
    { label: 'only suspended grants', input: grants('suspended'), expected: 'revoked' },
    { label: 'only unclaimed grants', input: grants('unclaimed'), expected: 'revoked' },
    { label: 'only revoked grants', input: grants('revoked'), expected: 'revoked' }
  ])('returns $expected for $label', ({ input, expected }) => {
    expect(effectiveEntitlementState(input)).toBe(expected);
  });
});

describe('assertGrantTransitionAllowed', () => {
  it('rejects reactivation of a permanently revoked purchase grant', () => {
    expect(() =>
      assertGrantTransitionAllowed(
        { source: 'purchase', state: 'revoked' },
        'active',
        'dispute'
      )
    ).toThrowError(
      expect.objectContaining<Partial<CommerceConflictError>>({
        code: 'GRANT_PERMANENTLY_REVOKED'
      })
    );
    expect(() =>
      assertGrantTransitionAllowed(
        { source: 'purchase', state: 'revoked' },
        'revoked',
        'refund'
      )
    ).not.toThrow();
  });

  it.each(['refund', 'dispute'] as const)(
    'prevents %s logic from mutating a preserved grant',
    (origin) => {
      expect(() =>
        assertGrantTransitionAllowed(
          { source: 'preserved', state: 'active' },
          'revoked',
          origin
        )
      ).toThrowError(
        expect.objectContaining<Partial<CommerceConflictError>>({
          code: 'PRESERVED_GRANT_IMMUTABLE'
        })
      );
    }
  );

  it('allows application-owned preserved access maintenance', () => {
    expect(() =>
      assertGrantTransitionAllowed(
        { source: 'preserved', state: 'active' },
        'revoked',
        'preserved'
      )
    ).not.toThrow();
  });
});
