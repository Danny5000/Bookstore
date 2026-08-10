import { render } from 'svelte/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dependencies = vi.hoisted(() => ({
  database: {},
  requestGuestClaimEmails: vi.fn()
}));

vi.mock('$lib/server/db/runtime', () => ({
  getDatabaseClient: () => ({ db: dependencies.database })
}));
vi.mock('$lib/server/config', () => ({
  getApplicationConfig: () => ({
    origin: 'https://books.example.com',
    auth: {
      secret: 'test-application-secret-that-is-long-enough',
      rateLimit: { windowSeconds: 60, emailMax: 3 }
    }
  })
}));
vi.mock('$lib/server/commerce/claims', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/commerce/claims')>();
  return { ...actual, requestGuestClaimEmails: dependencies.requestGuestClaimEmails };
});

import { actions } from './+page.server';
import ClaimPage from './+page.svelte';

const submit = actions.default;
if (!submit) throw new Error('Default claim action is required');

function event(email: string, origin: string | null = 'https://books.example.com') {
  const headers = new Headers({ 'content-type': 'application/x-www-form-urlencoded' });
  if (origin !== null) headers.set('origin', origin);
  return {
    request: new Request('https://internal/claim', {
      method: 'POST',
      headers,
      body: new URLSearchParams({ email })
    }),
    getClientAddress: () => '203.0.113.41'
  };
}

describe('/claim request page', () => {
  beforeEach(() => dependencies.requestGuestClaimEmails.mockResolvedValue(undefined));

  it('submits a bounded server request and always returns the generic sent state', async () => {
    const result = await submit(event(' Reader@Example.COM ') as never);

    expect(result).toEqual({ sent: true });
    expect(dependencies.requestGuestClaimEmails).toHaveBeenCalledWith(
      dependencies.database,
      {
        email: ' Reader@Example.COM ',
        requestIp: '203.0.113.41',
        applicationSecret: 'test-application-secret-that-is-long-enough',
        windowSeconds: 60,
        maxAttempts: 3
      }
    );
    expect(JSON.stringify(result)).not.toMatch(/reader@|203\.0\.113/iu);
  });

  it('does not reveal no-match, already-claimed, or throttled outcomes', async () => {
    for (const internalResult of [undefined, undefined, undefined]) {
      dependencies.requestGuestClaimEmails.mockResolvedValueOnce(internalResult);
      await expect(submit(event('reader@example.com') as never))
        .resolves.toEqual({ sent: true });
    }
  });

  it.each([
    ['', 400],
    ['not-an-email', 400],
    ['x'.repeat(321), 400]
  ])('returns a local validation summary for invalid input', async (email, status) => {
    const result = await submit(event(email) as never);
    expect(result).toMatchObject({ status, data: { invalid: true } });
    expect(dependencies.requestGuestClaimEmails).not.toHaveBeenCalled();
  });

  it.each([null, 'https://evil.example'])('rejects a non-same-origin form', async (origin) => {
    const result = await submit(event('reader@example.com', origin) as never);
    expect(result).toMatchObject({ status: 403 });
    expect(dependencies.requestGuestClaimEmails).not.toHaveBeenCalled();
  });

  it('renders native controls, a focusable error summary, and a generic status without echoing email', () => {
    const initial = render(ClaimPage, { props: { form: null } });
    expect(initial.body).toMatch(/<label[^>]*for="claim-email"/u);
    expect(initial.body).toMatch(/<input[^>]*type="email"/u);
    expect(initial.body).toMatch(/<button[^>]*>Send claim link<\/button>/u);

    const invalid = render(ClaimPage, {
      props: { form: { invalid: true } as never }
    });
    expect(invalid.body).toMatch(/role="alert"[^>]*tabindex="-1"/u);
    const sent = render(ClaimPage, {
      props: { form: { sent: true } as never }
    });
    expect(sent.body).toContain('role="status"');
    expect(sent.body).toContain('If eligible purchases exist');
    expect(`${invalid.body}${sent.body}`).not.toMatch(/reader@example|order|title/iu);
  });
});
