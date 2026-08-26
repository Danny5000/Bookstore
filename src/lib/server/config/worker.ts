import { z } from 'zod';
import {
  ConfigurationError,
  readDefaultedSetting,
  readRequiredSetting,
  type EnvironmentValues,
  type SecretFileReader
} from './read-setting';

const boundedIntegerSetting = (minimum: number, maximum: number) =>
  z
    .string()
    .superRefine((value, context) => {
      const parsed = Number(value);
      if (
        !/^\d+$/u.test(value) ||
        !Number.isSafeInteger(parsed) ||
        parsed < minimum ||
        parsed > maximum
      ) {
        context.addIssue({
          code: 'custom',
          message: `must be an integer between ${minimum} and ${maximum}`
        });
      }
    })
    .transform((value) => Number(value));

const rawWorkerProcessConfigSchema = z
  .strictObject({
    WORKER_READY_FILE: z.string().trim().min(1, 'cannot be empty'),
    WORKER_CONCURRENCY: boundedIntegerSetting(1, 16),
    WORKER_HEARTBEAT_INTERVAL_MS: boundedIntegerSetting(1_000, 30_000),
    WORKER_HEARTBEAT_MAX_AGE_MS: boundedIntegerSetting(1, 300_000),
    JOB_POLL_INTERVAL_MS: boundedIntegerSetting(1, 86_400_000),
    JOB_LEASE_MS: boundedIntegerSetting(1, 86_400_000)
  })
  .superRefine((value, context) => {
    const hasValidFreshnessInputs =
      Number.isSafeInteger(value.WORKER_HEARTBEAT_INTERVAL_MS) &&
      value.WORKER_HEARTBEAT_INTERVAL_MS >= 1_000 &&
      value.WORKER_HEARTBEAT_INTERVAL_MS <= 30_000 &&
      Number.isSafeInteger(value.WORKER_HEARTBEAT_MAX_AGE_MS) &&
      value.WORKER_HEARTBEAT_MAX_AGE_MS >= 1 &&
      value.WORKER_HEARTBEAT_MAX_AGE_MS <= 300_000 &&
      Number.isSafeInteger(value.JOB_POLL_INTERVAL_MS) &&
      value.JOB_POLL_INTERVAL_MS >= 1 &&
      value.JOB_POLL_INTERVAL_MS <= 86_400_000 &&
      Number.isSafeInteger(value.JOB_LEASE_MS) &&
      value.JOB_LEASE_MS >= 1 &&
      value.JOB_LEASE_MS <= 86_400_000;
    if (!hasValidFreshnessInputs) return;

    if (value.WORKER_HEARTBEAT_MAX_AGE_MS < 3 * value.WORKER_HEARTBEAT_INTERVAL_MS) {
      context.addIssue({
        code: 'custom',
        path: ['WORKER_HEARTBEAT_MAX_AGE_MS'],
        message: 'must be at least three times WORKER_HEARTBEAT_INTERVAL_MS'
      });
    }

    if (
      value.WORKER_HEARTBEAT_MAX_AGE_MS <
      value.JOB_POLL_INTERVAL_MS + 2 * value.WORKER_HEARTBEAT_INTERVAL_MS
    ) {
      context.addIssue({
        code: 'custom',
        path: ['WORKER_HEARTBEAT_MAX_AGE_MS'],
        message:
          'must be at least JOB_POLL_INTERVAL_MS plus twice WORKER_HEARTBEAT_INTERVAL_MS'
      });
    }

    if (value.WORKER_HEARTBEAT_MAX_AGE_MS >= value.JOB_LEASE_MS) {
      context.addIssue({
        code: 'custom',
        path: ['WORKER_HEARTBEAT_MAX_AGE_MS'],
        message: 'must be less than JOB_LEASE_MS'
      });
    }
  })
  .transform((value) => ({
    heartbeatFile: value.WORKER_READY_FILE,
    concurrency: value.WORKER_CONCURRENCY,
    heartbeatIntervalMs: value.WORKER_HEARTBEAT_INTERVAL_MS,
    heartbeatMaxAgeMs: value.WORKER_HEARTBEAT_MAX_AGE_MS
  }));

export interface WorkerProcessConfig {
  readonly heartbeatFile: string;
  readonly concurrency: number;
  readonly heartbeatIntervalMs: number;
  readonly heartbeatMaxAgeMs: number;
}

export function loadWorkerHealthConfig(
  source: EnvironmentValues,
  readSecretFile?: SecretFileReader
): WorkerProcessConfig {
  const result = rawWorkerProcessConfigSchema.safeParse({
    WORKER_READY_FILE: readRequiredSetting(source, 'WORKER_READY_FILE', readSecretFile),
    WORKER_CONCURRENCY: readRequiredSetting(source, 'WORKER_CONCURRENCY', readSecretFile),
    WORKER_HEARTBEAT_INTERVAL_MS: readDefaultedSetting(
      source,
      'WORKER_HEARTBEAT_INTERVAL_MS',
      '5000',
      readSecretFile
    ),
    WORKER_HEARTBEAT_MAX_AGE_MS: readDefaultedSetting(
      source,
      'WORKER_HEARTBEAT_MAX_AGE_MS',
      '20000',
      readSecretFile
    ),
    JOB_POLL_INTERVAL_MS: readRequiredSetting(source, 'JOB_POLL_INTERVAL_MS', readSecretFile),
    JOB_LEASE_MS: readRequiredSetting(source, 'JOB_LEASE_MS', readSecretFile)
  });

  if (result.success) return result.data;
  throw new ConfigurationError(
    `Invalid worker configuration: ${result.error.issues
      .map((issue) => `${issue.path.join('.') || 'configuration'}: ${issue.message}`)
      .join('; ')}`
  );
}
