import { createHash } from 'node:crypto';
import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { deleteSessionCookie } from 'better-auth/cookies';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { magicLink } from 'better-auth/plugins';
import { defineRequestState } from '@better-auth/core/context';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ApplicationConfig } from '$lib/server/config/schema';
import type { QueueCommerceClaimEmailInput } from '$lib/server/commerce/claim-email';
import type { Database } from '$lib/server/db/client';
import * as schema from '$lib/server/db/schema';
import type { QueueAuthEmailInput } from '$lib/server/email/enqueue';
import { normalizeEmailAddress } from './identity';
import {
  authorizeCommerceClaimIssuance,
  COMMERCE_CLAIM_PROOF_COOKIE,
  commerceClaimTokenSha256,
  createCommerceClaimProofToken,
  wrapCommerceClaimActionUrl,
  type RegisterCommerceClaimIssuanceInput
} from './commerce-claim-capability';
import {
  applyCurrentPasswordResetCredential,
  completePasswordResetSecurity,
  consumeAuthMagicLinkToken,
  credentialAuthorityAcceptsPassword,
  establishCredentialAuthority,
  registerAuthMagicLinkToken,
  registerPasswordResetToken
} from './commerce-claim-authorization';
import {
  consumeEmailVerificationToken,
  isCommerceClaimVerificationCallback,
  registerEmailVerificationToken,
  validateEmailVerificationToken
} from './email-verification';

export interface AuthServerDependencies {
  database: Database;
  config: Pick<ApplicationConfig, 'environment' | 'origin' | 'auth'>;
  queueVerificationEmail(input: QueueAuthEmailInput): Promise<void>;
  queueResetEmail(input: QueueAuthEmailInput): Promise<void>;
  queueMagicEmail(input: QueueAuthEmailInput): Promise<void>;
  queueCommerceClaimEmail(input: QueueCommerceClaimEmailInput): Promise<void>;
  canSendMagicLink(email: string): Promise<boolean>;
  canSendCommerceMagicLink(email: string): Promise<boolean>;
  onUserCreated(userId: string): Promise<void>;
  completePasswordResetSecurity?: typeof completePasswordResetSecurity;
  consumeAuthMagicLinkToken?: typeof consumeAuthMagicLinkToken;
  credentialAuthorityAcceptsPassword?: typeof credentialAuthorityAcceptsPassword;
  deleteCreatedSession?(token: string): Promise<void>;
  registerPasswordResetToken?: typeof registerPasswordResetToken;
  createCommerceClaimProofToken?: typeof createCommerceClaimProofToken;
  registerCommerceClaimIssuance?(input: RegisterCommerceClaimIssuanceInput): Promise<boolean>;
  wrapCommerceClaimActionUrl?: typeof wrapCommerceClaimActionUrl;
  authorizeCommerceClaimIssuance?(input: {
    claimProof: string;
    authToken: string;
  }): Promise<boolean>;
  readCommerceClaimProof?(cookieName: string): string | null;
  clearCommerceClaimProof?(cookieName: string): void;
  passwordHash?: typeof hashPassword;
  additionalPlugins?: readonly BetterAuthPlugin[];
}

export const commerceClaimMetadataSchema = z.strictObject({
  purpose: z.literal('commerce-claim'),
  orderId: z.uuid()
});

interface MagicLinkRoutingDependencies {
  queueMagicEmail(input: QueueAuthEmailInput): Promise<void>;
  queueCommerceClaimEmail(input: QueueCommerceClaimEmailInput): Promise<void>;
  canSendMagicLink(email: string): Promise<boolean>;
  canSendCommerceMagicLink(email: string): Promise<boolean>;
  registerMagicLink(input: {
    token: string;
    email: string;
    purpose: 'account' | 'commerce-claim';
    expiresInSeconds: number;
  }): Promise<boolean>;
  createCommerceClaimProofToken(): string;
  now(): Date;
  registerCommerceClaimIssuance?(input: RegisterCommerceClaimIssuanceInput): Promise<boolean>;
  wrapCommerceClaimActionUrl: typeof wrapCommerceClaimActionUrl;
  trustedOrigin: string;
}

