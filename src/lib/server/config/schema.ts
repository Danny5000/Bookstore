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
    WORKER_READY_FILE: z.string().trim().min(1)
  })
  .superRefine((value, context) => {
    if (value.APP_ENV === 'production' && value.APPLICATION_MODE !== 'maintenance') {
      context.addIssue({
        code: 'custom',
        path: ['APPLICATION_MODE'],
        message: 'production must use maintenance mode'
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
      workerReadyFile: value.WORKER_READY_FILE
    }
  }));

export type ApplicationConfig = z.output<typeof rawApplicationConfigSchema>;
export type ApplicationMode = ApplicationConfig['applicationMode'];
export type DatabaseConfig = ApplicationConfig['database'];
export type JobConfig = ApplicationConfig['jobs'];

export function parseApplicationConfig(value: unknown): ApplicationConfig {
  const result = rawApplicationConfigSchema.safeParse(value);
  if (result.success) return result.data;

  const details = result.error.issues
    .map((issue) => `${issue.path.join('.') || 'configuration'}: ${issue.message}`)
    .join('; ');
  throw new ConfigurationError(`Invalid application configuration: ${details}`);
}
