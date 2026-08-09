import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { registerEmailVerificationToken } from '$lib/server/auth/email-verification';
import { createAuthServer } from '$lib/server/auth/options';
import { canSendMagicLink, ensureCustomerRole } from '$lib/server/auth/identity';
import { loadApplicationConfig } from '$lib/server/config/load';
import {
  account,
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

function createTestAuth() {
  return createAuthServer({
    database: databaseClient.db,
    config,
    queueVerificationEmail: (input) => queueAuthEmail(databaseClient.db, input),
    queueResetEmail: (input) => queueAuthEmail(databaseClient.db, input),
    queueMagicEmail: (input) => queueAuthEmail(databaseClient.db, input),
    canSendMagicLink: (email) => canSendMagicLink(databaseClient.db, email),
    onUserCreated: (userId) => ensureCustomerRole(databaseClient.db, userId)
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
  return { ...registration, cookie: cookiePair(verificationResponse), message };
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
      .map((row) => row.value)
      .sort();
    expect(remainingValues).toEqual(['current@example.com', 'reset@example.com']);
  });

  it('registers, verifies once, establishes a hardened cookie, and signs out', async () => {
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
    const setCookie = verified.headers.get('set-cookie') ?? '';
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=lax');
    expect(setCookie.toLowerCase()).not.toContain('secure');
    const cookie = cookiePair(verified);
    expect(await databaseClient.db.select().from(session)).toHaveLength(1);
    expect(await databaseClient.db.select().from(verification)).toHaveLength(0);

    const reused = await authRequest(auth, message.actionUrl);
    expect(reused.status).toBe(302);
    expect(reused.headers.get('location')).toContain('error=INVALID_TOKEN');
    expect(reused.headers.get('set-cookie')).toBeNull();
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
    expect(await databaseClient.db.select().from(verification)).toHaveLength(1);
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
