import { runStorageVolumeBackupFromEnvironment } from './storage-volume-backup-helper';

try {
  await runStorageVolumeBackupFromEnvironment(process.env);
} catch (cause: unknown) {
  console.error('[storage-volume-backup] failed', {
    name: cause instanceof Error ? cause.name : 'UnknownError'
  });
  process.exitCode = 1;
}
