import { runStorageVolumeMigrationFromEnvironment } from './storage-volume-migration-helper';

try {
  await runStorageVolumeMigrationFromEnvironment(process.env);
} catch (cause: unknown) {
  console.error('[storage-volume-migration] failed', {
    name: cause instanceof Error ? cause.name : 'UnknownError'
  });
  process.exitCode = 1;
}
