import { describe, expect, it } from 'vitest';
import type { EntitlementGrantRow } from '$lib/server/db/schema';
import { CommerceConflictError, PermanentCommerceError } from './errors';
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
  it.each([
    ['purchase', 'claim'],
    ['purchase', 'payment'],
    ['purchase', 'refund'],
    ['purchase', 'dispute'],
    ['preserved', 'preserved'],
    ['administrative', 'administrative-recovery']
  ] as const)('allows only the %s grant / %s origin pairing', (source, origin) => {
    expect(() => assertGrantTransitionAllowed(
      { source, state: 'active' }, 'revoked', origin
    )).not.toThrow();
  });

  it.each([
    ['purchase', 'preserved'],
    ['purchase', 'administrative-recovery'],
    ['preserved', 'claim'],
    ['preserved', 'payment'],
    ['preserved', 'refund'],
    ['preserved', 'dispute'],
    ['preserved', 'administrative-recovery'],
    ['administrative', 'claim'],
    ['administrative', 'payment'],
    ['administrative', 'refund'],
    ['administrative', 'dispute'],
    ['administrative', 'preserved']
  ] as const)('rejects the %s grant / %s origin pairing for a state change',
    (source, origin) => {
      expect(() => assertGrantTransitionAllowed(
        { source, state: 'active' }, 'revoked', origin
      )).toThrow();
    });

  it('preserves idempotent no-ops before applying origin restrictions', () => {
    expect(() => assertGrantTransitionAllowed(
      { source: 'administrative', state: 'active' }, 'active', 'refund'
    )).not.toThrow();
  });

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

  it.each([
    ['active', 'revoked'],
    ['revoked', 'active']
  ] as const)('allows the protected administrative %s -> %s transition',
    (state, nextState) => {
      expect(() => assertGrantTransitionAllowed(
        { source: 'administrative', state }, nextState, 'administrative-recovery'
      )).not.toThrow();
    });

  const invalidAdministrativeTransitions = (
    ['unclaimed', 'active', 'suspended', 'revoked'] as const
  ).flatMap((state) =>
    (['unclaimed', 'active', 'suspended', 'revoked'] as const)
      .filter((nextState) =>
        nextState !== state &&
        !(state === 'active' && nextState === 'revoked') &&
        !(state === 'revoked' && nextState === 'active')
      )
      .map((nextState) => [state, nextState] as const)
  );

  it.each(invalidAdministrativeTransitions)(
    'rejects the administrative %s -> %s transition',
    (state, nextState) => {
      expect(() => assertGrantTransitionAllowed(
        { source: 'administrative', state }, nextState, 'administrative-recovery'
      )).toThrow(PermanentCommerceError);
    }
  );
});
