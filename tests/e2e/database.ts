import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "$lib/server/db/schema";
import { setPreservedGrantState } from "$lib/server/commerce/grants";
import type { Database } from "$lib/server/db/client";
import { databaseEnvironmentForRole } from "$lib/server/db/database-role-provision";
import { assertIsolatedTestDatabaseEnvironment } from "../../scripts/test-environment";

export interface E2EDatabase {
  readonly db: Database;
  readonly workerDb: Database;
  /** Owner authority for explicit E2E fixture setup and corruption only. */
  readonly ownerFixtureDb: Database;
  /** Raw owner authority for parameterized E2E fixture SQL and test-held locks only. */
  readonly ownerFixtureClient: Client;
  grantEntitlement(email: string, titleId: string): Promise<void>;
  revokeEntitlement(email: string, titleId: string): Promise<void>;
  close(): Promise<void>;
}

const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);

function configuredClient(source: NodeJS.ProcessEnv): Client {
  const host = source.DATABASE_HOST ?? "127.0.0.1";
  const database = source.DATABASE_NAME ?? "pale_orbit_test";
  if (!loopbackHosts.has(host) || !/(?:^|_)test(?:$|_)/u.test(database)) {
    throw new Error(
      `E2E database helpers refuse host=${host} database=${database}; expected a loopback test database`,
    );
  }
  return new Client({
    host,
    port: Number(source.DATABASE_PORT ?? "5432"),
    database,
    user: source.DATABASE_USER ?? "pale_orbit_test",
    password: source.DATABASE_PASSWORD ?? "pale_orbit_test_only",
  });
}

async function closeClients(
  clients: readonly Client[],
  message: string,
): Promise<void> {
  const results = await Promise.allSettled(
    clients.map((client) => Promise.resolve().then(() => client.end())),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) throw new AggregateError(failures, message);
}

async function rollbackConnections(
  connectedClients: readonly Client[],
  connectionError: unknown,
): Promise<never> {
  try {
    await closeClients(
      [...connectedClients].reverse(),
      "E2E database connection rollback failed",
    );
  } catch (rollbackError) {
    const failures =
      rollbackError instanceof AggregateError
        ? [connectionError, ...rollbackError.errors]
        : [connectionError, rollbackError];
    throw new AggregateError(
      failures,
      "E2E database connection and rollback failed",
      { cause: rollbackError },
    );
  }
  throw connectionError;
}

export async function openE2EDatabase(): Promise<E2EDatabase> {
  assertIsolatedTestDatabaseEnvironment(process.env);
  const client = configuredClient(process.env);
  const workerClient = configuredClient(
    databaseEnvironmentForRole(process.env, "worker"),
  );
  const ownerFixtureClient = configuredClient(
    databaseEnvironmentForRole(process.env, "owner"),
  );
  const attemptedClients: Client[] = [];
  try {
    attemptedClients.push(client);
    await client.connect();
    attemptedClients.push(workerClient);
    await workerClient.connect();
    attemptedClients.push(ownerFixtureClient);
    await ownerFixtureClient.connect();
  } catch (error) {
    return rollbackConnections(attemptedClients, error);
  }
  const database = drizzle({ client, schema });
  const workerDatabase = drizzle({ client: workerClient, schema });
  const ownerFixtureDatabase = drizzle({ client: ownerFixtureClient, schema });

  async function userId(email: string): Promise<string> {
    const result = await client.query<{ id: string }>(
      'select id from "user" where lower(email) = lower($1) and email_verified = true',
      [email.trim()],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("No verified E2E user exists");
    return id;
  }

  return {
    db: database,
    workerDb: workerDatabase,
    ownerFixtureDb: ownerFixtureDatabase,
    ownerFixtureClient,
    async grantEntitlement(email, titleId) {
      const id = await userId(email);
      await workerDatabase.transaction((transaction) =>
        setPreservedGrantState(transaction, {
          userId: id,
          titleId,
          active: true,
          stateReason: "e2e_preserved_access",
        }),
      );
    },
    async revokeEntitlement(email, titleId) {
      const id = await userId(email);
      await workerDatabase.transaction((transaction) =>
        setPreservedGrantState(transaction, {
          userId: id,
          titleId,
          active: false,
          stateReason: "e2e_preserved_revoked",
        }),
      );
    },
    async close() {
      await closeClients(
        [ownerFixtureClient, workerClient, client],
        "E2E database cleanup failed",
      );
    },
  };
}
