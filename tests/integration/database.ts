import { loadApplicationConfig, loadDatabaseConfig } from '$lib/server/config/load';
import { createDatabaseClient } from '$lib/server/db/client';
import { databaseEnvironmentForRole } from '$lib/server/db/database-role-provision';
import { assertIsolatedTestDatabaseEnvironment } from '../../scripts/test-environment';

assertIsolatedTestDatabaseEnvironment(process.env);

export const applicationConfig = loadApplicationConfig(process.env);
export const databaseClient = createDatabaseClient(applicationConfig.database);
export const ownerDatabaseClient = createDatabaseClient(
  loadApplicationConfig(databaseEnvironmentForRole(process.env, 'owner')).database
);
export const workerDatabaseClient = createDatabaseClient(
  loadApplicationConfig(databaseEnvironmentForRole(process.env, 'worker')).database
);
export const storageCleanupDatabaseClient = createDatabaseClient(
  loadDatabaseConfig(databaseEnvironmentForRole(process.env, 'storage-cleanup'))
);
