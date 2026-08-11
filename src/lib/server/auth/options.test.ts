import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  commerceClaimMetadataSchema,
  sendRoutedMagicLink
} from './options';

function dependencies() {
  return {
    canSendMagicLink: vi.fn(async () => true),
    canSendCommerceMagicLink: vi.fn(async () => true),
    queueMagicEmail: vi.fn(async () => undefined),
    queueCommerceClaimEmail: vi.fn(async () => undefined),
    registerMagicLink: vi.fn(async () => true)
  };
}

const email = 'reader@example.com';
const url = 'https://books.example.com/api/auth/magic-link/verify?token=private-token';

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
    expect(deps.queueCommerceClaimEmail).toHaveBeenCalledWith({
      orderId,
      email,
      claimUrl: url
    });
    expect(deps.canSendCommerceMagicLink).toHaveBeenCalledWith(email);
    expect(deps.queueMagicEmail).not.toHaveBeenCalled();
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
