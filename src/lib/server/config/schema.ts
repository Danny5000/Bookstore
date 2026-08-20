import path from 'node:path';
import { z } from 'zod';
import { ConfigurationError } from './read-setting';

const integerSetting = (minimum: number, maximum: number) =>
  z
    .string()
    .regex(/^\d+$/, `must be an integer between ${minimum} and ${maximum}`)
    .transform((value) => Number.parseInt(value, 10))
    .pipe(z.number().int().min(minimum).max(maximum));

const port = integerSetting(1, 65_535);
const milliseconds = integerSetting(1, 86_400_000);
const seconds = integerSetting(1, 31_536_000);
const claimCapabilitySeconds = integerSetting(1, 86_400);
const booleanSetting = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const rawDatabaseConfigSchema = z.strictObject({
  DATABASE_HOST: z.string().trim().min(1),
  DATABASE_PORT: port,
  DATABASE_NAME: z.string().trim().min(1),
  DATABASE_USER: z.string().trim().min(1),
  DATABASE_PASSWORD: z.string().min(1),
  DATABASE_POOL_MAX: integerSetting(1, 100),
  DATABASE_CONNECTION_TIMEOUT_MS: milliseconds,
  DATABASE_STATEMENT_TIMEOUT_MS: milliseconds,
  DATABASE_READINESS_TIMEOUT_MS: milliseconds
}).transform((value) => ({
  host: value.DATABASE_HOST,
  port: value.DATABASE_PORT,
  name: value.DATABASE_NAME,
  user: value.DATABASE_USER,
  password: value.DATABASE_PASSWORD,
  poolMax: value.DATABASE_POOL_MAX,
  connectionTimeoutMs: value.DATABASE_CONNECTION_TIMEOUT_MS,
  statementTimeoutMs: value.DATABASE_STATEMENT_TIMEOUT_MS,
  readinessTimeoutMs: value.DATABASE_READINESS_TIMEOUT_MS
}));

