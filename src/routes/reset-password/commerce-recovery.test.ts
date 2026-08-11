import { describe, expect, it, vi } from 'vitest';
import { completeCommerceRecovery } from './commerce-recovery';

const input = {
  token: 'reset-token-stays-in-better-auth-body',
  newPassword: 'a-new-victim-password',
  email: 'victim@example.com'
};

describe('commerce credential recovery ordering', () => {
  it('never signs in unless password rotation succeeds first', async () => {
    const calls: string[] = [];
    const signInEmail = vi.fn(async () => ({ error: null }));
    const outcome = await completeCommerceRecovery(input, {
      resetPassword: async () => {
        calls.push('reset');
        return { error: { message: 'invalid token' } };
      },
      signInEmail
    });

    expect(outcome).toBe('recovery_required');
    expect(calls).toEqual(['reset']);
    expect(signInEmail).not.toHaveBeenCalled();
  });

  it('signs in with the newly rotated password before offering claim completion', async () => {
    const calls: string[] = [];
    const outcome = await completeCommerceRecovery(input, {
      resetPassword: async () => {
        calls.push('reset');
        return { data: { commerceClaimReady: true }, error: null };
      },
      signInEmail: async () => {
        calls.push('sign-in');
        return { error: null };
      }
    });

    expect(outcome).toBe('claim_ready');
    expect(calls).toEqual(['reset', 'sign-in']);
  });

  it.each(['returned error', 'thrown error'] as const)(
    'makes a sign-in %s after rotation a terminal partial success',
    async (failure) => {
      const outcome = await completeCommerceRecovery(input, {
        resetPassword: async () => ({ data: { commerceClaimReady: true }, error: null }),
        signInEmail: failure === 'returned error'
          ? async () => ({ error: { message: 'mail unavailable' } })
          : async () => { throw new Error('network unavailable'); }
      });

      expect(outcome).toBe('sign_in_unavailable');
    }
  );

  it.each([
    { label: 'missing server proof', result: { data: { status: true }, error: null } },
    { label: 'after-hook error', result: { data: null, error: { message: 'unavailable' } } }
  ])('requires fresh recovery for $label without attempting sign-in', async ({ result }) => {
    const signInEmail = vi.fn(async () => ({ error: null }));
    await expect(completeCommerceRecovery(input, {
      resetPassword: async () => result,
      signInEmail
    })).resolves.toBe('recovery_required');
    expect(signInEmail).not.toHaveBeenCalled();
  });
});
