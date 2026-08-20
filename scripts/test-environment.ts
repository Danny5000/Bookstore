const testProcessCredentialNames = new Set([
  'DATABASE_URL',
  'DATABASE_OWNER_USER',
  'DATABASE_OWNER_USER_FILE',
  'DATABASE_OWNER_PASSWORD',
  'DATABASE_OWNER_PASSWORD_FILE',
  'DATABASE_USER',
  'DATABASE_USER_FILE',
  'DATABASE_PASSWORD',
  'DATABASE_PASSWORD_FILE',
  'DATABASE_WORKER_USER',
  'DATABASE_WORKER_USER_FILE',
  'DATABASE_WORKER_PASSWORD',
  'DATABASE_WORKER_PASSWORD_FILE',
  'DATABASE_STORAGE_CLEANUP_USER',
  'DATABASE_STORAGE_CLEANUP_USER_FILE',
  'DATABASE_STORAGE_CLEANUP_PASSWORD',
  'DATABASE_STORAGE_CLEANUP_PASSWORD_FILE',
  'PGPASSWORD',
  'PGPASSFILE',
  'POSTGRES_PASSWORD',
  'POSTGRES_PASSWORD_FILE',
  'AUTH_SECRET',
  'AUTH_SECRET_FILE',
  'BOOTSTRAP_ADMIN_EMAIL',
  'BOOTSTRAP_ADMIN_EMAIL_FILE',
  'BOOTSTRAP_ADMIN_NAME',
  'BOOTSTRAP_ADMIN_NAME_FILE',
  'BOOTSTRAP_ADMIN_PASSWORD',
  'BOOTSTRAP_ADMIN_PASSWORD_FILE',
  'SMTP_USER',
  'SMTP_USER_FILE',
  'SMTP_PASSWORD',
  'SMTP_PASSWORD_FILE',
  'STRIPE_SECRET_KEY',
  'STRIPE_SECRET_KEY_FILE',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_WEBHOOK_SECRET_FILE'
]);

export function withoutTestProcessSecrets(
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) => {
        const normalizedName = name.toUpperCase();
        return value !== undefined &&
          !testProcessCredentialNames.has(normalizedName) &&
          !normalizedName.endsWith('_FILE') &&
          !/^PG[A-Z0-9_]*$/u.test(normalizedName);
      }
    )
  );
}

export const withoutStripeProviderSecrets = withoutTestProcessSecrets;

const isolatedTestProject = /^pale-orbit-test-[0-9a-f]{16}$/u;
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);

export function assertIsolatedTestDatabaseEnvironment(
  environment: NodeJS.ProcessEnv
): void {
  const port = Number(environment.DATABASE_PORT);
  const isolated =
    environment.APP_ENV === 'test' &&
    isolatedTestProject.test(environment.PALE_ORBIT_TEST_PROJECT ?? '') &&
    loopbackHosts.has(environment.DATABASE_HOST ?? '') &&
    Number.isInteger(port) && port >= 1024 && port <= 65_535 && port !== 5432 &&
    environment.DATABASE_NAME === 'pale_orbit_test' &&
    environment.DATABASE_OWNER_USER === 'pale_orbit_test' &&
    environment.DATABASE_USER === 'pale_orbit_test_web' &&
    environment.DATABASE_WORKER_USER === 'pale_orbit_test_worker' &&
    environment.DATABASE_STORAGE_CLEANUP_USER === 'pale_orbit_test_storage_cleanup';
  if (!isolated) throw new Error('Refusing to use a non-isolated test database');
}