interface RoutedMagicLinkInput {
  email: string;
  url: string;
  token: string;
  metadata?: unknown;
}

export async function sendRoutedMagicLink(
  dependencies: MagicLinkRoutingDependencies,
  input: RoutedMagicLinkInput,
  expiresInSeconds: number
): Promise<void> {
  const email = normalizeEmailAddress(input.email);
  if (input.metadata === undefined) {
    if (!(await dependencies.canSendMagicLink(email))) return;
    const registered = await dependencies.registerMagicLink({
      token: input.token,
      email,
      purpose: 'account',
      expiresInSeconds
    });
    if (!registered) return;
    await dependencies.queueMagicEmail({
      template: 'auth.magic-link',
      to: email,
      recipientName: email,
      actionUrl: input.url,
      expiresInSeconds
    });
    return;
  }
  const metadata = commerceClaimMetadataSchema.safeParse(input.metadata);
  if (!metadata.success) return;
  if (!dependencies.registerCommerceClaimIssuance) return;
  if (!(await dependencies.canSendCommerceMagicLink(email))) return;
  const claimProofToken = dependencies.createCommerceClaimProofToken();
  const now = dependencies.now();
  const protectedIssuanceRegistered = await dependencies.registerCommerceClaimIssuance({
    claimProofSha256: commerceClaimTokenSha256(claimProofToken),
    authTokenSha256: commerceClaimTokenSha256(input.token),
    email,
    anchorOrderId: metadata.data.orderId,
    kind: 'commerce-magic',
    expiresAt: new Date(now.getTime() + expiresInSeconds * 1000)
  });
  if (!protectedIssuanceRegistered) return;
  const registered = await dependencies.registerMagicLink({
    token: input.token,
    email,
    purpose: 'commerce-claim',
    expiresInSeconds
  });
  if (!registered) return;
  const claimUrl = dependencies.wrapCommerceClaimActionUrl({
    actionUrl: input.url,
    claimProofToken,
    anchorOrderId: metadata.data.orderId,
    kind: 'commerce-magic',
    trustedOrigin: dependencies.trustedOrigin
  });
  await dependencies.queueCommerceClaimEmail({
    orderId: metadata.data.orderId,
    email,
    claimUrl
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function commerceResetOrderId(value: string | null, trustedOrigin: string): string | null {
  if (!value) return null;
  try {
    const destination = new URL(value, trustedOrigin);
    const orderId = destination.searchParams.get('orderId');
    return destination.origin === trustedOrigin &&
      destination.pathname === '/reset-password' &&
      destination.searchParams.size === 2 &&
      destination.searchParams.get('purpose') === 'commerce-claim' &&
      destination.hash === '' &&
      orderId && z.uuid().safeParse(orderId).success
      ? orderId
      : null;
  } catch {
    return null;
  }
}

interface PasswordResetRoutingDependencies {
  queueResetEmail(input: QueueAuthEmailInput): Promise<void>;
  registerPasswordResetToken(
    input: Parameters<typeof registerPasswordResetToken>[1]
  ): Promise<boolean>;
  createCommerceClaimProofToken(): string;
  registerCommerceClaimIssuance?(input: RegisterCommerceClaimIssuanceInput): Promise<boolean>;
  wrapCommerceClaimActionUrl: typeof wrapCommerceClaimActionUrl;
  trustedOrigin: string;
  now(): Date;
}

interface RoutedPasswordResetInput {
  user: { id: string; email: string; name?: string | null };
  url: string;
  token: string;
}

export async function sendRoutedPasswordReset(
  dependencies: PasswordResetRoutingDependencies,
  input: RoutedPasswordResetInput,
  expiresInSeconds: number
): Promise<void> {
  const email = normalizeEmailAddress(input.user.email);
  const callbackURL = new URL(input.url).searchParams.get('callbackURL');
  const anchorOrderId = commerceResetOrderId(callbackURL, dependencies.trustedOrigin);
  let actionUrl = input.url;
  if (anchorOrderId) {
    if (!dependencies.registerCommerceClaimIssuance) return;
    const claimProofToken = dependencies.createCommerceClaimProofToken();
    const now = dependencies.now();
    const protectedIssuanceRegistered = await dependencies.registerCommerceClaimIssuance({
      claimProofSha256: commerceClaimTokenSha256(claimProofToken),
      authTokenSha256: commerceClaimTokenSha256(input.token),
      email,
      anchorOrderId,
      kind: 'password-reset',
      expiresAt: new Date(now.getTime() + expiresInSeconds * 1000)
    });
    if (!protectedIssuanceRegistered) return;
    const registered = await dependencies.registerPasswordResetToken({
      token: input.token,
      email,
      userId: input.user.id,
      purpose: 'commerce-claim',
      expiresInSeconds
    });
    if (!registered) return;
    actionUrl = dependencies.wrapCommerceClaimActionUrl({
      actionUrl: input.url,
      claimProofToken,
      anchorOrderId,
      kind: 'password-reset',
      trustedOrigin: dependencies.trustedOrigin
    });
  } else {
    const registered = await dependencies.registerPasswordResetToken({
      token: input.token,
      email,
      userId: input.user.id,
      purpose: 'account',
      expiresInSeconds
    });
    if (!registered) return;
  }
  await dependencies.queueResetEmail({
    template: 'auth.password-reset',
    to: email,
    recipientName: input.user.name || input.user.email,
    actionUrl,
    expiresInSeconds
  });
}

export function authHookReturnedSuccess(value: unknown): boolean {
  return typeof value === 'object' && value !== null &&
    'status' in value && (value as { status?: unknown }).status === true;
}

function successfulPasswordSignIn(
  value: unknown
): { token: string; userId: string } | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { token?: unknown; user?: { id?: unknown } };
  return typeof candidate.token === 'string' && typeof candidate.user?.id === 'string'
    ? { token: candidate.token, userId: candidate.user.id }
    : null;
}

function safeErrorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]*$/u.test(error.name)
    ? error.name
    : 'UnknownError';
}

