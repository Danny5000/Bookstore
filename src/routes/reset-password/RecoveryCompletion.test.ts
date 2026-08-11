import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import RecoveryCompletion from './RecoveryCompletion.svelte';

describe('commerce recovery completion', () => {
  it('shows a safe sign-in continuation after automatic sign-in fails post-reset', () => {
    const { body } = render(RecoveryCompletion, {
      props: { commerceClaim: true, signInUnavailable: true }
    });

    expect(body).toContain('password has been updated');
    expect(body).toContain('automatic sign-in is temporarily unavailable');
    expect(body).toContain('returnTo=%2Fclaim%2Fcomplete');
    expect(body).not.toContain('reset-token');
    expect(body).not.toMatch(/type="password"/u);
  });

  it('offers direct claim completion only after recovered sign-in succeeds', () => {
    const { body } = render(RecoveryCompletion, {
      props: { commerceClaim: true, claimReady: true }
    });
    expect(body).toMatch(/href="\/claim\/complete"[^>]*>Claim your purchases/u);
    expect(body).not.toContain('Request another claim email');
  });

  it('never leaves a consumed reset form after server proof creation fails', () => {
    const { body } = render(RecoveryCompletion, {
      props: { commerceClaim: true, recoveryRequired: true }
    });
    expect(body).toContain('Request a fresh claim email');
    expect(body).toMatch(/href="\/claim"[^>]*>Request another claim email/u);
    expect(body).not.toContain('Claim your purchases');
    expect(body).not.toMatch(/type="password"/u);
  });
});
