import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ConfigurationError, type EnvironmentValues } from './read-setting';
import { loadWorkerHealthConfig, type WorkerProcessConfig } from './worker';

const VALID_WORKER_ENVIRONMENT: EnvironmentValues = {
  WORKER_READY_FILE: '.worker-ready',
  WORKER_CONCURRENCY: '1',
  WORKER_HEARTBEAT_INTERVAL_MS: '5000',
  WORKER_HEARTBEAT_MAX_AGE_MS: '20000',
  JOB_POLL_INTERVAL_MS: '1000',
  JOB_LEASE_MS: '30000'
};

function configurationErrorFor(source: EnvironmentValues): ConfigurationError {
  try {
    loadWorkerHealthConfig(source);
  } catch (cause: unknown) {
    expect(cause).toBeInstanceOf(ConfigurationError);
    return cause as ConfigurationError;
  }
  throw new Error('Expected worker configuration to be rejected');
}

describe('loadWorkerHealthConfig', () => {
  it('returns only the four worker process settings', () => {
    const config: WorkerProcessConfig = loadWorkerHealthConfig(VALID_WORKER_ENVIRONMENT);

    expect(config).toEqual({
      heartbeatFile: '.worker-ready',
      concurrency: 1,
      heartbeatIntervalMs: 5000,
      heartbeatMaxAgeMs: 20000
    });
    expect(config).not.toHaveProperty('pollIntervalMs');
    expect(config).not.toHaveProperty('leaseMs');
  });

  it('applies heartbeat timing defaults only when both forms are absent', () => {
    const config = loadWorkerHealthConfig({
      WORKER_READY_FILE: '.worker-ready',
      WORKER_CONCURRENCY: '1',
      JOB_POLL_INTERVAL_MS: '1000',
      JOB_LEASE_MS: '30000'
    });

    expect(config).toEqual({
      heartbeatFile: '.worker-ready',
      concurrency: 1,
      heartbeatIntervalMs: 5000,
      heartbeatMaxAgeMs: 20000
    });
  });

  it.each(['WORKER_READY_FILE', 'WORKER_CONCURRENCY'])(
    'does not default required worker setting %s',
    (name) => {
      expect(
        () => loadWorkerHealthConfig({ ...VALID_WORKER_ENVIRONMENT, [name]: undefined })
      ).toThrow(new RegExp(`${name} or ${name}_FILE is required`, 'u'));
    }
  );

  it('reads exactly the six worker-health settings through file indirection', () => {
    const paths = {
      WORKER_READY_FILE: '/run/settings/worker-ready-file',
      WORKER_CONCURRENCY: '/run/settings/worker-concurrency',
      WORKER_HEARTBEAT_INTERVAL_MS: '/run/settings/worker-heartbeat-interval',
      WORKER_HEARTBEAT_MAX_AGE_MS: '/run/settings/worker-heartbeat-max-age',
      JOB_POLL_INTERVAL_MS: '/run/settings/job-poll-interval',
      JOB_LEASE_MS: '/run/settings/job-lease'
    } as const;
    const values: Readonly<Record<string, string>> = {
      [paths.WORKER_READY_FILE]: ' /tmp/worker-heartbeat \n',
      [paths.WORKER_CONCURRENCY]: '2\n',
      [paths.WORKER_HEARTBEAT_INTERVAL_MS]: '6000\n',
      [paths.WORKER_HEARTBEAT_MAX_AGE_MS]: '24000\n',
      [paths.JOB_POLL_INTERVAL_MS]: '2000\n',
      [paths.JOB_LEASE_MS]: '30000\n'
    };
    const source: EnvironmentValues = {
      ...Object.fromEntries(
        Object.entries(paths).map(([name, path]) => [`${name}_FILE`, path])
      ),
      DATABASE_PASSWORD_FILE: '/run/secrets/database',
      STORAGE_STAGING_ROOT_FILE: '/run/settings/storage',
      SMTP_PASSWORD_FILE: '/run/secrets/smtp',
      AUTH_SECRET_FILE: '/run/secrets/auth',
      STRIPE_SECRET_KEY_FILE: '/run/secrets/stripe',
      STRIPE_WEBHOOK_SECRET_FILE: '/run/secrets/webhook',
      ORIGIN_FILE: '/run/settings/origin',
      APPLICATION_MODE_FILE: '/run/settings/application-mode',
      JOB_RETRY_BASE_MS_FILE: '/run/settings/retry-base',
      JOB_RETRY_MAX_MS_FILE: '/run/settings/retry-max',
      BOOTSTRAP_ADMIN_PASSWORD_FILE: '/run/secrets/bootstrap',
      DATABASE_OWNER_PASSWORD_FILE: '/run/secrets/database-owner'
    };
    const readSecretFile = vi.fn((path: string) => {
      const value = values[path];
      if (value === undefined) throw new Error(`unexpected setting read: ${path}`);
      return value;
    });

    expect(loadWorkerHealthConfig(source, readSecretFile)).toEqual({
      heartbeatFile: '/tmp/worker-heartbeat',
      concurrency: 2,
      heartbeatIntervalMs: 6000,
      heartbeatMaxAgeMs: 24000
    });
    expect(readSecretFile.mock.calls.map(([path]) => path)).toEqual(Object.values(paths));
  });

  it('accepts inclusive timing and concurrency boundaries', () => {
    expect(
      loadWorkerHealthConfig({
        ...VALID_WORKER_ENVIRONMENT,
        WORKER_CONCURRENCY: '1',
        WORKER_HEARTBEAT_INTERVAL_MS: '1000',
        WORKER_HEARTBEAT_MAX_AGE_MS: '3000',
        JOB_POLL_INTERVAL_MS: '1000',
        JOB_LEASE_MS: '3001'
      })
    ).toMatchObject({ concurrency: 1, heartbeatIntervalMs: 1000, heartbeatMaxAgeMs: 3000 });

    expect(
      loadWorkerHealthConfig({
        ...VALID_WORKER_ENVIRONMENT,
        WORKER_CONCURRENCY: '16',
        WORKER_HEARTBEAT_INTERVAL_MS: '30000',
        WORKER_HEARTBEAT_MAX_AGE_MS: '300000',
        JOB_POLL_INTERVAL_MS: '240000',
        JOB_LEASE_MS: '300001'
      })
    ).toMatchObject({
      concurrency: 16,
      heartbeatIntervalMs: 30000,
      heartbeatMaxAgeMs: 300000
    });
  });

  it.each(['0', '17', '1.5', '-1', '9007199254740993'])(
    'rejects non-bounded concurrency %s with one fixed field error',
    (value) => {
      expect(
        configurationErrorFor({ ...VALID_WORKER_ENVIRONMENT, WORKER_CONCURRENCY: value }).message
      ).toBe(
        'Invalid worker configuration: WORKER_CONCURRENCY: must be an integer between 1 and 16'
      );
    }
  );

  it.each(['999', '30001', '1000.5', '-1000', '9007199254740993'])(
    'rejects non-bounded heartbeat interval %s with one fixed field error',
    (value) => {
      expect(
        configurationErrorFor({
          ...VALID_WORKER_ENVIRONMENT,
          WORKER_HEARTBEAT_INTERVAL_MS: value
        }).message
      ).toBe(
        'Invalid worker configuration: WORKER_HEARTBEAT_INTERVAL_MS: must be an integer between 1000 and 30000'
      );
    }
  );

  it.each(['0', '300001', '20000.5', '-20000', '9007199254740993'])(
    'rejects non-bounded heartbeat maximum age %s with one fixed field error',
    (value) => {
      expect(
        configurationErrorFor({
          ...VALID_WORKER_ENVIRONMENT,
          WORKER_HEARTBEAT_MAX_AGE_MS: value
        }).message
      ).toBe(
        'Invalid worker configuration: WORKER_HEARTBEAT_MAX_AGE_MS: must be an integer between 1 and 300000'
      );
    }
  );

  it.each([
    ['JOB_POLL_INTERVAL_MS', '9007199254740993'],
    ['JOB_LEASE_MS', '9007199254740993']
  ])('rejects unsafe worker-health dependency %s', (name, value) => {
    expect(
      configurationErrorFor({ ...VALID_WORKER_ENVIRONMENT, [name]: value }).message
    ).toBe(
      `Invalid worker configuration: ${name}: must be an integer between 1 and 86400000`
    );
  });

  it('collects every applicable freshness inequality with fixed field messages', () => {
    expect(
      configurationErrorFor({
        ...VALID_WORKER_ENVIRONMENT,
        WORKER_HEARTBEAT_INTERVAL_MS: '1000',
        WORKER_HEARTBEAT_MAX_AGE_MS: '1000',
        JOB_POLL_INTERVAL_MS: '10000',
        JOB_LEASE_MS: '1000'
      }).message
    ).toBe(
      'Invalid worker configuration: ' +
        'WORKER_HEARTBEAT_MAX_AGE_MS: must be at least three times WORKER_HEARTBEAT_INTERVAL_MS; ' +
        'WORKER_HEARTBEAT_MAX_AGE_MS: must be at least JOB_POLL_INTERVAL_MS plus twice WORKER_HEARTBEAT_INTERVAL_MS; ' +
        'WORKER_HEARTBEAT_MAX_AGE_MS: must be less than JOB_LEASE_MS'
    );
  });

  it('rejects an empty heartbeat path with a fixed field error', () => {
    expect(
      configurationErrorFor({ ...VALID_WORKER_ENVIRONMENT, WORKER_READY_FILE: '   ' }).message
    ).toBe('Invalid worker configuration: WORKER_READY_FILE: cannot be empty');
  });
});

describe('worker configuration dependency boundary', () => {
  it('imports only Zod and the setting reader', () => {
    const source = readFileSync(fileURLToPath(new URL('./worker.ts', import.meta.url)), 'utf8');
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/gu)].map(
      (match) => match[1]
    );

    expect(imports).toEqual(['zod', './read-setting']);
  });
});
