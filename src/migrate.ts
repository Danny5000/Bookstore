import { loadDatabaseConfig } from '$lib/server/config/load';
import { createDatabaseClient } from '$lib/server/db/client';
import { databaseEnvironmentForRole } from '$lib/server/db/database-role-provision';
import { migrateDatabase } from '$lib/server/db/migrate';

const database = loadDatabaseConfig(databaseEnvironmentForRole(process.env, 'owner'));
const databaseClient = createDatabaseClient(database);

try {
  await migrateDatabase(databaseClient.db);
  console.info('[migration] database is current');
} finally {
  await databaseClient.close();
}
