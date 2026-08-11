import { randomUUID } from 'node:crypto';
import { render } from 'svelte/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceConflictError } from '$lib/server/commerce/errors';

const dependencies = vi.hoisted(() => ({
  database: {},
  claimGuestPurchases: vi.fn(),
  deleteCookie: vi.fn()
}));

vi.mock('$lib/server/db/runtime', () => ({
  getDatabaseClient: () => ({ db: dependencies.database })
}));
vi.mock('$lib/server/commerce/claims', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/commerce/claims')>();
  return { ...actual, claimGuestPurchases: dependencies.claimGuestPurchases };
});

import { load } from './+page.server';
import CompletePage from './+page.svelte';

const userId = randomUUID();
const verifiedLocals = {
  actor: { type: 'user' as const, id: userId, roles: ['customer'] as const },
  user: {
    id: userId,
    name: 'Reader',
    email: 'private@example.com',
    emailVerified: true,
    roles: ['customer'] as const
  },
  session: { id: randomUUID(), userId, expiresAt: new Date('2026-08-11T12:00:00Z') }
};

function event(options: {
  locals?: typeof verifiedLocals | Record<string, unknown>;
  search?: string;
  requestId?: string;
  authorizationToken?: string | null;
} = {}) {
  const headers = new Headers();
  if (options.requestId) headers.set('x-request-id', options.requestId);
  return {
    locals: options.locals ?? verifiedLocals,
    url: new URL(`https://books.example.com/claim/complete${options.search ?? ''}`),
    request: new Request('https://books.example.com/claim/complete', { headers }),
    cookies: {
      get: () => options.authorizationToken === null
        ? undefined
        : options.authorizationToken ?? 'A'.repeat(43),
      delete: dependencies.deleteCookie
    }
  };
}

const claimed = {
  claimed: true,
  changed: true,
  claimedOrderCount: 2,
  claimedTitleCount: 2
};

describe('/claim/complete', () => {
  beforeEach(() => {
    dependencies.claimGuestPurchases.mockResolvedValue(claimed);
    dependencies.deleteCookie.mockReset();
  });

  it.each([true, false])('links to the library only after a successful or idempotent claim', async (changed) => {
    dependencies.claimGuestPurchases.mockResolvedValueOnce({ ...claimed, changed });
    const data = await load(event({ requestId: 'claim-complete-request' }) as never);
    expect(data).toEqual({ state: 'claimed' });
    expect(dependencies.claimGuestPurchases).toHaveBeenCalledWith(dependencies.database, {
      userId,
      correlationId: 'claim-complete-request',
      authorizationToken: 'A'.repeat(43)
    });
    expect(dependencies.deleteCookie).toHaveBeenCalledWith(
      'pale-orbit-commerce-claim',
      { path: '/claim/complete' }
    );
    const { body } = render(CompletePage, { props: { data: { user: null, ...data } as never } });
    expect(body).toContain('href="/library"');
    expect(body).not.toMatch(/private@example|claimedOrderCount|claimedTitleCount/iu);
  });

  it('maps no purchase and a foreign identity conflict to the same generic result', async () => {
    dependencies.claimGuestPurchases.mockResolvedValueOnce({
      claimed: false,
      changed: false,
      claimedOrderCount: 0,
      claimedTitleCount: 0
    });
    const noPurchase = await load(event() as never);
    dependencies.claimGuestPurchases.mockRejectedValueOnce(
      new CommerceConflictError('IDENTITY_ALREADY_CLAIMED')
    );
    const conflict = await load(event() as never);
    expect(noPurchase).toEqual({ state: 'not_claimed' });
    expect(conflict).toEqual(noPurchase);
    const { body } = render(CompletePage, {
      props: { data: { user: null, ...noPurchase } as never }
    });
    expect(body).not.toContain('href="/library"');
    expect(body).toContain('We could not attach purchases to this account');
  });

  it('maps an auth-link error to retry guidance without touching claim state', async () => {
    const data = await load(event({ search: '?error=private-provider-detail' }) as never);
    expect(data).toEqual({ state: 'retry' });
    expect(dependencies.claimGuestPurchases).not.toHaveBeenCalled();
    const { body } = render(CompletePage, { props: { data: { user: null, ...data } as never } });
    expect(body).toContain('Request another claim link');
    expect(body).not.toContain('private-provider-detail');
  });

  it('never claims for a verified session without the one-use emailed authorization', async () => {
    const data = await load(event({ authorizationToken: null }) as never);
    expect(data).toEqual({ state: 'not_claimed' });
    expect(dependencies.claimGuestPurchases).not.toHaveBeenCalled();
  });

  it.each([
    {
      actor: { type: 'anonymous' },
      user: null,
      session: null
    },
    {
      ...verifiedLocals,
      user: { ...verifiedLocals.user, emailVerified: false }
    },
    {
      ...verifiedLocals,
      session: null
    }
  ])('requires a verified current session', async (locals) => {
    const data = await load(event({ locals }) as never);
    expect(data).toEqual({ state: 'sign_in' });
    expect(dependencies.claimGuestPurchases).not.toHaveBeenCalled();
    const { body } = render(CompletePage, {
      props: { data: { user: null, ...data } as never }
    });
    expect(body).toContain('returnTo=%2Fclaim%2Fcomplete');
  });

  it('renders a safe temporary state for unexpected failures', async () => {
    dependencies.claimGuestPurchases.mockRejectedValueOnce(
      new Error('database private@example.com order secret')
    );
    const data = await load(event() as never);
    expect(data).toEqual({ state: 'unavailable' });
    expect(dependencies.deleteCookie).not.toHaveBeenCalled();
    expect(JSON.stringify(data)).not.toMatch(/database|example|order/iu);
  });
});
