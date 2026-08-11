import { randomUUID } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError } from 'better-auth/api';
import { createAuthClient } from 'better-auth/client';
import { hashPassword } from 'better-auth/crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { registerEmailVerificationToken } from '$lib/server/auth/email-verification';
import {
  completePasswordResetSecurity,
  registerPasswordResetToken
} from '$lib/server/auth/commerce-claim-authorization';
import { createAuthServer } from '$lib/server/auth/options';
import {
  canSendCommerceMagicLink,
  canSendMagicLink,
  ensureCustomerRole
} from '$lib/server/auth/identity';
import { loadApplicationConfig } from '$lib/server/config/load';
import {
  account,
  credentialAuthority,
  jobs,
  outboxMessages,
  session,
  user,
  userRoles,
  verification
} from '$lib/server/db/schema';
import { queueAuthEmail } from '$lib/server/email/enqueue';
import { authEmailPayloadSchema, type AuthEmailPayload } from '$lib/server/email/payload';
import { databaseClient } from './database';

const config = loadApplicationConfig(process.env);
const password = 'A-secure-test-password-2026';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settled) => { resolve = settled; });
  return { promise, resolve };
}

function createTestAuth(
  overrides: Partial<Parameters<typeof createAuthServer>[0]> = {}
) {
  return createAuthServer({
    database: databaseClient.db,
    config,
    queueVerificationEmail: (input) => queueAuthEmail(databaseClient.db, input),
    queueResetEmail: (input) => queueAuthEmail(databaseClient.db, input),
    queueMagicEmail: (input) => queueAuthEmail(databaseClient.db, input),
    queueCommerceClaimEmail: async () => undefined,
    canSendMagicLink: (email) => canSendMagicLink(databaseClient.db, email),
    canSendCommerceMagicLink: (email) => canSendCommerceMagicLink(databaseClient.db, email),
    onUserCreated: (userId) => ensureCustomerRole(databaseClient.db, userId),
    ...overrides
  });
}

type TestAuth = ReturnType<typeof createTestAuth>;

async function authRequest(
  auth: TestAuth,
  pathOrUrl: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string;
    ip?: string;
  } = {}
) {
  const url = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : `${config.origin}/api/auth${pathOrUrl}`;
  const headers = new Headers({ origin: config.origin });
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (options.cookie) headers.set('cookie', options.cookie);
  if (options.ip) headers.set('x-forwarded-for', options.ip);
  const requestOptions: RequestInit = {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    redirect: 'manual'
  };
  if (options.body !== undefined) requestOptions.body = JSON.stringify(options.body);
  return auth.handler(new Request(url, requestOptions));
}

function cookiePair(response: Response): string {
  const value = response.headers.get('set-cookie');
  if (!value) throw new Error('Expected a session cookie');
  const pair = value.split(';', 1)[0];
  if (!pair) throw new Error('Expected a session cookie pair');
  return pair;
}

async function expectMagicSessionRejected(response: Response): Promise<void> {
  expect(response.status).toBe(401);
  expect(await response.clone().json()).toEqual({
    code: 'INVALID_TOKEN',
    message: 'Invalid or expired authentication link'
  });
  const expiredCookie = response.headers.get('set-cookie') ?? '';
  expect(expiredCookie).toMatch(/(?:better-auth|__Secure-better-auth)\.session_token=/u);
  expect(expiredCookie).toMatch(/Max-Age=0/iu);
}

async function queuedMessages(): Promise<AuthEmailPayload[]> {
  const rows = await databaseClient.db.select().from(outboxMessages);
  return rows.map((row) => authEmailPayloadSchema.parse(row.payload));
}

async function latestMessage(template: AuthEmailPayload['template'], email: string) {
  const messages = await queuedMessages();
  const message = messages.findLast((entry) => entry.template === template && entry.to === email);
  if (!message) throw new Error(`Expected queued ${template} email`);
  return message;
}

async function register(auth: TestAuth, email = `${randomUUID()}@example.com`) {
  const response = await authRequest(auth, '/sign-up/email', {
    body: { name: 'Test Reader', email: email.toUpperCase(), password, callbackURL: '/' },
    ip: '192.0.2.10'
  });
  expect(response.status).toBe(200);
  return { email, response };
}

async function registerAndVerify(auth: TestAuth) {
  const registration = await register(auth);
  const message = await latestMessage('auth.email-verification', registration.email);
  const verificationResponse = await authRequest(auth, message.actionUrl);
  expect(verificationResponse.status).toBeGreaterThanOrEqual(200);
  expect(verificationResponse.status).toBeLessThan(400);
  expect(verificationResponse.headers.get('set-cookie')).toBeNull();
  const signedIn = await authRequest(auth, '/sign-in/email', {
    body: { email: registration.email, password },
    ip: '192.0.2.11'
  });
  expect(signedIn.status).toBe(200);
  return { ...registration, cookie: cookiePair(signedIn), message };
}

