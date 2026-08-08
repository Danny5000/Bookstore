import { loadApplicationConfig } from '$lib/server/config/load';
import { createDatabaseClient } from '$lib/server/db/client';

export const applicationConfig = loadApplicationConfig(process.env);
export const databaseClient = createDatabaseClient(applicationConfig.database);
