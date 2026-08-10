import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink } from 'better-auth/plugins';
import { z } from 'zod';
import type { ApplicationConfig } from '$lib/server/config/schema';
import type { QueueCommerceClaimEmailInput } from '$lib/server/commerce/claim-email';
import type { Database } from '$lib/server/db/client';
import * as schema from '$lib/server/db/schema';
import type { QueueAuthEmailInput } from '$lib/server/email/enqueue';
import { normalizeEmailAddress } from './identity';
import {
  consumeEmailVerificationToken,
  registerEmailVerificationToken
} from './email-verification';

export interface AuthServerDependencies {
  database: Database;
  config: Pick<ApplicationConfig, 'environment' | 'origin' | 'auth'>;
  queueVerificationEmail(input: QueueAuthEmailInput): Promise<void>;
  queueResetEmail(input: QueueAuthEmailInput): Promise<void>;
  queueMagicEmail(input: QueueAuthEmailInput): Promise<void>;
  queueCommerceClaimEmail(input: QueueCommerceClaimEmailInput): Promise<void>;
  canSendMagicLink(email: string): Promise<boolean>;
  onUserCreated(userId: string): Promise<void>;
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
}

interface RoutedMagicLinkInput {
  email: string;
  url: string;
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
  if (!(await dependencies.canSendMagicLink(email))) return;
  await dependencies.queueCommerceClaimEmail({
    orderId: metadata.data.orderId,
    email,
    claimUrl: input.url
  });
}

export function createAuthServer(dependencies: AuthServerDependencies) {
  const { auth, environment, origin } = dependencies.config;
  const trustedOrigin = new URL(origin).origin;
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
      }
    },
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: auth.resetExpiresIn,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await dependencies.queueResetEmail({
          template: 'auth.password-reset',
          to: normalizeEmailAddress(user.email),
          recipientName: user.name || user.email,
          actionUrl: url,
          expiresInSeconds: auth.resetExpiresIn
        });
      }
    },
    emailVerification: {
      expiresIn: auth.verificationExpiresIn,
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url, token }) => {
        await registerEmailVerificationToken(dependencies.database, {
          token,
          email: user.email,
          expiresInSeconds: auth.verificationExpiresIn
        });
        await dependencies.queueVerificationEmail({
          template: 'auth.email-verification',
          to: normalizeEmailAddress(user.email),
          recipientName: user.name || user.email,
          actionUrl: url,
          expiresInSeconds: auth.verificationExpiresIn
        });
      }
    },
    session: { expiresIn: auth.sessionExpiresIn },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (context.path !== '/verify-email') return;
        const token = context.query?.token;
        const accepted =
          typeof token === 'string' &&
          (await consumeEmailVerificationToken(dependencies.database, token));
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
        sendMagicLink: ({ email, url, metadata }) =>
          sendRoutedMagicLink(dependencies, { email, url, metadata }, auth.magicExpiresIn)
      }),
      ...(dependencies.additionalPlugins ?? [])
    ]
  });
}
