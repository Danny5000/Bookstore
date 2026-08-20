import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { wrapCommerceClaimActionUrl } from './commerce-claim-capability';
import {
  commerceClaimMetadataSchema,
  sendRoutedPasswordReset,
  sendRoutedMagicLink
} from './options';

function dependencies() {
  const claimProofToken = 'P'.repeat(43);
  const now = new Date('2026-08-15T12:00:00.000Z');
  return {
    canSendMagicLink: vi.fn(async () => true),
    canSendCommerceMagicLink: vi.fn(async () => true),
    queueMagicEmail: vi.fn(async () => undefined),
    queueCommerceClaimEmail: vi.fn(async () => undefined),
    registerMagicLink: vi.fn(async () => true),
    createCommerceClaimProofToken: vi.fn(() => claimProofToken),
    now: vi.fn(() => now),
    registerCommerceClaimIssuance: vi.fn(async () => true),
    trustedOrigin: 'https://books.example.com',
    wrapCommerceClaimActionUrl: vi.fn(wrapCommerceClaimActionUrl)
  };
}

const email = 'reader@example.com';
const url = 'https://books.example.com/api/auth/magic-link/verify?' +
  'token=private-token&callbackURL=%2Fclaim%2Fcomplete&' +
  'newUserCallbackURL=%2Fclaim%2Fcomplete&' +
  'errorCallbackURL=%2Fclaim%2Fcomplete%3Ferror%3Dmagic-link';

