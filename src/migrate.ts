import { loadDatabaseConfig } from '$lib/server/config/load';
import { createDatabaseClient } from '$lib/server/db/client';
import {
  databaseEnvironmentForRole,
  loadDatabaseMigrationIdentityConfig
} from '$lib/server/db/database-role-provision';
import { migrateDatabase } from '$lib/server/db/migrate';

if (process.env.PGOPTIONS !== undefined && process.env.PGOPTIONS.length > 0) {
  throw new Error('[migration] PGOPTIONS must be unset');
}
const migrationIdentities = loadDatabaseMigrationIdentityConfig(process.env);
const database = loadDatabaseConfig(databaseEnvironmentForRole(process.env, 'owner'));
const databaseClient = createDatabaseClient(database);

try {
  await migrateDatabase(databaseClient.db, migrationIdentities);
  console.info('[migration] database is current');
} finally {
  await databaseClient.close();
}
