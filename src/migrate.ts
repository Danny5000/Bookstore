import { loadApplicationConfig } from '$lib/server/config/load';
import { createDatabaseClient } from '$lib/server/db/client';
import { migrateDatabase } from '$lib/server/db/migrate';

const config = loadApplicationConfig(process.env);
const databaseClient = createDatabaseClient(config.database);

try {
  await migrateDatabase(databaseClient.db);
  console.info('[migration] database is current');
} finally {
  await databaseClient.close();
}
