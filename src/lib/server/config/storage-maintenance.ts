import path from 'node:path';
import { z } from 'zod';
import {
  ConfigurationError,
  readOptionalSetting,
  readRequiredSetting,
  type EnvironmentValues,
  type SecretFileReader
} from './read-setting';

const integerSetting = (minimum: number, maximum: number) => z
  .string()
  .regex(/^\d+$/u)
  .transform(Number)
  .pipe(z.number().int().min(minimum).max(maximum));

const rawSchema = z.strictObject({
  APP_ENV: z.enum(['development', 'test', 'production']),
  DATABASE_HOST: z.string().trim().min(1),
  DATABASE_PORT: integerSetting(1, 65_535),
  DATABASE_NAME: z.string().trim().min(1),
  DATABASE_USER: z.string().trim().min(1),
  DATABASE_PASSWORD: z.string().min(1),
  DATABASE_POOL_MAX: integerSetting(1, 100),
  DATABASE_CONNECTION_TIMEOUT_MS: integerSetting(1, 86_400_000),
  DATABASE_STATEMENT_TIMEOUT_MS: integerSetting(1, 86_400_000),
  DATABASE_READINESS_TIMEOUT_MS: integerSetting(1, 86_400_000),
  STORAGE_PROVIDER: z.enum(['local', 's3']),
  STORAGE_STAGING_ROOT: z.string().trim().min(1).optional(),
  STORAGE_PUBLICATION_ROOT: z.string().trim().min(1).optional(),
  STORAGE_COVERS_ROOT: z.string().trim().min(1).optional(),
  STORAGE_SCRATCH_ROOT: z.string().trim().min(1).optional(),
  STORAGE_STAGING_RETENTION_HOURS: integerSetting(1, 87_600),
  STORAGE_ORPHAN_RETENTION_HOURS: integerSetting(1, 87_600)
}).superRefine((value, context) => {
  if (value.STORAGE_STAGING_RETENTION_HOURS > value.STORAGE_ORPHAN_RETENTION_HOURS) {
    context.addIssue({
      code: 'custom', path: ['STORAGE_ORPHAN_RETENTION_HOURS'],
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
        code: 'custom', path: ['STORAGE_SCRATCH_ROOT'],
        message: 'is required for local storage in production'
      });
    }
    const roots = [
      ...persistentStorageRoots,
      ['STORAGE_SCRATCH_ROOT', value.STORAGE_SCRATCH_ROOT] as const
    ];
    for (const [name, root] of roots) {
      if (root && (value.APP_ENV === 'production' || name === 'STORAGE_SCRATCH_ROOT') && !path.isAbsolute(root)) {
        context.addIssue({ code: 'custom', path: [name], message: 'must be absolute' });
      }
    }
    const configured: Array<readonly [string, string]> = [];
    for (const [name, root] of roots) {
      if (root) configured.push([name, root]);
    }
    for (let left = 0; left < configured.length; left += 1) {
      for (let right = left + 1; right < configured.length; right += 1) {
        const leftRoot = path.resolve(configured[left]![1]);
        const rightRoot = path.resolve(configured[right]![1]);
        const relativeLeft = path.relative(leftRoot, rightRoot);
        const relativeRight = path.relative(rightRoot, leftRoot);
        const nested = (relativePath: string) => relativePath === '' ||
          (relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`));
        if (nested(relativeLeft) || nested(relativeRight)) {
          context.addIssue({
            code: 'custom', path: [configured[right]![0]],
            message: 'local storage roots must be mutually disjoint'
          });
        }
      }
    }
  }
}).transform((value) => ({
  environment: value.APP_ENV,
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
  storage: {
    provider: value.STORAGE_PROVIDER,
    stagingRoot: value.STORAGE_STAGING_ROOT,
    publicationRoot: value.STORAGE_PUBLICATION_ROOT,
    coversRoot: value.STORAGE_COVERS_ROOT,
    scratchRoot: value.STORAGE_SCRATCH_ROOT,
    stagingRetentionHours: value.STORAGE_STAGING_RETENTION_HOURS,
    orphanRetentionHours: value.STORAGE_ORPHAN_RETENTION_HOURS
  }
}));

export type StorageMaintenanceConfig = z.output<typeof rawSchema>;

export function parseStorageCleanupArguments(arguments_: readonly string[]): 'dry-run' | 'apply' {
  if (arguments_.length === 0) return 'dry-run';
  if (arguments_.length === 2 && arguments_[0] === '--apply' &&
    arguments_[1] === '--writers-quiesced') return 'apply';
  throw new ConfigurationError('Usage: storage:cleanup [--apply --writers-quiesced]');
}

const required = [
  'APP_ENV',
  'DATABASE_HOST',
  'DATABASE_PORT',
  'DATABASE_NAME',
  'DATABASE_USER',
  'DATABASE_PASSWORD',
  'DATABASE_POOL_MAX',
  'DATABASE_CONNECTION_TIMEOUT_MS',
  'DATABASE_STATEMENT_TIMEOUT_MS',
  'DATABASE_READINESS_TIMEOUT_MS',
  'STORAGE_PROVIDER',
  'STORAGE_STAGING_RETENTION_HOURS',
  'STORAGE_ORPHAN_RETENTION_HOURS'
] as const;

export function loadStorageMaintenanceConfig(
  source: EnvironmentValues,
  readSecretFile?: SecretFileReader
): StorageMaintenanceConfig {
  const input = Object.fromEntries([
    ...required.map((name) => [name, readRequiredSetting(source, name, readSecretFile)]),
    ...[
      'STORAGE_STAGING_ROOT',
      'STORAGE_PUBLICATION_ROOT',
      'STORAGE_COVERS_ROOT',
      'STORAGE_SCRATCH_ROOT'
    ].map((name) => [name, readOptionalSetting(source, name, readSecretFile)])
  ]);
  const result = rawSchema.safeParse(input);
  if (result.success) return result.data;
  const details = result.error.issues
    .map((issue) => `${issue.path.join('.') || 'configuration'}: ${issue.message}`)
    .join('; ');
  throw new ConfigurationError(`Invalid storage maintenance configuration: ${details}`);
}
