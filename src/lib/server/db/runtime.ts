import { getApplicationConfig } from '$lib/server/config';
import { createDatabaseClient, type DatabaseClient } from './client';

let databaseClient: DatabaseClient | undefined;

export function getDatabaseClient(): DatabaseClient {
  databaseClient ??= createDatabaseClient(getApplicationConfig().database);
  return databaseClient;
}
