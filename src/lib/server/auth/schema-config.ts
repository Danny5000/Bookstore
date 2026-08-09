import { existsSync } from 'node:fs';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink } from 'better-auth/plugins';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { loadApplicationConfig } from '$lib/server/config/load';

const environmentFile = existsSync('.env') ? '.env' : '.env.example';
process.loadEnvFile(environmentFile);

const config = loadApplicationConfig(process.env);
const pool = new Pool({
  host: config.database.host,
  port: config.database.port,
  database: config.database.name,
  user: config.database.user,
  password: config.database.password,
  max: 1,
  allowExitOnIdle: true
});
const database = drizzle({ client: pool });

export const auth = betterAuth({
  appName: 'Pale Orbit Press',
  baseURL: config.origin,
  secret: config.auth.secret,
  database: drizzleAdapter(database, { provider: 'pg' }),
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    requireEmailVerification: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    resetPasswordTokenExpiresIn: config.auth.resetExpiresIn,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async () => undefined
  },
  emailVerification: {
    expiresIn: config.auth.verificationExpiresIn,
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async () => undefined
  },
  session: { expiresIn: config.auth.sessionExpiresIn },
  rateLimit: {
    enabled: true,
    storage: 'database',
    modelName: 'rateLimit',
    window: config.auth.rateLimit.windowSeconds,
    max: config.auth.rateLimit.max,
    customRules: {
      '/sign-in/email': {
        window: config.auth.rateLimit.windowSeconds,
        max: config.auth.rateLimit.loginMax
      },
      '/request-password-reset': {
        window: config.auth.rateLimit.windowSeconds,
        max: config.auth.rateLimit.emailMax
      },
      '/send-verification-email': {
        window: config.auth.rateLimit.windowSeconds,
        max: config.auth.rateLimit.emailMax
      },
      '/sign-in/magic-link': {
        window: config.auth.rateLimit.windowSeconds,
        max: config.auth.rateLimit.emailMax
      }
    }
  },
  advanced: {
    useSecureCookies: config.environment === 'production',
    database: { generateId: 'uuid' }
  },
  trustedOrigins: [new URL(config.origin).origin],
  telemetry: { enabled: false },
  plugins: [
    magicLink({
      expiresIn: config.auth.magicExpiresIn,
      disableSignUp: false,
      sendMagicLink: async () => undefined
    })
  ]
});