describe('Better Auth server', () => {
  it('purges expired project email-verification markers during registration', async () => {
    await registerEmailVerificationToken(databaseClient.db, {
      token: 'expired-token',
      email: 'expired@example.com',
      expiresInSeconds: -1
    });
    expect(await databaseClient.db.select().from(verification)).toHaveLength(1);
    await databaseClient.db.insert(verification).values({
      identifier: 'better-auth-owned-reset-token',
      value: 'reset@example.com',
      expiresAt: new Date(0)
    });

    await registerEmailVerificationToken(databaseClient.db, {
      token: 'current-token',
      email: 'current@example.com',
      expiresInSeconds: 60
    });
    const remainingValues = (await databaseClient.db.select().from(verification))
      .map((row) => row.value);
    expect(remainingValues).toContain('reset@example.com');
    expect(remainingValues).toContainEqual(expect.stringContaining('current@example.com'));
  });

  it('registers, verifies once without auto-sign-in, then establishes a hardened cookie', async () => {
    const auth = createTestAuth();
    const { email, response } = await register(auth);
    const registration = (await response.json()) as { token: string | null; user: { id: string } };
    expect(registration.token).toBeNull();
    expect(registration.user.id).toMatch(/^[0-9a-f-]{36}$/);

    expect(await databaseClient.db.select().from(user).where(eq(user.email, email))).toHaveLength(1);
    expect(
      await databaseClient.db.select().from(account).where(eq(account.userId, registration.user.id))
    ).toHaveLength(1);
    expect(
      await databaseClient.db
        .select({
          userId: credentialAuthority.userId,
          resetEpochSha256: credentialAuthority.resetEpochSha256
        })
        .from(credentialAuthority)
        .where(eq(credentialAuthority.userId, registration.user.id))
    ).toEqual([{ userId: registration.user.id, resetEpochSha256: null }]);
    expect(
      await databaseClient.db.select().from(userRoles).where(eq(userRoles.userId, registration.user.id))
    ).toEqual([expect.objectContaining({ role: 'customer' })]);
    expect(
      await databaseClient.db.select().from(session).where(eq(session.userId, registration.user.id))
    ).toHaveLength(0);
    expect(await databaseClient.db.select().from(outboxMessages)).toEqual([
      expect.objectContaining({ status: 'pending' })
    ]);
    expect(await databaseClient.db.select().from(verification)).toHaveLength(1);
    expect(await databaseClient.db.select().from(jobs)).toEqual([
      expect.objectContaining({ status: 'pending', type: 'outbox.dispatch' })
    ]);

    const message = await latestMessage('auth.email-verification', email);
    expect(message.actionUrl).toMatch(
      new RegExp(`^${config.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/api/auth/verify-email\\?`)
    );
    const verified = await authRequest(auth, message.actionUrl);
    expect(verified.headers.get('set-cookie')).toBeNull();
    expect(await databaseClient.db.select().from(session)).toHaveLength(0);
    expect(await databaseClient.db.select().from(verification)).toHaveLength(0);

    const reused = await authRequest(auth, message.actionUrl);
    expect(reused.status).toBe(302);
    expect(reused.headers.get('location')).toContain('error=INVALID_TOKEN');
    expect(reused.headers.get('set-cookie')).toBeNull();
    expect(await databaseClient.db.select().from(session)).toHaveLength(0);

    const signedIn = await authRequest(auth, '/sign-in/email', {
      body: { email, password },
      ip: '192.0.2.12'
    });
    const setCookie = signedIn.headers.get('set-cookie') ?? '';
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');
    expect(setCookie.toLowerCase()).not.toContain('secure');
    const cookie = cookiePair(signedIn);
    expect(await databaseClient.db.select().from(session)).toHaveLength(1);

    const current = await authRequest(auth, '/get-session', { cookie });
    expect(current.status).toBe(200);
    expect(await current.json()).toEqual(expect.objectContaining({ user: expect.objectContaining({ email }) }));
    const signedOut = await authRequest(auth, '/sign-out', { method: 'POST', body: {}, cookie });
    expect(signedOut.status).toBe(200);
    expect(await databaseClient.db.select().from(session)).toHaveLength(0);
  });

  it('supports verified password sign-in without account enumeration and rate limits attempts', async () => {
    const auth = createTestAuth();
    const { email } = await registerAndVerify(auth);
    const signedIn = await authRequest(auth, '/sign-in/email', {
      body: { email, password },
      ip: '192.0.2.20'
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get('set-cookie')).not.toBeNull();

    const wrong = await authRequest(auth, '/sign-in/email', {
      body: { email, password: 'incorrect-password' },
      ip: '192.0.2.21'
    });
    const unknown = await authRequest(auth, '/sign-in/email', {
      body: { email: `${randomUUID()}@example.com`, password: 'incorrect-password' },
      ip: '192.0.2.22'
    });
    expect(wrong.status).toBe(unknown.status);
    expect((await wrong.json()) as object).toEqual(await unknown.json());

    const statuses: number[] = [];
    for (let attempt = 0; attempt <= config.auth.rateLimit.loginMax; attempt += 1) {
      const response = await authRequest(auth, '/sign-in/email', {
        body: { email, password: 'incorrect-password' },
        ip: '192.0.2.23'
      });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, config.auth.rateLimit.loginMax)).not.toContain(429);
    expect(statuses.at(-1)).toBe(429);
  });

  it('queues and consumes a one-use reset while revoking prior sessions', async () => {
    const auth = createTestAuth();
    const { email } = await registerAndVerify(auth);
    const secondSession = await authRequest(auth, '/sign-in/email', {
      body: { email, password },
      ip: '192.0.2.30'
    });
    expect(secondSession.status).toBe(200);
    expect(await databaseClient.db.select().from(session)).toHaveLength(2);

    const requested = await authRequest(auth, '/request-password-reset', {
      body: { email, redirectTo: `${config.origin}/reset-password` },
      ip: '192.0.2.31'
    });
    expect(requested.status).toBe(200);
    const resetMarkers = await databaseClient.db.select().from(verification);
    expect(resetMarkers).toHaveLength(2);
    expect(resetMarkers.some((row) => row.identifier.startsWith('reset-password:'))).toBe(true);
    expect(resetMarkers.some((row) =>
      row.identifier.startsWith('pale-orbit:auth-password-reset:')
    )).toBe(true);
    const resetMessage = await latestMessage('auth.password-reset', email);
    expect(resetMessage.actionUrl).toContain(`${config.origin}/api/auth/reset-password/`);
    const token = new URL(resetMessage.actionUrl).pathname.split('/').at(-1);
    if (!token) throw new Error('Expected reset token in queued link');

    const reset = await authRequest(auth, '/reset-password', {
      body: { token, newPassword: 'A-new-secure-password-2026' }
    });
    expect(reset.status).toBe(200);
    expect(await databaseClient.db.select().from(session)).toHaveLength(0);
    const reused = await authRequest(auth, '/reset-password', {
      body: { token, newPassword: 'Another-secure-password-2026' }
    });
    expect(reused.status).toBe(400);
  });

  it('queues only a reset whose native token survived concurrent issuance', async () => {
    const auth = createTestAuth();
    const { email } = await registerAndVerify(auth);
    const firstRegistrationEntered = deferred();
    const releaseFirstRegistration = deferred();
    let registrations = 0;
    const racingAuth = createTestAuth({
      registerPasswordResetToken: async (database, input) => {
        registrations += 1;
        if (registrations === 1) {
          firstRegistrationEntered.resolve();
          await releaseFirstRegistration.promise;
        }
        return registerPasswordResetToken(database, input);
      }
    });

    const firstRequest = authRequest(racingAuth, '/request-password-reset', {
      body: { email, redirectTo: '/reset-password' },
      ip: '192.0.2.81'
    });
    try {
      await firstRegistrationEntered.promise;
      expect((await authRequest(racingAuth, '/request-password-reset', {
        body: { email, redirectTo: '/reset-password' },
        ip: '192.0.2.82'
      })).status).toBe(200);
    } finally {
      releaseFirstRegistration.resolve();
    }
    expect((await firstRequest).status).toBe(200);

    const resetMessages = (await queuedMessages())
      .filter((message) => message.template === 'auth.password-reset' && message.to === email);
    expect(resetMessages).toHaveLength(1);
    const currentToken = new URL(resetMessages[0]!.actionUrl).pathname.split('/').at(-1);
    if (!currentToken) throw new Error('Expected current reset token');
    expect((await authRequest(auth, '/reset-password', {
      body: { token: currentToken, newPassword: 'Concurrent-issuance-password-2026' }
    })).status).toBe(200);
    expect((await authRequest(auth, '/sign-in/email', {
      body: { email, password: 'Concurrent-issuance-password-2026' },
      ip: '192.0.2.83'
    })).status).toBe(200);
  }, 20_000);

  it('fails closed when credential authority is missing and recovers only through mailbox reset', async () => {
    const auth = createTestAuth();
    const { email } = await registerAndVerify(auth);
    const [registeredUser] = await databaseClient.db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email));
    if (!registeredUser) throw new Error('Expected credential user');
    await databaseClient.db.delete(session).where(eq(session.userId, registeredUser.id));
    await databaseClient.db
      .delete(credentialAuthority)
      .where(eq(credentialAuthority.userId, registeredUser.id));
    let rejectedConstraint: unknown;
    try {
      await databaseClient.db.insert(credentialAuthority).values({
        userId: registeredUser.id,
        authorizedPasswordHash: null,
        resetEpochSha256: null
      });
    } catch (cause) {
      rejectedConstraint = cause;
    }
    expect((rejectedConstraint as { cause?: { constraint?: string } })?.cause?.constraint)
      .toBe('credential_authority_has_authorized_hash_or_active_reset');

    const correctPassword = await authRequest(auth, '/sign-in/email', {
      body: { email, password },
      ip: '192.0.2.24'
    });
    const ordinaryWrongPassword = await authRequest(auth, '/sign-in/email', {
      body: { email, password: 'Definitely-not-the-password-2026' },
      ip: '192.0.2.25'
    });
    expect(correctPassword.status).toBe(ordinaryWrongPassword.status);
    expect(await correctPassword.json()).toEqual(await ordinaryWrongPassword.json());
    expect(await databaseClient.db.select().from(session)).toHaveLength(0);

    const priorMessages = (await queuedMessages()).length;
    expect((await authRequest(auth, '/sign-in/magic-link', {
      body: { email, callbackURL: '/' },
      ip: '192.0.2.26'
    })).status).toBe(200);
    expect(await queuedMessages()).toHaveLength(priorMessages);

    expect((await authRequest(auth, '/request-password-reset', {
      body: { email, redirectTo: '/reset-password' },
      ip: '192.0.2.27'
    })).status).toBe(200);
    const resetMessage = await latestMessage('auth.password-reset', email);
    const token = new URL(resetMessage.actionUrl).pathname.split('/').at(-1);
    if (!token) throw new Error('Expected recovery reset token');
    const recoveredPassword = 'Missing-authority-recovered-password-2026';
    expect((await authRequest(auth, '/reset-password', {
      body: { token, newPassword: recoveredPassword }
    })).status).toBe(200);
    expect((await authRequest(auth, '/sign-in/email', {
      body: { email, password: recoveredPassword },
      ip: '192.0.2.28'
    })).status).toBe(200);
  });

  it('fails closed after claim-proof creation fails without preserving old credentials or sessions', async () => {
    const auth = createTestAuth({
      completePasswordResetSecurity: async () => {
        throw new Error('injected claim-proof persistence failure');
      }
    });
    const { email, cookie } = await registerAndVerify(auth);
    const requested = await authRequest(auth, '/request-password-reset', {
      body: { email, redirectTo: '/reset-password?purpose=commerce-claim' },
      ip: '192.0.2.44'
    });
    expect(requested.status).toBe(200);
    const resetMessage = await latestMessage('auth.password-reset', email);
    const token = new URL(resetMessage.actionUrl).pathname.split('/').at(-1);
    if (!token) throw new Error('Expected commerce reset token');

    const newPassword = 'Proof-failure-new-password-2026';
    const reset = await authRequest(auth, '/reset-password', {
      body: { token, newPassword }
    });
    expect(reset.status).toBeGreaterThanOrEqual(500);
    expect(reset.headers.get('set-cookie') ?? '').not.toContain(
      'pale-orbit-commerce-claim='
    );
    expect(await databaseClient.db.select().from(session)).toHaveLength(0);
    expect(await (await authRequest(auth, '/get-session', { cookie })).json()).toBeNull();
    expect((await authRequest(auth, '/sign-in/email', {
      body: { email, password },
      ip: '192.0.2.45'
    })).status).not.toBe(200);
    expect((await authRequest(auth, '/sign-in/email', {
      body: { email, password: newPassword },
      ip: '192.0.2.46'
    })).status).not.toBe(200);
    expect((await databaseClient.db.select().from(verification)).some((row) =>
      row.identifier.startsWith('pale-orbit:commerce-claim-authorization:')
    )).toBe(false);

    const recoveryAuth = createTestAuth();
    const recoveredPassword = 'Proof-failure-recovered-password-2026';
    expect((await authRequest(recoveryAuth, '/request-password-reset', {
      body: { email, redirectTo: '/reset-password?purpose=commerce-claim' },
      ip: '192.0.2.47'
    })).status).toBe(200);
    const recoveryMessage = await latestMessage('auth.password-reset', email);
    const recoveryToken = new URL(recoveryMessage.actionUrl).pathname.split('/').at(-1);
    if (!recoveryToken) throw new Error('Expected recovery reset token');
    expect((await authRequest(recoveryAuth, '/reset-password', {
      body: { token: recoveryToken, newPassword: recoveredPassword }
    })).status).toBe(200);
    expect((await authRequest(recoveryAuth, '/sign-in/email', {
      body: { email, password: recoveredPassword },
      ip: '192.0.2.48'
    })).status).toBe(200);
  });

  it('blocks in-session password changes so recovery cannot be overwritten after revocation', async () => {
    const auth = createTestAuth();
    const { email, cookie } = await registerAndVerify(auth);
    const replacement = 'Blocked-change-password-2026';
    const changed = await authRequest(auth, '/change-password', {
      body: { currentPassword: password, newPassword: replacement },
      cookie,
      ip: '192.0.2.47'
    });
    expect(changed.status).toBe(403);
    expect((await authRequest(auth, '/sign-in/email', {
      body: { email, password: replacement },
      ip: '192.0.2.48'
    })).status).not.toBe(200);
    expect((await authRequest(auth, '/sign-in/email', {
      body: { email, password },
      ip: '192.0.2.49'
    })).status).toBe(200);
  });

  it('deletes a late old-password session created after reset revocation', async () => {
    const auth = createTestAuth();
    const { email } = await registerAndVerify(auth);
    const requested = await authRequest(auth, '/request-password-reset', {
      body: { email, redirectTo: '/reset-password' },
      ip: '192.0.2.50'
    });
    expect(requested.status).toBe(200);
    const resetMessage = await latestMessage('auth.password-reset', email);
    const token = new URL(resetMessage.actionUrl).pathname.split('/').at(-1);
    if (!token) throw new Error('Expected reset token');

    const sessionCreateEntered = deferred();
    const releaseSessionCreate = deferred();
    const barrierPlugin = {
      id: `session-create-barrier-${randomUUID()}`,
      init: () => ({
        options: {
          databaseHooks: {
            session: {
              create: {
                before: async () => {
                  sessionCreateEntered.resolve();
                  await releaseSessionCreate.promise;
                }
              }
            }
          }
        }
      })
    } satisfies BetterAuthPlugin;
    const racingAuth = createTestAuth({ additionalPlugins: [barrierPlugin] });
    const lateSignIn = authRequest(racingAuth, '/sign-in/email', {
      body: { email, password },
      ip: '192.0.2.51'
    });
    const newPassword = 'Late-race-victim-password-2026';
    try {
      await sessionCreateEntered.promise;
      const reset = await authRequest(auth, '/reset-password', {
        body: { token, newPassword }
      });
      expect(reset.status).toBe(200);
    } finally {
      releaseSessionCreate.resolve();
    }
    const rejectedLateSession = await lateSignIn;
    const ordinaryWrongPassword = await authRequest(auth, '/sign-in/email', {
      body: { email, password: 'Definitely-not-the-current-password-2026' },
      ip: '192.0.2.54'
    });
    expect(rejectedLateSession.status).toBe(401);
    expect(rejectedLateSession.status).toBe(ordinaryWrongPassword.status);
    expect(await rejectedLateSession.clone().json()).toEqual(
      await ordinaryWrongPassword.clone().json()
    );
    expect(JSON.stringify(await rejectedLateSession.clone().json())).not.toMatch(
      /race|reset|session|credential|digest/iu
    );
    const expiredCookie = rejectedLateSession.headers.get('set-cookie') ?? '';
    expect(expiredCookie).toMatch(/(?:better-auth|__Secure-better-auth)\.session_token=/u);
    expect(expiredCookie).toMatch(/Max-Age=0/iu);
    expect(await databaseClient.db.select().from(session)).toHaveLength(0);
    expect((await authRequest(auth, '/sign-in/email', {
      body: { email, password },
      ip: '192.0.2.52'
    })).status).not.toBe(200);
    expect((await authRequest(auth, '/sign-in/email', {
      body: { email, password: newPassword },
      ip: '192.0.2.53'
    })).status).toBe(200);
  }, 15_000);

  it('deletes and generically rejects a password session when authority revalidation throws', async () => {
    const setupAuth = createTestAuth();
    const { email } = await registerAndVerify(setupAuth);
    await databaseClient.db.delete(session);
    const failingAuth = createTestAuth({
      credentialAuthorityAcceptsPassword: async () => {
        throw new Error('injected password authority read failure');
      }
    });

    const rejected = await authRequest(failingAuth, '/sign-in/email', {
      body: { email, password },
      ip: '192.0.2.71'
    });
    const ordinaryWrongPassword = await authRequest(setupAuth, '/sign-in/email', {
      body: { email, password: 'Definitely-not-the-current-password-2026' },
      ip: '192.0.2.72'
    });
    expect(rejected.status).toBe(401);
    expect(rejected.status).toBe(ordinaryWrongPassword.status);
    expect(await rejected.clone().json()).toEqual(await ordinaryWrongPassword.clone().json());
    const cookies = rejected.headers.get('set-cookie') ?? '';
    expect(cookies).toMatch(/(?:better-auth|__Secure-better-auth)\.session_token=/u);
    expect(cookies).toMatch(/Max-Age=0/iu);
    expect(cookies).not.toMatch(
      /(?:better-auth|__Secure-better-auth)\.session_token=[^;]/u
    );
    expect(await databaseClient.db.select().from(session)).toHaveLength(0);
  });

  it('deletes and generically rejects a magic session when generation revalidation throws', async () => {
    const setupAuth = createTestAuth();
    const email = `${randomUUID()}@example.com`;
    expect((await authRequest(setupAuth, '/sign-in/magic-link', {
      body: { email, callbackURL: '/' },
      ip: '192.0.2.73'
    })).status).toBe(200);
    const magicMessage = await latestMessage('auth.magic-link', email);
    const failingAuth = createTestAuth({
      consumeAuthMagicLinkToken: async () => {
        throw new APIError('SERVICE_UNAVAILABLE', {
          code: 'INJECTED_GUARD_FAILURE',
          message: 'injected magic generation read failure'
        });
      }
    });

    const rejected = await authRequest(failingAuth, magicMessage.actionUrl);
    await expectMagicSessionRejected(rejected);
    expect(rejected.headers.get('location')).toBeNull();
    const cookies = rejected.headers.get('set-cookie') ?? '';
    expect(cookies).not.toMatch(
      /(?:better-auth|__Secure-better-auth)\.session_token=[^;]/u
    );
    expect(await databaseClient.db.select().from(session)).toHaveLength(0);
  });

  it('never returns a usable session token when rejected-session deletion also fails', async () => {
    const setupAuth = createTestAuth();
    const email = `${randomUUID()}@example.com`;
    expect((await authRequest(setupAuth, '/sign-in/magic-link', {
      body: { email, callbackURL: '/' },
      ip: '192.0.2.74'
    })).status).toBe(200);
    const magicMessage = await latestMessage('auth.magic-link', email);
    const failingAuth = createTestAuth({
      consumeAuthMagicLinkToken: async () => {
        throw new Error('injected magic generation read failure');
      },
      deleteCreatedSession: async () => {
        throw new Error('injected rejected-session cleanup failure');
      }
    });

    const rejected = await authRequest(failingAuth, magicMessage.actionUrl);
    await expectMagicSessionRejected(rejected);
    expect(rejected.headers.get('location')).toBeNull();
    const cookies = rejected.headers.get('set-cookie') ?? '';
    expect(cookies).not.toMatch(
      /(?:better-auth|__Secure-better-auth)\.session_token=[^;]/u
    );
    expect(await databaseClient.db.select().from(session)).toHaveLength(1);
    expect(JSON.stringify(await rejected.clone().json())).not.toMatch(
      /generation|cleanup|database|session/iu
    );
  });

  it('keeps the authorized password and an existing magic link usable while reset is only pending', async () => {
    const auth = createTestAuth();
    const { email } = await registerAndVerify(auth);
    expect((await authRequest(auth, '/sign-in/magic-link', {
      body: { email, callbackURL: '/' },
      ip: '192.0.2.58'
    })).status).toBe(200);
    const magicMessage = await latestMessage('auth.magic-link', email);

    expect((await authRequest(auth, '/request-password-reset', {
      body: { email, redirectTo: '/reset-password' },
      ip: '192.0.2.59'
    })).status).toBe(200);
    expect((await authRequest(auth, '/sign-in/email', {
      body: { email, password },
      ip: '192.0.2.57'
    })).status).toBe(200);

    const magicSession = await authRequest(auth, magicMessage.actionUrl);
    expect(magicSession.status).toBe(302);
    expect(magicSession.headers.get('set-cookie') ?? '')
      .toMatch(/(?:better-auth|__Secure-better-auth)\.session_token=/u);
    expect(magicSession.headers.get('set-cookie') ?? '')
      .not.toMatch(/pale-orbit-commerce-claim=/u);

    const resetMessage = await latestMessage('auth.password-reset', email);
    const resetToken = new URL(resetMessage.actionUrl).pathname.split('/').at(-1);
    if (!resetToken) throw new Error('Expected pending reset token');
    const resetAfterMagic = await authRequest(auth, '/reset-password', {
      body: {
        token: resetToken,
        newPassword: 'Magic-must-cancel-pending-reset-2026'
      }
    });
    expect(resetAfterMagic.status).not.toBe(200);
    expect((await authRequest(auth, '/sign-in/email', {
      body: { email, password },
      ip: '192.0.2.56'
    })).status).toBe(200);
  });

  it('accepts an owner-proving ordinary magic link after stripping an intervening unverified credential', async () => {
    const auth = createTestAuth();
    const email = `${randomUUID()}@example.com`;
    expect((await authRequest(auth, '/sign-in/magic-link', {
      body: { email, callbackURL: '/' },
      ip: '192.0.2.55'
    })).status).toBe(200);
    const magicMessage = await latestMessage('auth.magic-link', email);

    const userId = randomUUID();
    const insertedHash = await hashPassword('Intervening-unverified-password-2026');
    await databaseClient.db.insert(user).values({
      id: userId,
      name: 'Intervening unverified credential',
      email,
      emailVerified: false
    });
    await databaseClient.db.insert(account).values({
      id: randomUUID(),
      accountId: email,
      providerId: 'credential',
      userId,
      password: insertedHash
    });
    await databaseClient.db.insert(credentialAuthority).values({
      userId,
      authorizedPasswordHash: insertedHash
    });

    const verified = await authRequest(auth, magicMessage.actionUrl);
    expect(verified.status).toBe(302);
    const cookies = verified.headers.get('set-cookie') ?? '';
    expect(cookies).toMatch(/(?:better-auth|__Secure-better-auth)\.session_token=/u);
    expect(cookies).not.toContain('pale-orbit-commerce-claim=');
    expect(await databaseClient.db.select().from(account)
      .where(eq(account.userId, userId))).toHaveLength(0);
    expect(await databaseClient.db.select().from(credentialAuthority)
      .where(eq(credentialAuthority.userId, userId))).toHaveLength(0);
    expect(await databaseClient.db.select().from(session)
      .where(eq(session.userId, userId))).toHaveLength(1);

    expect((await authRequest(auth, '/sign-in/magic-link', {
      body: { email, callbackURL: '/' },
      ip: '192.0.2.54'
    })).status).toBe(200);
    const subsequentMagic = await latestMessage('auth.magic-link', email);
    expect(subsequentMagic.actionUrl).not.toBe(magicMessage.actionUrl);
    expect((await authRequest(auth, subsequentMagic.actionUrl)).status).toBe(302);
  });

  it('rejects an ordinary magic link issued before password reset', async () => {
    const auth = createTestAuth();
    const { email } = await registerAndVerify(auth);
    const magicRequested = await authRequest(auth, '/sign-in/magic-link', {
      body: { email, callbackURL: '/' },
      ip: '192.0.2.60'
    });
    expect(magicRequested.status).toBe(200);
    const staleMagic = await latestMessage('auth.magic-link', email);

    const resetRequested = await authRequest(auth, '/request-password-reset', {
      body: { email, redirectTo: '/reset-password' },
      ip: '192.0.2.61'
    });
    expect(resetRequested.status).toBe(200);
    const resetMessage = await latestMessage('auth.password-reset', email);
    const resetToken = new URL(resetMessage.actionUrl).pathname.split('/').at(-1);
    if (!resetToken) throw new Error('Expected reset token');
    const reset = await authRequest(auth, '/reset-password', {
      body: { token: resetToken, newPassword: 'Magic-stale-victim-password-2026' }
    });
    expect(reset.status).toBe(200);

    await expectMagicSessionRejected(await authRequest(auth, staleMagic.actionUrl));
    expect(await databaseClient.db.select().from(session)).toHaveLength(0);
  });

  it('deletes an in-flight magic session created after password-reset revocation', async () => {
    const auth = createTestAuth();
    const { email } = await registerAndVerify(auth);
    const magicRequested = await authRequest(auth, '/sign-in/magic-link', {
      body: { email, callbackURL: '/' },
      ip: '192.0.2.62'
    });
    expect(magicRequested.status).toBe(200);
    const magicMessage = await latestMessage('auth.magic-link', email);
    const resetRequested = await authRequest(auth, '/request-password-reset', {
      body: { email, redirectTo: '/reset-password' },
      ip: '192.0.2.63'
    });
    expect(resetRequested.status).toBe(200);
    const resetMessage = await latestMessage('auth.password-reset', email);
    const resetToken = new URL(resetMessage.actionUrl).pathname.split('/').at(-1);
    if (!resetToken) throw new Error('Expected reset token');

    const sessionCreateEntered = deferred();
    const releaseSessionCreate = deferred();
    const barrierPlugin = {
      id: `magic-session-create-barrier-${randomUUID()}`,
      init: () => ({
        options: {
          databaseHooks: {
            session: {
              create: {
                before: async () => {
                  sessionCreateEntered.resolve();
                  await releaseSessionCreate.promise;
                }
              }
            }
          }
        }
      })
    } satisfies BetterAuthPlugin;
    const racingAuth = createTestAuth({ additionalPlugins: [barrierPlugin] });
    const lateMagic = authRequest(racingAuth, magicMessage.actionUrl);
    try {
      await sessionCreateEntered.promise;
      const reset = await authRequest(auth, '/reset-password', {
        body: { token: resetToken, newPassword: 'Magic-race-victim-password-2026' }
      });
      expect(reset.status).toBe(200);
    } finally {
      releaseSessionCreate.resolve();
    }

    await expectMagicSessionRejected(await lateMagic);
    expect(await databaseClient.db.select().from(session)).toHaveLength(0);
  }, 15_000);

  it('invalidates sibling reset tokens after the latest reset completes', async () => {
    const auth = createTestAuth();
    const { email } = await registerAndVerify(auth);
    const firstRequest = await authRequest(auth, '/request-password-reset', {
      body: { email, redirectTo: '/reset-password' },
      ip: '192.0.2.64'
    });
    expect(firstRequest.status).toBe(200);
    const staleMessage = await latestMessage('auth.password-reset', email);
    const secondRequest = await authRequest(auth, '/request-password-reset', {
      body: { email, redirectTo: '/reset-password' },
      ip: '192.0.2.65'
    });
    expect(secondRequest.status).toBe(200);
    const currentMessage = await latestMessage('auth.password-reset', email);
    expect(currentMessage.actionUrl).not.toBe(staleMessage.actionUrl);
    const staleToken = new URL(staleMessage.actionUrl).pathname.split('/').at(-1);
    const currentToken = new URL(currentMessage.actionUrl).pathname.split('/').at(-1);
    if (!staleToken || !currentToken) throw new Error('Expected reset tokens');

    const victimPassword = 'Sibling-reset-victim-password-2026';
    const currentReset = await authRequest(auth, '/reset-password', {
      body: { token: currentToken, newPassword: victimPassword }
    });
    expect(currentReset.status).toBe(200);
    const staleReset = await authRequest(auth, '/reset-password', {
      body: { token: staleToken, newPassword: 'Sibling-reset-attacker-password-2026' }
    });
    expect(staleReset.status).toBe(400);
    expect(await staleReset.json()).toMatchObject({ code: 'INVALID_TOKEN' });
    expect((await authRequest(auth, '/sign-in/email', {
      body: { email, password: victimPassword },
      ip: '192.0.2.66'
    })).status).toBe(200);
    expect((await authRequest(auth, '/sign-in/email', {
      body: { email, password: 'Sibling-reset-attacker-password-2026' },
      ip: '192.0.2.67'
    })).status).not.toBe(200);
  });

  it('rejects a consumed reset token that resumes after a newer reset', async () => {
    const auth = createTestAuth();
    const { email } = await registerAndVerify(auth);
    const staleRequested = await authRequest(auth, '/request-password-reset', {
      body: { email, redirectTo: '/reset-password' },
      ip: '192.0.2.68'
    });
    expect(staleRequested.status).toBe(200);
    const staleMessage = await latestMessage('auth.password-reset', email);
    const staleToken = new URL(staleMessage.actionUrl).pathname.split('/').at(-1);
    if (!staleToken) throw new Error('Expected stale reset token');

    const hashEntered = deferred();
    const releaseHash = deferred();
    const racingAuth = createTestAuth({
      passwordHash: async (plainPassword) => {
        hashEntered.resolve();
        await releaseHash.promise;
        return hashPassword(plainPassword);
      }
    });
    const staleReset = authRequest(racingAuth, '/reset-password', {
      body: { token: staleToken, newPassword: 'In-flight-reset-attacker-password-2026' }
    });
    try {
      await hashEntered.promise;
      const currentRequested = await authRequest(auth, '/request-password-reset', {
        body: { email, redirectTo: '/reset-password' },
        ip: '192.0.2.69'
      });
      expect(currentRequested.status).toBe(200);
      const currentMessage = await latestMessage('auth.password-reset', email);
      const currentToken = new URL(currentMessage.actionUrl).pathname.split('/').at(-1);
      if (!currentToken) throw new Error('Expected current reset token');
      const currentReset = await authRequest(auth, '/reset-password', {
        body: { token: currentToken, newPassword: 'In-flight-reset-victim-password-2026' }
      });
      expect(currentReset.status).toBe(200);
    } finally {
      releaseHash.resolve();
    }

    const rejectedStaleReset = await staleReset;
    expect(rejectedStaleReset.status).toBe(400);
    expect(await rejectedStaleReset.json()).toMatchObject({ code: 'INVALID_TOKEN' });
    expect((await authRequest(auth, '/sign-in/email', {
      body: { email, password: 'In-flight-reset-victim-password-2026' },
      ip: '192.0.2.70'
    })).status).toBe(200);
    expect((await authRequest(auth, '/sign-in/email', {
      body: { email, password: 'In-flight-reset-attacker-password-2026' },
      ip: '192.0.2.71'
    })).status).not.toBe(200);
  }, 20_000);

  it('restores the authorized generation when a stale reset resumes after applying its hash', async () => {
    const auth = createTestAuth();
    const { email } = await registerAndVerify(auth);
    expect((await authRequest(auth, '/request-password-reset', {
      body: { email, redirectTo: '/reset-password' },
      ip: '192.0.2.72'
    })).status).toBe(200);
    const staleMessage = await latestMessage('auth.password-reset', email);
    const staleToken = new URL(staleMessage.actionUrl).pathname.split('/').at(-1);
    if (!staleToken) throw new Error('Expected stale reset token');

    const completionEntered = deferred();
    const releaseCompletion = deferred();
    const racingAuth = createTestAuth({
      completePasswordResetSecurity: async (database, input) => {
        completionEntered.resolve();
        await releaseCompletion.promise;
        return completePasswordResetSecurity(database, input);
      }
    });
    const attackerPassword = 'Applied-stale-reset-attacker-password-2026';
    const staleReset = authRequest(racingAuth, '/reset-password', {
      body: { token: staleToken, newPassword: attackerPassword }
    });
    try {
      await completionEntered.promise;
      expect((await authRequest(auth, '/request-password-reset', {
        body: { email, redirectTo: '/reset-password' },
        ip: '192.0.2.73'
      })).status).toBe(200);
      const currentMessage = await latestMessage('auth.password-reset', email);
      const currentToken = new URL(currentMessage.actionUrl).pathname.split('/').at(-1);
      if (!currentToken) throw new Error('Expected current reset token');
      expect(currentToken).not.toBe(staleToken);
      expect((await authRequest(auth, '/reset-password', {
        body: { token: currentToken, newPassword: 'Applied-reset-victim-password-2026' }
      })).status).toBe(200);
    } finally {
      releaseCompletion.resolve();
    }

    const rejectedStaleReset = await staleReset;
    expect(rejectedStaleReset.status).toBe(400);
    expect(await rejectedStaleReset.json()).toMatchObject({ code: 'INVALID_TOKEN' });
    expect((await authRequest(auth, '/sign-in/email', {
      body: { email, password: 'Applied-reset-victim-password-2026' },
      ip: '192.0.2.74'
    })).status).toBe(200);
    expect((await authRequest(auth, '/sign-in/email', {
      body: { email, password: attackerPassword },
      ip: '192.0.2.75'
    })).status).not.toBe(200);
  }, 20_000);

  it('cannot roll a newer applied reset back while both completions are in flight', async () => {
    const auth = createTestAuth();
    const { email } = await registerAndVerify(auth);
    expect((await authRequest(auth, '/request-password-reset', {
      body: { email, redirectTo: '/reset-password' },
      ip: '192.0.2.76'
    })).status).toBe(200);
    const staleMessage = await latestMessage('auth.password-reset', email);
    const staleToken = new URL(staleMessage.actionUrl).pathname.split('/').at(-1);
    if (!staleToken) throw new Error('Expected stale reset token');

    const staleCompletionEntered = deferred();
    const releaseStaleCompletion = deferred();
    const staleAuth = createTestAuth({
      completePasswordResetSecurity: async (database, input) => {
        staleCompletionEntered.resolve();
        await releaseStaleCompletion.promise;
        return completePasswordResetSecurity(database, input);
      }
    });
    const stalePassword = 'Double-flight-stale-password-2026';
    const staleReset = authRequest(staleAuth, '/reset-password', {
      body: { token: staleToken, newPassword: stalePassword }
    });

    const currentCompletionEntered = deferred();
    const releaseCurrentCompletion = deferred();
    let currentReset: Promise<Response> | null = null;
    try {
      await staleCompletionEntered.promise;
      expect((await authRequest(auth, '/request-password-reset', {
        body: { email, redirectTo: '/reset-password' },
        ip: '192.0.2.77'
      })).status).toBe(200);
      const currentMessage = await latestMessage('auth.password-reset', email);
      const currentToken = new URL(currentMessage.actionUrl).pathname.split('/').at(-1);
      if (!currentToken) throw new Error('Expected current reset token');
      const currentAuth = createTestAuth({
        completePasswordResetSecurity: async (database, input) => {
          currentCompletionEntered.resolve();
          await releaseCurrentCompletion.promise;
          return completePasswordResetSecurity(database, input);
        }
      });
      currentReset = authRequest(currentAuth, '/reset-password', {
        body: { token: currentToken, newPassword: 'Double-flight-victim-password-2026' }
      });
      await currentCompletionEntered.promise;

      releaseStaleCompletion.resolve();
      const staleResponse = await staleReset;
      expect(staleResponse.status).toBe(400);
      expect(await staleResponse.json()).toMatchObject({ code: 'INVALID_TOKEN' });
      releaseCurrentCompletion.resolve();
      const currentResponse = await currentReset;
      expect(currentResponse.status).toBe(200);
    } finally {
      releaseStaleCompletion.resolve();
      releaseCurrentCompletion.resolve();
      await Promise.allSettled([staleReset, ...(currentReset ? [currentReset] : [])]);
    }

    expect((await authRequest(auth, '/sign-in/email', {
      body: { email, password: 'Double-flight-victim-password-2026' },
      ip: '192.0.2.78'
    })).status).toBe(200);
    expect((await authRequest(auth, '/sign-in/email', {
      body: { email, password: stalePassword },
      ip: '192.0.2.79'
    })).status).not.toBe(200);
    expect((await authRequest(auth, '/sign-in/email', {
      body: { email, password },
      ip: '192.0.2.80'
    })).status).not.toBe(200);
  }, 30_000);

  it.each([true, false])(
    'rotates a pre-existing credential and session before claim recovery (verified=%s)',
    async (leaveVerified) => {
    const auth = createTestAuth();
    const email = `${randomUUID()}@example.com`;
    await register(auth, email);
    const initialVerification = await latestMessage('auth.email-verification', email);
    const initiallyVerified = await authRequest(auth, initialVerification.actionUrl);
    expect(initiallyVerified.headers.get('set-cookie')).toBeNull();
    const attackerSignIn = await authRequest(auth, '/sign-in/email', {
      body: { email, password },
      ip: '192.0.2.31'
    });
    const attackerCookie = cookiePair(attackerSignIn);
    const [registeredUser] = await databaseClient.db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, email));
    if (!registeredUser) throw new Error('Expected registered recovery user');
    let staleVerification: AuthEmailPayload | null = null;
    if (!leaveVerified) {
      await databaseClient.db
        .update(user)
        .set({ emailVerified: false })
        .where(eq(user.id, registeredUser.id));
      const staleVerificationRequest = await authRequest(auth, '/send-verification-email', {
        body: { email, callbackURL: '/library' },
        ip: '192.0.2.32'
      });
      expect(staleVerificationRequest.status).toBe(200);
      staleVerification = await latestMessage('auth.email-verification', email);

      const messageCount = (await queuedMessages()).length;
      const directCommerceVerification = await authRequest(auth, '/send-verification-email', {
        body: { email, callbackURL: '/claim/complete' },
        ip: '192.0.2.38'
      });
      expect(directCommerceVerification.status).toBe(200);
      expect(await queuedMessages()).toHaveLength(messageCount);
    }

    const resetRequested = await authRequest(auth, '/request-password-reset', {
      body: { email, redirectTo: '/reset-password?purpose=commerce-claim' },
      ip: '192.0.2.33'
    });
    expect(resetRequested.status).toBe(200);
    expect(await resetRequested.json()).toEqual({
      status: true,
      message: 'If this email exists in our system, check your email for the reset link'
    });
    const resetMessage = await latestMessage('auth.password-reset', email);
    const resetUrl = new URL(resetMessage.actionUrl);
    expect(decodeURIComponent(resetUrl.searchParams.get('callbackURL') ?? '')).toBe(
      '/reset-password?purpose=commerce-claim'
    );
    expect(resetMessage.actionUrl).not.toContain(encodeURIComponent(email));
    const resetToken = resetUrl.pathname.split('/').at(-1);
    if (!resetToken) throw new Error('Expected commerce reset token');

    const victimPassword = 'Victim-controlled-password-2026';
    const reset = await authRequest(auth, '/reset-password', {
      body: { token: resetToken, newPassword: victimPassword }
    });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ status: true, commerceClaimReady: true });
    const claimCookie = reset.headers.get('set-cookie') ?? '';
    expect(claimCookie).toContain('pale-orbit-commerce-claim=');
    expect(claimCookie.toLowerCase()).toContain('httponly');
    expect(claimCookie.toLowerCase()).toContain('samesite=lax');
    expect(claimCookie).toContain('Path=/claim/complete');
    const staleSession = await authRequest(auth, '/get-session', { cookie: attackerCookie });
    expect(await staleSession.json()).toBeNull();
    const attackerPassword = await authRequest(auth, '/sign-in/email', {
      body: { email, password },
      ip: '192.0.2.34'
    });
    expect(attackerPassword.status).not.toBe(200);

    if (staleVerification) {
      const staleLink = await authRequest(auth, staleVerification.actionUrl);
      expect(staleLink.status).toBe(302);
      expect(staleLink.headers.get('location')).toContain('error=INVALID_TOKEN');
      expect(staleLink.headers.get('set-cookie')).toBeNull();
    }
    expect((await databaseClient.db.select({ verified: user.emailVerified }).from(user)
      .where(eq(user.id, registeredUser.id)))[0]?.verified).toBe(true);
    const victimSignIn = await authRequest(auth, '/sign-in/email', {
      body: { email, password: victimPassword },
      ip: '192.0.2.36'
    });
    expect(victimSignIn.status).toBe(200);
    }
  );

  it('preserves the server claim-readiness proof through the real Better Auth client parser', async () => {
    const auth = createTestAuth();
    const { email } = await registerAndVerify(auth);
    const requested = await authRequest(auth, '/request-password-reset', {
      body: { email, redirectTo: '/reset-password?purpose=commerce-claim' },
      ip: '192.0.2.55'
    });
    expect(requested.status).toBe(200);
    const resetMessage = await latestMessage('auth.password-reset', email);
    const token = new URL(resetMessage.actionUrl).pathname.split('/').at(-1);
    if (!token) throw new Error('Expected commerce reset token');

    const captured: { response?: Response } = {};
    const client = createAuthClient({
      baseURL: `${config.origin}/api/auth`,
      fetchOptions: {
        customFetchImpl: async (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set('origin', config.origin);
          const response = await auth.handler(new Request(input, { ...init, headers }));
          captured.response = response.clone();
          return response;
        }
      }
    });
    const result = await client.resetPassword({
      token,
      newPassword: 'Client-parser-recovery-password-2026'
    });

    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({ status: true, commerceClaimReady: true });
    expect(captured.response?.headers.get('set-cookie') ?? '')
      .toContain('pale-orbit-commerce-claim=');
  });

  it('suppresses unsafe magic links, rate limits resends, and preserves both sign-in methods', async () => {
    const auth = createTestAuth();
    const { email } = await register(auth);
    const initialMessageCount = (await queuedMessages()).length;
    const suppressed = await authRequest(auth, '/sign-in/magic-link', {
      body: { email, callbackURL: '/' },
      ip: '192.0.2.40'
    });
    expect(suppressed.status).toBe(200);
    expect((await queuedMessages()).filter((entry) => entry.template === 'auth.magic-link')).toHaveLength(
      0
    );
    expect((await queuedMessages()).length).toBe(initialMessageCount);

    const resendStatuses: number[] = [];
    for (let attempt = 0; attempt <= config.auth.rateLimit.emailMax; attempt += 1) {
      const resent = await authRequest(auth, '/send-verification-email', {
        body: { email, callbackURL: '/' },
        ip: '192.0.2.41'
      });
      resendStatuses.push(resent.status);
    }
    expect(resendStatuses.slice(0, config.auth.rateLimit.emailMax)).toEqual(
      Array(config.auth.rateLimit.emailMax).fill(200)
    );
    expect(resendStatuses.at(-1)).toBe(429);

    const verificationMessage = await latestMessage('auth.email-verification', email);
    await authRequest(auth, verificationMessage.actionUrl);
    const passwordSignIn = await authRequest(auth, '/sign-in/email', {
      body: { email, password },
      ip: '192.0.2.42'
    });
    expect(passwordSignIn.status).toBe(200);

    const magicRequested = await authRequest(auth, '/sign-in/magic-link', {
      body: { email, callbackURL: '/' },
      ip: '192.0.2.43'
    });
    expect(magicRequested.status).toBe(200);
    const magicMessage = await latestMessage('auth.magic-link', email);
    expect(magicMessage.actionUrl).toContain(`${config.origin}/api/auth/magic-link/verify`);
    const magicToken = new URL(magicMessage.actionUrl).searchParams.get('token');
    if (!magicToken) throw new Error('Expected magic-link token');
    expect(JSON.stringify(await databaseClient.db.select().from(verification)))
      .not.toContain(magicToken);
    const magicSession = await authRequest(auth, magicMessage.actionUrl);
    expect(magicSession.headers.get('set-cookie')).not.toBeNull();
    const reused = await authRequest(auth, magicMessage.actionUrl);
    expect(reused.headers.get('set-cookie')).toBeNull();
    expect(
      await databaseClient.db
        .select()
        .from(userRoles)
        .where(and(eq(userRoles.role, 'customer'), eq(userRoles.userId, (await databaseClient.db.select().from(user).where(eq(user.email, email)))[0]!.id)))
    ).toHaveLength(1);
  });
});
