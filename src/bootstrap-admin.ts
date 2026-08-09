import { randomUUID } from 'node:crypto';
import {
  UnverifiedBootstrapAccountError,
  bootstrapFirstAdministrator
} from '$lib/server/auth/bootstrap-admin';
import { loadBootstrapAdminConfig } from '$lib/server/auth/bootstrap-config';
import { loadApplicationConfig } from '$lib/server/config/load';
import { ConfigurationError } from '$lib/server/config/read-setting';
import { createDatabaseClient, type DatabaseClient } from '$lib/server/db/client';

let databaseClient: DatabaseClient | undefined;

try {
  const config = loadApplicationConfig(process.env);
  const bootstrapConfig = loadBootstrapAdminConfig(process.env);
  databaseClient = createDatabaseClient(config.database);
  const result = await bootstrapFirstAdministrator({
    database: databaseClient.db,
    ...bootstrapConfig,
    correlationId: randomUUID()
  });
  console.info('[bootstrap-admin] complete', result);
} catch (error: unknown) {
  const safe = error instanceof ConfigurationError || error instanceof UnverifiedBootstrapAccountError;
  console.error('[bootstrap-admin] failed', {
    name: error instanceof Error ? error.name : 'UnknownError',
    message: safe && error instanceof Error ? error.message : 'Administrator bootstrap failed'
  });
  process.exitCode = 1;
} finally {
  await databaseClient?.close();
}