export function createAuthServer(dependencies: AuthServerDependencies) {
  const { auth, environment, origin } = dependencies.config;
  const trustedOrigin = new URL(origin).origin;
  const verifiedCredentialDigest = defineRequestState<string | null>(() => null);
  const passwordResetToken = defineRequestState<string | null>(() => null);
  const passwordResetIdentity = defineRequestState<{
    userId: string;
    email: string;
  } | null>(() => null);
  const deleteCreatedSession = dependencies.deleteCreatedSession ?? (async (token: string) => {
    await dependencies.database
      .delete(schema.session)
      .where(eq(schema.session.token, token));
  });
  const applyResetCredential = async (
    candidate: { password?: unknown },
    context: { path?: string } | null
  ): Promise<false | void> => {
    if (context?.path !== '/reset-password' || typeof candidate.password !== 'string') return;
    const token = await passwordResetToken.get();
    const applied = token && await applyCurrentPasswordResetCredential(
      dependencies.database,
      { token, passwordHash: candidate.password }
    );
    if (!applied) {
      throw new APIError('BAD_REQUEST', {
        code: 'INVALID_TOKEN',
        message: 'Invalid or expired reset token'
      });
    }
    return false;
  };
  return betterAuth({
    appName: 'Pale Orbit Press',
    baseURL: origin,
    secret: auth.secret,
    database: drizzleAdapter(dependencies.database, {
      provider: 'pg',
      schema
    }),
    databaseHooks: {
      user: {
        create: {
          before: async (candidate) => ({
            data: { ...candidate, email: normalizeEmailAddress(candidate.email) }
          }),
          after: async (created) => dependencies.onUserCreated(created.id)
        }
      },
      account: {
        create: {
          before: applyResetCredential,
          after: async (created, context) => {
            if (
              context?.path !== '/reset-password' &&
              created.providerId === 'credential'
            ) {
              await establishCredentialAuthority(dependencies.database, {
                userId: created.userId
              });
            }
          }
        },
        update: { before: applyResetCredential }
      }
    },
    emailAndPassword: {
      enabled: true,
      password: {
        hash: dependencies.passwordHash ?? hashPassword,
        verify: async (input) => {
          const valid = await verifyPassword(input);
          if (valid) await verifiedCredentialDigest.set(sha256(input.hash));
          return valid;
        }
      },
      autoSignIn: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: auth.resetExpiresIn,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url, token }) => {
        await sendRoutedPasswordReset({
          queueResetEmail: dependencies.queueResetEmail,
          registerPasswordResetToken: (input) => (
            dependencies.registerPasswordResetToken ?? registerPasswordResetToken
          )(dependencies.database, input),
          createCommerceClaimProofToken:
            dependencies.createCommerceClaimProofToken ?? createCommerceClaimProofToken,
          ...(dependencies.registerCommerceClaimIssuance
            ? { registerCommerceClaimIssuance: dependencies.registerCommerceClaimIssuance }
            : {}),
          wrapCommerceClaimActionUrl:
            dependencies.wrapCommerceClaimActionUrl ?? wrapCommerceClaimActionUrl,
          trustedOrigin,
          now: () => new Date()
        }, { user, url, token }, auth.resetExpiresIn);
      },
      onPasswordReset: async ({ user }) => {
        await passwordResetIdentity.set({
          userId: user.id,
          email: normalizeEmailAddress(user.email)
        });
      }
    },
    emailVerification: {
      expiresIn: auth.verificationExpiresIn,
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url, token }) => {
        const callbackURL = new URL(url).searchParams.get('callbackURL') ?? undefined;
        if (isCommerceClaimVerificationCallback(callbackURL, trustedOrigin)) return;
        const registered = await registerEmailVerificationToken(dependencies.database, {
          token,
          email: user.email,
          expiresInSeconds: auth.verificationExpiresIn
        });
        if (!registered) return;
        await dependencies.queueVerificationEmail({
          template: 'auth.email-verification',
          to: normalizeEmailAddress(user.email),
          recipientName: user.name || user.email,
          actionUrl: url,
          expiresInSeconds: auth.verificationExpiresIn
        });
      },
      beforeEmailVerification: async (_user, request) => {
        if (!request) throw new APIError('UNAUTHORIZED');
        const url = new URL(request.url);
        const token = url.searchParams.get('token');
        if (isCommerceClaimVerificationCallback(
          url.searchParams.get('callbackURL') ?? undefined,
          trustedOrigin
        )) throw new APIError('UNAUTHORIZED');
        const consumed = token && await consumeEmailVerificationToken(
          dependencies.database,
          token
        );
        if (!consumed) {
          throw new APIError('UNAUTHORIZED', {
            code: 'INVALID_TOKEN',
            message: 'Invalid or expired verification token'
          });
        }
      }
    },
    session: { expiresIn: auth.sessionExpiresIn },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (context.path === '/change-password') {
          throw new APIError('FORBIDDEN', {
            code: 'PASSWORD_RESET_REQUIRED',
            message: 'Use password recovery to change your password'
          });
        }
        if (context.path === '/reset-password') {
          const token = context.body?.token;
          await passwordResetToken.set(typeof token === 'string' ? token : null);
          return;
        }
        if (context.path === '/verify-email') {
          const token = context.query?.token;
          const blockedCommerceCallback = isCommerceClaimVerificationCallback(
            typeof context.query?.callbackURL === 'string'
              ? context.query.callbackURL
              : undefined,
            trustedOrigin
          );
          const accepted = !blockedCommerceCallback && typeof token === 'string' &&
            await validateEmailVerificationToken(dependencies.database, token);
          if (accepted) return;

          const callbackURL = context.query?.callbackURL;
          if (typeof callbackURL === 'string') {
            const destination = new URL(callbackURL, trustedOrigin);
            if (destination.origin === trustedOrigin) {
              destination.searchParams.set('error', 'INVALID_TOKEN');
              throw context.redirect(destination.toString());
            }
          }
          throw new APIError('UNAUTHORIZED', {
            code: 'INVALID_TOKEN',
            message: 'Invalid or expired verification token'
          });
        }
      }),
      after: createAuthMiddleware(async (context) => {
        const rejectCreatedSession = async (input: {
          token: string;
          code: string;
          message: string;
          clearLocation?: boolean;
        }): Promise<Response> => {
          // Scrub the valid session cookie before any fallible cleanup. Even if
          // the database delete fails, the random token is never delivered to
          // the caller or made available to later Better Auth plugins.
          deleteSessionCookie(context);
          context.context.newSession = null;
          if (input.clearLocation) context.context.responseHeaders?.delete('location');
          try {
            await deleteCreatedSession(input.token);
          } catch (error) {
            context.context.logger.error('Rejected authentication session cleanup failed', {
              errorName: safeErrorName(error)
            });
          }
          return new Response(JSON.stringify({
            code: input.code,
            message: input.message
          }), {
            status: 401,
            headers: { 'content-type': 'application/json' }
          });
        };
        let claimAuthToken: string | null = null;
        if (context.path === '/sign-in/email') {
          const signedIn = context.context.newSession
            ? {
                token: context.context.newSession.session.token,
                userId: context.context.newSession.user.id
              }
            : successfulPasswordSignIn(context.context.returned);
          if (!signedIn) return;
          try {
            const verifiedDigest = await verifiedCredentialDigest.get();
            const [currentCredential] = await dependencies.database
              .select({ password: schema.account.password })
              .from(schema.account)
              .where(and(
                eq(schema.account.userId, signedIn.userId),
                eq(schema.account.providerId, 'credential')
              ))
              .limit(1);
            if (
              verifiedDigest &&
              currentCredential?.password &&
              sha256(currentCredential.password) === verifiedDigest &&
              await (
                dependencies.credentialAuthorityAcceptsPassword ??
                credentialAuthorityAcceptsPassword
              )(dependencies.database, {
                userId: signedIn.userId,
                passwordHash: currentCredential.password
              })
            ) return;
          } catch (error) {
            context.context.logger.error('Password session authority guard failed', {
              errorName: safeErrorName(error)
            });
          }
          return rejectCreatedSession({
            token: signedIn.token,
            code: 'INVALID_EMAIL_OR_PASSWORD',
            message: 'Invalid email or password'
          });
        }
        if (context.path === '/reset-password') {
          if (!authHookReturnedSuccess(context.context.returned)) return;
          const token = await passwordResetToken.get();
          const identity = await passwordResetIdentity.get();
          if (!token || !identity) {
            return new Response(JSON.stringify({
              code: 'INVALID_TOKEN',
              message: 'Invalid or expired reset token'
            }), {
              status: 400,
              headers: { 'content-type': 'application/json' }
            });
          }
          const completion = await (
            dependencies.completePasswordResetSecurity ?? completePasswordResetSecurity
          )(dependencies.database, { token, ...identity });
          if (!completion.completed) {
            return new Response(JSON.stringify({
              code: 'INVALID_TOKEN',
              message: 'Invalid or expired reset token'
            }), {
              status: 400,
              headers: { 'content-type': 'application/json' }
            });
          }
          if (completion.purpose === 'commerce-claim') claimAuthToken = token;
        } else if (context.path === '/magic-link/verify') {
          const token = context.query?.token;
          const createdSession = context.context.newSession;
          if (!createdSession) return;
          let consumed = null;
          try {
            consumed = typeof token === 'string'
              ? await (
                  dependencies.consumeAuthMagicLinkToken ?? consumeAuthMagicLinkToken
                )(dependencies.database, {
                  token,
                  userId: createdSession.user.id
                })
              : null;
          } catch (error) {
            context.context.logger.error('Magic session generation guard failed', {
              errorName: safeErrorName(error)
            });
          }
          if (!consumed) {
            return rejectCreatedSession({
              token: createdSession.session.token,
              code: 'INVALID_TOKEN',
              message: 'Invalid or expired authentication link',
              clearLocation: true
            });
          }
          if (consumed.purpose === 'commerce-claim') claimAuthToken = token;
        }
        if (!claimAuthToken) return;
        const claimProof = dependencies.readCommerceClaimProof?.(COMMERCE_CLAIM_PROOF_COOKIE);
        if (!claimProof) return;
        let authorized: boolean;
        try {
          authorized = await (
            dependencies.authorizeCommerceClaimIssuance ?? ((input) =>
              authorizeCommerceClaimIssuance(dependencies.database, input))
          )({ claimProof, authToken: claimAuthToken });
        } catch (error) {
          context.context.logger.error('Commerce claim promotion failed', {
            errorName: safeErrorName(error)
          });
          return new Response(JSON.stringify({
            code: 'CLAIM_PROMOTION_UNAVAILABLE',
            message: 'Purchase claim authorization is temporarily unavailable'
          }), {
            status: 503,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (!authorized) {
          dependencies.clearCommerceClaimProof?.(COMMERCE_CLAIM_PROOF_COOKIE);
          return;
        }
        if (context.path === '/reset-password') {
          context.context.returned = { status: true, commerceClaimReady: true };
        }
      })
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      modelName: 'rateLimit',
      window: auth.rateLimit.windowSeconds,
      max: auth.rateLimit.max,
      customRules: {
        '/sign-in/email': {
          window: auth.rateLimit.windowSeconds,
          max: auth.rateLimit.loginMax
        },
        '/request-password-reset': {
          window: auth.rateLimit.windowSeconds,
          max: auth.rateLimit.emailMax
        },
        '/send-verification-email': {
          window: auth.rateLimit.windowSeconds,
          max: auth.rateLimit.emailMax
        },
        '/sign-in/magic-link': {
          window: auth.rateLimit.windowSeconds,
          max: auth.rateLimit.emailMax
        }
      }
    },
    advanced: {
      useSecureCookies: environment === 'production',
      database: { generateId: 'uuid' }
    },
    trustedOrigins: [trustedOrigin],
    telemetry: { enabled: false },
    plugins: [
      magicLink({
        expiresIn: auth.magicExpiresIn,
        storeToken: 'hashed',
        disableSignUp: false,
        sendMagicLink: ({ email, url, token, metadata }) =>
          sendRoutedMagicLink({
            ...dependencies,
            trustedOrigin,
            createCommerceClaimProofToken:
              dependencies.createCommerceClaimProofToken ?? createCommerceClaimProofToken,
            now: () => new Date(),
            ...(dependencies.registerCommerceClaimIssuance
              ? { registerCommerceClaimIssuance: dependencies.registerCommerceClaimIssuance }
              : {}),
            wrapCommerceClaimActionUrl:
              dependencies.wrapCommerceClaimActionUrl ?? wrapCommerceClaimActionUrl,
            registerMagicLink: (input) =>
              registerAuthMagicLinkToken(dependencies.database, input)
          }, { email, url, token, metadata }, auth.magicExpiresIn)
      }),
      ...(dependencies.additionalPlugins ?? [])
    ]
  });
}
