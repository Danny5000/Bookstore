import { resolve } from 'node:path';
import {
  sealDeploymentBackupBundle,
  verifyDeploymentBackupBundle
} from './deployment-backup-bundle';

const [mode] = process.argv.slice(2);
const root = process.env.DEPLOYMENT_BACKUP_ROOT;
if (!root) throw new Error('DEPLOYMENT_BACKUP_ROOT is required');
const backupId = process.env.DEPLOYMENT_BACKUP_ID ?? '';

const result = mode === 'seal'
  ? sealDeploymentBackupBundle(root, backupId)
  : mode === 'verify'
    ? verifyDeploymentBackupBundle(root, backupId)
    : Promise.reject(new Error('Usage: backup:bundle -- seal|verify'));

result.then((manifest) => {
  console.info(JSON.stringify({
    version: manifest.version,
    backupId: manifest.backupId,
    root: resolve(root),
    verifiedArtifacts: Object.keys(manifest.artifacts).length
  }));
}).catch((cause: unknown) => {
  console.error('[deployment-backup-bundle] failed', {
    name: cause instanceof Error ? cause.name : 'UnknownError'
  });
  process.exitCode = 1;
});
