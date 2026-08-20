import { Client } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '$lib/server/db/schema';
import { setPreservedGrantState } from '$lib/server/commerce/grants';
import type { Database } from '$lib/server/db/client';
import { databaseEnvironmentForRole } from '$lib/server/db/database-role-provision';
import { assertIsolatedTestDatabaseEnvironment } from '../../scripts/test-environment';

export interface E2EDatabase {
  readonly db: Database;
  readonly workerDb: Database;
  grantEntitlement(email: string, titleId: string): Promise<void>;
  revokeEntitlement(email: string, titleId: string): Promise<void>;
  close(): Promise<void>;
}

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);

function configuredClient(source: NodeJS.ProcessEnv): Client {
  const host = source.DATABASE_HOST ?? '127.0.0.1';
  const database = source.DATABASE_NAME ?? 'pale_orbit_test';
  if (!loopbackHosts.has(host) || !/(?:^|_)test(?:$|_)/u.test(database)) {
    throw new Error(
      `E2E database helpers refuse host=${host} database=${database}; expected a loopback test database`
    );
  }
  return new Client({
    host,
    port: Number(source.DATABASE_PORT ?? '5432'),
    database,
    user: source.DATABASE_USER ?? 'pale_orbit_test',
    password: source.DATABASE_PASSWORD ?? 'pale_orbit_test_only'
  });
}

export async function openE2EDatabase(): Promise<E2EDatabase> {
  assertIsolatedTestDatabaseEnvironment(process.env);
  const client = configuredClient(process.env);
  const workerClient = configuredClient(databaseEnvironmentForRole(process.env, 'worker'));
  await client.connect();
  try {
    await workerClient.connect();
  } catch (error) {
    await client.end();
    throw error;
  }
  const database = drizzle({ client, schema });
  const workerDatabase = drizzle({ client: workerClient, schema });

  async function userId(email: string): Promise<string> {
    const result = await client.query<{ id: string }>(
      'select id from "user" where lower(email) = lower($1) and email_verified = true',
      [email.trim()]
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error(`No verified E2E user exists for ${email}`);
    return id;
  }

  return {
    db: database,
    workerDb: workerDatabase,
    async grantEntitlement(email, titleId) {
      const id = await userId(email);
      await workerDatabase.transaction((transaction) =>
        setPreservedGrantState(transaction, {
          userId: id,
          titleId,
          active: true,
          stateReason: 'e2e_preserved_access'
        })
      );
    },
    async revokeEntitlement(email, titleId) {
      const id = await userId(email);
      await workerDatabase.transaction((transaction) =>
        setPreservedGrantState(transaction, {
          userId: id,
          titleId,
          active: false,
          stateReason: 'e2e_preserved_revoked'
        })
      );
    },
    async close() {
      await Promise.all([client.end(), workerClient.end()]);
    }
  };
}