describe('magic-link email metadata routing', () => {
  it('keeps absent metadata on the generic auth email path', async () => {
    const deps = dependencies();
    await sendRoutedMagicLink(deps, { email, url, token: 'private-token', metadata: undefined }, 900);
    expect(deps.canSendMagicLink).toHaveBeenCalledWith(email);
    expect(deps.queueMagicEmail).toHaveBeenCalledWith({
      template: 'auth.magic-link',
      to: email,
      recipientName: email,
      actionUrl: url,
      expiresInSeconds: 900
    });
    expect(deps.registerMagicLink).toHaveBeenCalledWith({
      token: 'private-token', email, purpose: 'account', expiresInSeconds: 900
    });
    expect(deps.queueCommerceClaimEmail).not.toHaveBeenCalled();
  });

  it('routes only exact commerce metadata to the claim receipt callback', async () => {
    const deps = dependencies();
    const orderId = randomUUID();
    const metadata = { purpose: 'commerce-claim', orderId };
    expect(commerceClaimMetadataSchema.parse(metadata)).toEqual(metadata);
    await sendRoutedMagicLink(deps, { email, url, token: 'private-token', metadata }, 900);
    expect(deps.registerMagicLink).toHaveBeenCalledWith({
      token: 'private-token', email, purpose: 'commerce-claim', expiresInSeconds: 900
    });
    expect(deps.registerCommerceClaimIssuance).toHaveBeenCalledWith({
      claimProofSha256: createHash('sha256').update('P'.repeat(43)).digest('hex'),
      authTokenSha256: createHash('sha256').update('private-token').digest('hex'),
      email,
      anchorOrderId: orderId,
      kind: 'commerce-magic',
      expiresAt: new Date('2026-08-15T12:15:00.000Z')
    });
    expect(deps.createCommerceClaimProofToken).toHaveBeenCalledOnce();
    expect(deps.wrapCommerceClaimActionUrl).toHaveBeenCalledWith({
      actionUrl: url,
      claimProofToken: 'P'.repeat(43),
      anchorOrderId: orderId,
      kind: 'commerce-magic',
      trustedOrigin: 'https://books.example.com'
    });
    expect(deps.queueCommerceClaimEmail).toHaveBeenCalledWith({
      orderId,
      email,
      claimUrl: deps.wrapCommerceClaimActionUrl.mock.results[0]?.value
    });
    const bridge = new URL(deps.wrapCommerceClaimActionUrl.mock.results[0]?.value ?? '');
    expect(`${bridge.pathname}${bridge.search}`).toBe('/claim/authorize');
    expect(bridge.hash).not.toBe('');
    expect(deps.registerCommerceClaimIssuance.mock.invocationCallOrder[0])
      .toBeLessThan(deps.registerMagicLink.mock.invocationCallOrder[0] ?? 0);
    expect(deps.registerCommerceClaimIssuance.mock.invocationCallOrder[0])
      .toBeLessThan(deps.queueCommerceClaimEmail.mock.invocationCallOrder[0] ?? 0);
    expect(JSON.stringify(deps.registerCommerceClaimIssuance.mock.calls[0])).not.toContain(
      'P'.repeat(43)
    );
    expect(JSON.stringify(deps.registerCommerceClaimIssuance.mock.calls[0]))
      .not.toContain('private-token');
    expect(deps.canSendCommerceMagicLink).toHaveBeenCalledWith(email);
    expect(deps.queueMagicEmail).not.toHaveBeenCalled();
  });

  it('fails closed before queueing commerce mail when protected issuance cannot register', async () => {
    const deps = dependencies();
    deps.registerCommerceClaimIssuance.mockResolvedValueOnce(false);

    await sendRoutedMagicLink(deps, {
      email,
      url,
      token: 'private-token',
      metadata: { purpose: 'commerce-claim', orderId: randomUUID() }
    }, 900);

    expect(deps.registerCommerceClaimIssuance).toHaveBeenCalledOnce();
    expect(deps.registerMagicLink).not.toHaveBeenCalled();
    expect(deps.queueCommerceClaimEmail).not.toHaveBeenCalled();
    expect(deps.queueMagicEmail).not.toHaveBeenCalled();
  });

  it('does not create a native commerce marker on a web auth server without worker issuance', async () => {
    const {
      registerCommerceClaimIssuance: workerOnlyRegistration,
      ...webDependencies
    } = dependencies();
    expect(workerOnlyRegistration).toBeTypeOf('function');

    await sendRoutedMagicLink(webDependencies, {
      email,
      url,
      token: 'private-token',
      metadata: { purpose: 'commerce-claim', orderId: randomUUID() }
    }, 900);

    expect(webDependencies.registerMagicLink).not.toHaveBeenCalled();
    expect(webDependencies.queueCommerceClaimEmail).not.toHaveBeenCalled();
    expect(webDependencies.queueMagicEmail).not.toHaveBeenCalled();
  });

  it('suppresses commerce metadata when credential proof still blocks magic sign-in', async () => {
    const deps = dependencies();
    deps.canSendCommerceMagicLink.mockResolvedValueOnce(false);
    await sendRoutedMagicLink(deps, {
      email,
      url,
      token: 'private-token',
      metadata: { purpose: 'commerce-claim', orderId: randomUUID() }
    }, 900);
    expect(deps.queueCommerceClaimEmail).not.toHaveBeenCalled();
    expect(deps.queueMagicEmail).not.toHaveBeenCalled();
    expect(deps.registerMagicLink).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    { purpose: 'commerce-claim' as const, orderId: randomUUID() }
  ])('does not queue mail when the generation marker cannot be registered', async (metadata) => {
    const deps = dependencies();
    deps.registerMagicLink.mockResolvedValueOnce(false);
    await sendRoutedMagicLink(deps, {
      email,
      url,
      token: 'private-token',
      metadata
    }, 900);
    expect(deps.queueCommerceClaimEmail).not.toHaveBeenCalled();
    expect(deps.queueMagicEmail).not.toHaveBeenCalled();
    if (metadata) {
      expect(deps.registerCommerceClaimIssuance).toHaveBeenCalledOnce();
      expect(deps.registerCommerceClaimIssuance.mock.invocationCallOrder[0])
        .toBeLessThan(deps.registerMagicLink.mock.invocationCallOrder[0] ?? 0);
      expect(deps.wrapCommerceClaimActionUrl).not.toHaveBeenCalled();
    }
  });

  it.each([
    null,
    {},
    { purpose: 'commerce-claim' },
    { purpose: 'other', orderId: randomUUID() },
    { purpose: 'commerce-claim', orderId: 'not-a-uuid' },
    { purpose: 'commerce-claim', orderId: randomUUID(), email: 'victim@example.com' }
  ])('silently suppresses invalid or expanded metadata without generic fallback', async (metadata) => {
    const deps = dependencies();
    await sendRoutedMagicLink(deps, { email, url, token: 'private-token', metadata }, 900);
    expect(deps.queueCommerceClaimEmail).not.toHaveBeenCalled();
    expect(deps.queueMagicEmail).not.toHaveBeenCalled();
    expect(deps.canSendMagicLink).not.toHaveBeenCalled();
    expect(deps.canSendCommerceMagicLink).not.toHaveBeenCalled();
  });

  it('does not log a token or action URL while routing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const deps = dependencies();
    await sendRoutedMagicLink(deps, {
      email,
      url,
      token: 'private-token',
      metadata: { purpose: 'commerce-claim', orderId: randomUUID() }
    }, 900);
    expect(log).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

describe('password-reset email metadata routing', () => {
  function resetDependencies() {
    const claimProofToken = 'R'.repeat(43);
    return {
      queueResetEmail: vi.fn(async () => undefined),
      registerPasswordResetToken: vi.fn(async () => true),
      createCommerceClaimProofToken: vi.fn(() => claimProofToken),
      registerCommerceClaimIssuance: vi.fn(async () => true),
      wrapCommerceClaimActionUrl: vi.fn(wrapCommerceClaimActionUrl),
      trustedOrigin: 'https://books.example.com',
      now: vi.fn(() => new Date('2026-08-15T12:00:00.000Z'))
    };
  }

  const resetUser = {
    id: randomUUID(),
    email: 'reader@example.com',
    name: 'Reader'
  };

  it('registers protected commerce proof before rotating the native reset marker', async () => {
    const deps = resetDependencies();
    const orderId = randomUUID();
    const action = new URL('https://books.example.com/api/auth/reset-password/private-token');
    action.searchParams.set(
      'callbackURL',
      `/reset-password?purpose=commerce-claim&orderId=${orderId}`
    );

    await sendRoutedPasswordReset(deps, {
      user: resetUser,
      url: action.toString(),
      token: 'private-token'
    }, 900);

    expect(deps.registerCommerceClaimIssuance.mock.invocationCallOrder[0])
      .toBeLessThan(deps.registerPasswordResetToken.mock.invocationCallOrder[0] ?? 0);
    expect(deps.queueResetEmail).toHaveBeenCalledOnce();
  });

  it('does not create a native reset marker when protected issuance is rejected', async () => {
    const deps = resetDependencies();
    deps.registerCommerceClaimIssuance.mockResolvedValueOnce(false);
    const orderId = randomUUID();
    const action = new URL('https://books.example.com/api/auth/reset-password/private-token');
    action.searchParams.set(
      'callbackURL',
      `/reset-password?purpose=commerce-claim&orderId=${orderId}`
    );

    await sendRoutedPasswordReset(deps, {
      user: resetUser,
      url: action.toString(),
      token: 'private-token'
    }, 900);

    expect(deps.registerCommerceClaimIssuance).toHaveBeenCalledOnce();
    expect(deps.registerPasswordResetToken).not.toHaveBeenCalled();
    expect(deps.queueResetEmail).not.toHaveBeenCalled();
  });

  it('does not expose the protected issuance when native reset registration fails', async () => {
    const deps = resetDependencies();
    deps.registerPasswordResetToken.mockResolvedValueOnce(false);
    const orderId = randomUUID();
    const action = new URL('https://books.example.com/api/auth/reset-password/private-token');
    action.searchParams.set(
      'callbackURL',
      `/reset-password?purpose=commerce-claim&orderId=${orderId}`
    );

    await sendRoutedPasswordReset(deps, {
      user: resetUser,
      url: action.toString(),
      token: 'private-token'
    }, 900);

    expect(deps.registerCommerceClaimIssuance).toHaveBeenCalledOnce();
    expect(deps.registerPasswordResetToken).toHaveBeenCalledOnce();
    expect(deps.registerCommerceClaimIssuance.mock.invocationCallOrder[0])
      .toBeLessThan(deps.registerPasswordResetToken.mock.invocationCallOrder[0] ?? 0);
    expect(deps.wrapCommerceClaimActionUrl).not.toHaveBeenCalled();
    expect(deps.queueResetEmail).not.toHaveBeenCalled();
  });
});