const rawApplicationConfigSchema = z
  .object({
    APP_ENV: z.enum(['development', 'test', 'production']),
    APPLICATION_MODE: z.enum(['prototype', 'maintenance']),
    ORIGIN: z.url().refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === 'http:' || protocol === 'https:';
    }, 'must use http or https'),
    DATABASE_HOST: z.string().trim().min(1),
    DATABASE_PORT: port,
    DATABASE_NAME: z.string().trim().min(1),
    DATABASE_USER: z.string().trim().min(1),
    DATABASE_PASSWORD: z.string().min(1),
    DATABASE_POOL_MAX: integerSetting(1, 100),
    DATABASE_CONNECTION_TIMEOUT_MS: milliseconds,
    DATABASE_STATEMENT_TIMEOUT_MS: milliseconds,
    DATABASE_READINESS_TIMEOUT_MS: milliseconds,
    JOB_POLL_INTERVAL_MS: milliseconds,
    JOB_LEASE_MS: milliseconds,
    JOB_RETRY_BASE_MS: milliseconds,
    JOB_RETRY_MAX_MS: milliseconds,
    WORKER_READY_FILE: z.string().trim().min(1),
    WORKER_CONCURRENCY: integerSetting(1, 16),
    STORAGE_PROVIDER: z.enum(['local', 's3']),
    STORAGE_STAGING_ROOT: z.string().trim().min(1).optional(),
    STORAGE_PUBLICATION_ROOT: z.string().trim().min(1).optional(),
    STORAGE_COVERS_ROOT: z.string().trim().min(1).optional(),
    STORAGE_SCRATCH_ROOT: z.string().trim().min(1).optional(),
    UPLOAD_MAX_BYTES: integerSetting(1, Number.MAX_SAFE_INTEGER),
    INGEST_MAX_EXPANDED_BYTES: integerSetting(1, Number.MAX_SAFE_INTEGER),
    INGEST_MAX_ENTRIES: integerSetting(1, 100_000),
    INGEST_MAX_XML_BYTES: integerSetting(1, Number.MAX_SAFE_INTEGER),
    INGEST_MAX_IMAGE_PIXELS: integerSetting(1, 1_000_000_000),
    INGEST_MAX_COMPRESSION_RATIO: integerSetting(1, 100_000),
    INGEST_TIMEOUT_MS: milliseconds,
    STORAGE_STAGING_RETENTION_HOURS: integerSetting(1, 87_600),
    STORAGE_ORPHAN_RETENTION_HOURS: integerSetting(1, 87_600),
    AUTH_SECRET: z.string().min(32),
    AUTH_SESSION_EXPIRES_SECONDS: seconds,
    AUTH_VERIFICATION_EXPIRES_SECONDS: seconds,
    AUTH_RESET_EXPIRES_SECONDS: claimCapabilitySeconds,
    AUTH_MAGIC_EXPIRES_SECONDS: claimCapabilitySeconds,
    AUTH_RATE_LIMIT_WINDOW_SECONDS: integerSetting(1, 86_400),
    AUTH_RATE_LIMIT_MAX: integerSetting(1, 100_000),
    AUTH_LOGIN_RATE_LIMIT_MAX: integerSetting(1, 10_000),
    AUTH_EMAIL_RATE_LIMIT_MAX: integerSetting(1, 10_000),
    STRIPE_ENABLED: booleanSetting,
    STRIPE_TEST_FIXTURE_MODE: booleanSetting,
    STRIPE_LIVE_MODE: booleanSetting,
    STRIPE_SECRET_KEY: z.string().trim().min(9).max(500).optional(),
    STRIPE_WEBHOOK_SECRET: z.string().trim().min(7).max(500).optional(),
    STRIPE_AUTOMATIC_TAX_ENABLED: booleanSetting,
    STRIPE_TAX_CODE_PROSE: z
      .string()
      .trim()
      .regex(/^txcd_[A-Za-z0-9]+$/u, 'must be a Stripe tax code')
      .max(200)
      .optional(),
    STRIPE_TAX_CODE_COMIC: z
      .string()
      .trim()
      .regex(/^txcd_[A-Za-z0-9]+$/u, 'must be a Stripe tax code')
      .max(200)
      .optional(),
    STRIPE_CHECKOUT_DURATION_SECONDS: integerSetting(1_800, 1_800),
    STRIPE_WEBHOOK_TOLERANCE_SECONDS: integerSetting(1, 900),
    COMMERCE_CHECKOUT_RATE_LIMIT_WINDOW_SECONDS: integerSetting(1, 86_400),
    COMMERCE_CHECKOUT_RATE_LIMIT_MAX: integerSetting(1, 10_000),
    SMTP_HOST: z.string().trim().min(1),
    SMTP_PORT: port,
    SMTP_SECURE: booleanSetting,
    SMTP_REQUIRE_TLS: booleanSetting,
    SMTP_USER: z.string().trim().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
    SMTP_FROM: z.string().trim().min(3),
    SMTP_CONNECTION_TIMEOUT_MS: milliseconds,
    SMTP_GREETING_TIMEOUT_MS: milliseconds,
    SMTP_SOCKET_TIMEOUT_MS: milliseconds
  })
  .superRefine((value, context) => {
    if (value.APP_ENV === 'production' && value.APPLICATION_MODE !== 'maintenance') {
      context.addIssue({
        code: 'custom',
        path: ['APPLICATION_MODE'],
        message: 'production must use maintenance mode'
      });
    }

    if (value.APP_ENV === 'production' && new URL(value.ORIGIN).protocol !== 'https:') {
      context.addIssue({
        code: 'custom',
        path: ['ORIGIN'],
        message: 'production must use https'
      });
    }

    if (value.SMTP_SECURE && value.SMTP_REQUIRE_TLS) {
      context.addIssue({
        code: 'custom',
        path: ['SMTP_REQUIRE_TLS'],
        message: 'must be false when SMTP_SECURE is true'
      });
    }

    if (Boolean(value.SMTP_USER) !== Boolean(value.SMTP_PASSWORD)) {
      context.addIssue({
        code: 'custom',
        path: ['SMTP_PASSWORD'],
        message: 'SMTP_USER and SMTP_PASSWORD must be configured together'
      });
    }

    if (value.STRIPE_TEST_FIXTURE_MODE && value.APP_ENV !== 'test') {
      context.addIssue({
        code: 'custom',
        path: ['STRIPE_TEST_FIXTURE_MODE'],
        message: 'is allowed only in test'
      });
    }

    if (value.STRIPE_TEST_FIXTURE_MODE && value.STRIPE_ENABLED) {
      context.addIssue({
        code: 'custom',
        path: ['STRIPE_TEST_FIXTURE_MODE'],
        message: 'requires STRIPE_ENABLED=false'
      });
    }

    if (value.STRIPE_ENABLED && value.STRIPE_SECRET_KEY) {
      const requiredPrefix = value.STRIPE_LIVE_MODE ? 'sk_live_' : 'sk_test_';
      if (!value.STRIPE_SECRET_KEY.startsWith(requiredPrefix)) {
        context.addIssue({
          code: 'custom',
          path: ['STRIPE_SECRET_KEY'],
          message: 'must match STRIPE_LIVE_MODE'
        });
      }
    }

    if (
      value.STRIPE_ENABLED &&
      value.STRIPE_WEBHOOK_SECRET &&
      !value.STRIPE_WEBHOOK_SECRET.startsWith('whsec_')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['STRIPE_WEBHOOK_SECRET'],
        message: 'must begin with whsec_'
      });
    }

    if (value.STRIPE_AUTOMATIC_TAX_ENABLED && !value.STRIPE_TAX_CODE_PROSE) {
      context.addIssue({
        code: 'custom',
        path: ['STRIPE_TAX_CODE_PROSE'],
        message: 'is required when STRIPE_AUTOMATIC_TAX_ENABLED=true'
      });
    }

    if (value.STRIPE_AUTOMATIC_TAX_ENABLED && !value.STRIPE_TAX_CODE_COMIC) {
      context.addIssue({
        code: 'custom',
        path: ['STRIPE_TAX_CODE_COMIC'],
        message: 'is required when STRIPE_AUTOMATIC_TAX_ENABLED=true'
      });
    }

    if (value.JOB_POLL_INTERVAL_MS >= value.JOB_LEASE_MS) {
      context.addIssue({
        code: 'custom',
        path: ['JOB_LEASE_MS'],
        message: 'must be greater than JOB_POLL_INTERVAL_MS'
      });
    }

    if (value.JOB_RETRY_BASE_MS > value.JOB_RETRY_MAX_MS) {
      context.addIssue({
        code: 'custom',
        path: ['JOB_RETRY_BASE_MS'],
        message: 'must not exceed JOB_RETRY_MAX_MS'
      });
    }

    if (value.INGEST_MAX_EXPANDED_BYTES < value.UPLOAD_MAX_BYTES) {
      context.addIssue({
        code: 'custom',
        path: ['INGEST_MAX_EXPANDED_BYTES'],
        message: 'must be greater than or equal to UPLOAD_MAX_BYTES'
      });
    }

    if (value.INGEST_MAX_XML_BYTES > value.INGEST_MAX_EXPANDED_BYTES) {
      context.addIssue({
        code: 'custom',
        path: ['INGEST_MAX_XML_BYTES'],
        message: 'must not exceed INGEST_MAX_EXPANDED_BYTES'
      });
    }

    if (value.STORAGE_STAGING_RETENTION_HOURS > value.STORAGE_ORPHAN_RETENTION_HOURS) {
      context.addIssue({
        code: 'custom',
        path: ['STORAGE_ORPHAN_RETENTION_HOURS'],
        message: 'must be at least STORAGE_STAGING_RETENTION_HOURS'
      });
    }

    const persistentStorageRoots = [
      ['STORAGE_STAGING_ROOT', value.STORAGE_STAGING_ROOT],
      ['STORAGE_PUBLICATION_ROOT', value.STORAGE_PUBLICATION_ROOT],
      ['STORAGE_COVERS_ROOT', value.STORAGE_COVERS_ROOT]
    ] as const;
    if (value.STORAGE_PROVIDER === 'local') {
      for (const [name, root] of persistentStorageRoots) {
        if (!root) context.addIssue({ code: 'custom', path: [name], message: 'is required for local storage' });
      }
      if (value.APP_ENV === 'production' && !value.STORAGE_SCRATCH_ROOT) {
        context.addIssue({
          code: 'custom',
          path: ['STORAGE_SCRATCH_ROOT'],
          message: 'is required for local storage in production'
        });
      }
      for (const [name, root] of [
        ...persistentStorageRoots,
        ['STORAGE_SCRATCH_ROOT', value.STORAGE_SCRATCH_ROOT] as const
      ]) {
        if (root && (value.APP_ENV === 'production' || name === 'STORAGE_SCRATCH_ROOT') && !path.isAbsolute(root)) {
          context.addIssue({ code: 'custom', path: [name], message: 'must be absolute' });
        }
      }
      const configuredRoots: Array<readonly [string, string]> = [];
      for (const [name, root] of [
        ...persistentStorageRoots,
        ['STORAGE_SCRATCH_ROOT', value.STORAGE_SCRATCH_ROOT] as const
      ]) {
        if (root) configuredRoots.push([name, root]);
      }
      for (let left = 0; left < configuredRoots.length; left += 1) {
        for (let right = left + 1; right < configuredRoots.length; right += 1) {
          const leftRoot = path.resolve(configuredRoots[left]![1]);
          const rightRoot = path.resolve(configuredRoots[right]![1]);
          const relativeLeft = path.relative(leftRoot, rightRoot);
          const relativeRight = path.relative(rightRoot, leftRoot);
          const nested = (relativePath: string) =>
            relativePath === '' ||
            (relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`));
          if (nested(relativeLeft) || nested(relativeRight)) {
            context.addIssue({
              code: 'custom',
              path: [configuredRoots[right]![0]],
              message: 'local storage roots must be mutually disjoint'
            });
          }
        }
      }
    }
  })
  .transform((value) => ({
    environment: value.APP_ENV,
    applicationMode: value.APPLICATION_MODE,
    origin: value.ORIGIN,
    database: {
      host: value.DATABASE_HOST,
      port: value.DATABASE_PORT,
      name: value.DATABASE_NAME,
      user: value.DATABASE_USER,
      password: value.DATABASE_PASSWORD,
      poolMax: value.DATABASE_POOL_MAX,
      connectionTimeoutMs: value.DATABASE_CONNECTION_TIMEOUT_MS,
      statementTimeoutMs: value.DATABASE_STATEMENT_TIMEOUT_MS,
      readinessTimeoutMs: value.DATABASE_READINESS_TIMEOUT_MS
    },
    jobs: {
      pollIntervalMs: value.JOB_POLL_INTERVAL_MS,
      leaseMs: value.JOB_LEASE_MS,
      retryBaseMs: value.JOB_RETRY_BASE_MS,
      retryMaxMs: value.JOB_RETRY_MAX_MS,
      workerReadyFile: value.WORKER_READY_FILE,
      concurrency: value.WORKER_CONCURRENCY
    },
    storage: {
      provider: value.STORAGE_PROVIDER,
      stagingRoot: value.STORAGE_STAGING_ROOT,
      publicationRoot: value.STORAGE_PUBLICATION_ROOT,
      coversRoot: value.STORAGE_COVERS_ROOT,
      scratchRoot: value.STORAGE_SCRATCH_ROOT,
      stagingRetentionHours: value.STORAGE_STAGING_RETENTION_HOURS,
      orphanRetentionHours: value.STORAGE_ORPHAN_RETENTION_HOURS
    },
    ingestion: {
      maxUploadBytes: value.UPLOAD_MAX_BYTES,
      maxExpandedBytes: value.INGEST_MAX_EXPANDED_BYTES,
      maxEntries: value.INGEST_MAX_ENTRIES,
      maxXmlBytes: value.INGEST_MAX_XML_BYTES,
      maxImagePixels: value.INGEST_MAX_IMAGE_PIXELS,
      maxCompressionRatio: value.INGEST_MAX_COMPRESSION_RATIO,
      timeoutMs: value.INGEST_TIMEOUT_MS
    },
    auth: {
      secret: value.AUTH_SECRET,
      sessionExpiresIn: value.AUTH_SESSION_EXPIRES_SECONDS,
      verificationExpiresIn: value.AUTH_VERIFICATION_EXPIRES_SECONDS,
      resetExpiresIn: value.AUTH_RESET_EXPIRES_SECONDS,
      magicExpiresIn: value.AUTH_MAGIC_EXPIRES_SECONDS,
      rateLimit: {
        windowSeconds: value.AUTH_RATE_LIMIT_WINDOW_SECONDS,
        max: value.AUTH_RATE_LIMIT_MAX,
        loginMax: value.AUTH_LOGIN_RATE_LIMIT_MAX,
        emailMax: value.AUTH_EMAIL_RATE_LIMIT_MAX
      }
    },
    stripe: {
      enabled: value.STRIPE_ENABLED,
      testFixtureMode: value.STRIPE_TEST_FIXTURE_MODE,
      liveMode: value.STRIPE_LIVE_MODE,
      secretKey: value.STRIPE_ENABLED ? value.STRIPE_SECRET_KEY : undefined,
      webhookSecret: value.STRIPE_ENABLED ? value.STRIPE_WEBHOOK_SECRET : undefined,
      automaticTaxEnabled: value.STRIPE_AUTOMATIC_TAX_ENABLED,
      proseTaxCode: value.STRIPE_AUTOMATIC_TAX_ENABLED
        ? value.STRIPE_TAX_CODE_PROSE
        : undefined,
      comicTaxCode: value.STRIPE_AUTOMATIC_TAX_ENABLED
        ? value.STRIPE_TAX_CODE_COMIC
        : undefined,
      checkoutDurationSeconds: value.STRIPE_CHECKOUT_DURATION_SECONDS,
      webhookToleranceSeconds: value.STRIPE_WEBHOOK_TOLERANCE_SECONDS
    },
    commerce: {
      checkoutRateLimitWindowSeconds: value.COMMERCE_CHECKOUT_RATE_LIMIT_WINDOW_SECONDS,
      checkoutRateLimitMax: value.COMMERCE_CHECKOUT_RATE_LIMIT_MAX
    },
    smtp: {
      host: value.SMTP_HOST,
      port: value.SMTP_PORT,
      secure: value.SMTP_SECURE,
      requireTls: value.SMTP_REQUIRE_TLS,
      user: value.SMTP_USER,
      password: value.SMTP_PASSWORD,
      from: value.SMTP_FROM,
      connectionTimeoutMs: value.SMTP_CONNECTION_TIMEOUT_MS,
      greetingTimeoutMs: value.SMTP_GREETING_TIMEOUT_MS,
      socketTimeoutMs: value.SMTP_SOCKET_TIMEOUT_MS
    }
  }));

export type ApplicationConfig = z.output<typeof rawApplicationConfigSchema>;
export type ApplicationMode = ApplicationConfig['applicationMode'];
export type DatabaseConfig = ApplicationConfig['database'];
export type JobConfig = ApplicationConfig['jobs'];
export type StorageConfig = ApplicationConfig['storage'];
export type IngestionConfig = ApplicationConfig['ingestion'];
export type AuthConfig = ApplicationConfig['auth'];
export type StripeConfig = ApplicationConfig['stripe'];
export type CommerceConfig = ApplicationConfig['commerce'];
export type SmtpConfig = ApplicationConfig['smtp'];

export type ApplicationConfigScope = 'full' | 'web' | 'worker';

function configurationError(prefix: string, issues: readonly string[]): ConfigurationError {
  return new ConfigurationError(`${prefix}: ${issues.join('; ')}`);
}

export function parseDatabaseConfig(value: unknown): DatabaseConfig {
  const result = rawDatabaseConfigSchema.safeParse(value);
  if (result.success) return result.data;
  throw configurationError(
    'Invalid database configuration',
    result.error.issues.map(
      (issue) => `${issue.path.join('.') || 'configuration'}: ${issue.message}`
    )
  );
}

export function parseApplicationConfig(
  value: unknown,
  scope: ApplicationConfigScope = 'full'
): ApplicationConfig {
  const result = rawApplicationConfigSchema.safeParse(value);
  if (!result.success) {
    const raw = typeof value === 'object' && value !== null
      ? value as Record<string, unknown>
      : {};
    const scopeIssues: string[] = [];
    if (
      scope !== 'web' &&
      raw.APP_ENV === 'production' &&
      (!raw.SMTP_USER || !raw.SMTP_PASSWORD)
    ) {
      scopeIssues.push('SMTP_USER: production SMTP credentials are required');
    }
    if (raw.STRIPE_ENABLED === 'true' && !raw.STRIPE_SECRET_KEY) {
      scopeIssues.push('STRIPE_SECRET_KEY: is required when STRIPE_ENABLED=true');
    }
    if (scope !== 'worker' && raw.STRIPE_ENABLED === 'true' && !raw.STRIPE_WEBHOOK_SECRET) {
      scopeIssues.push('STRIPE_WEBHOOK_SECRET: is required when STRIPE_ENABLED=true');
    }
    throw configurationError(
      'Invalid application configuration',
      [
        ...result.error.issues.map(
          (issue) => `${issue.path.join('.') || 'configuration'}: ${issue.message}`
        ),
        ...scopeIssues
      ]
    );
  }

  const issues: string[] = [];
  if (
    scope !== 'web' &&
    result.data.environment === 'production' &&
    (!result.data.smtp.user || !result.data.smtp.password)
  ) {
    issues.push('SMTP_USER: production SMTP credentials are required');
  }
  if (result.data.stripe.enabled && !result.data.stripe.secretKey) {
    issues.push('STRIPE_SECRET_KEY: is required when STRIPE_ENABLED=true');
  }
  if (
    scope !== 'worker' &&
    result.data.stripe.enabled &&
    !result.data.stripe.webhookSecret
  ) {
    issues.push('STRIPE_WEBHOOK_SECRET: is required when STRIPE_ENABLED=true');
  }
  if (issues.length > 0) throw configurationError('Invalid application configuration', issues);
  return result.data;
}
