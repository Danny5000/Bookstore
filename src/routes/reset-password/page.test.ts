import { render } from 'svelte/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  url: new URL('https://books.example.com/reset-password?token=reset-token')
}));

vi.mock('$app/state', () => ({
  page: {
    get url() {
      return state.url;
    }
  }
}));

import ResetPasswordPage from './+page.svelte';

describe('/reset-password', () => {
  beforeEach(() => {
    state.url = new URL('https://books.example.com/reset-password?token=reset-token');
  });

  it('asks for the checkout email only for commerce recovery', () => {
    state.url = new URL(
      'https://books.example.com/reset-password?purpose=commerce-claim&token=reset-token'
    );

    const { body } = render(ResetPasswordPage);

    expect(body).toContain('Secure your account and claim purchases');
    expect(body).toMatch(/<label[^>]*>[\s\S]*Checkout email[\s\S]*type="email"/u);
    expect(body).toContain('Update password and continue');
    expect(body).not.toContain('reset-token');
  });

  it('keeps ordinary password resets on the existing password-only flow', () => {
    const { body } = render(ResetPasswordPage);

    expect(body).toContain('Choose a new password');
    expect(body).not.toContain('Checkout email');
    expect(body).toContain('Update password');
  });
});
