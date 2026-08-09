import { loadStorageMaintenanceConfig, parseStorageCleanupArguments } from '$lib/server/config/storage-maintenance';
import { createDatabaseClient, type DatabaseClient } from '$lib/server/db/client';
import { probeDatabase } from '$lib/server/db/health';
import { cleanupStorage } from '$lib/server/storage/cleanup';
import { createObjectStorage } from '$lib/server/storage/factory';
import { probeStorage } from '$lib/server/storage/health';

let databaseClient: DatabaseClient | undefined;

try {
  const mode = parseStorageCleanupArguments(process.argv.slice(2));
  const config = loadStorageMaintenanceConfig(process.env);
  databaseClient = createDatabaseClient(config.database);
  const storage = createObjectStorage(config.storage);
  await probeDatabase(databaseClient.pool, config.database.readinessTimeoutMs);
  await probeStorage(storage);
  const summary = await cleanupStorage({
    database: databaseClient.db,
    storage,
    config: config.storage,
    mode,
    log: () => undefined
  });
  console.info(JSON.stringify(summary));
} catch (cause: unknown) {
  console.error('[storage-cleanup] failed', {
    name: cause instanceof Error ? cause.name : 'UnknownError'
  });
  process.exitCode = 1;
} finally {
  await databaseClient?.close();
}
