import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEPLOYMENT_BACKUP_ARTIFACTS,
  hashDeploymentBackupArtifact,
  publishDeploymentBackupManifestNoClobber,
  sealDeploymentBackupBundle,
  verifyDeploymentBackupBundle
} from './deployment-backup-bundle';

async function writeArtifacts(root: string): Promise<void> {
  for (const name of DEPLOYMENT_BACKUP_ARTIFACTS) {
    await writeFile(join(root, name), `artifact:${name}`);
  }
}

describe('atomic deployment backup bundle', () => {
  const backupId = '0123456789abcdef0123456789abcdef';
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pale-orbit-backup-bundle-'));
    await writeArtifacts(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('seals database plus all three archives and inventories in one exclusive final manifest', async () => {
    const manifest = await sealDeploymentBackupBundle(root, backupId);

    expect(Object.keys(manifest.artifacts).sort()).toEqual([...DEPLOYMENT_BACKUP_ARTIFACTS].sort());
    expect(await verifyDeploymentBackupBundle(root, backupId)).toEqual(manifest);
    expect((await readdir(root)).sort()).toEqual([
      ...DEPLOYMENT_BACKUP_ARTIFACTS,
      'backup-bundle.json'
    ].sort());
    expect(JSON.parse(await readFile(join(root, 'backup-bundle.json'), 'utf8'))).toEqual(manifest);
  });

  it('authenticates the current calibrated catalog-v3 verifier exactly once', async () => {
    const verifier = await readFile('scripts/verify-financial-restore.sql', 'utf8');
    await writeFile(join(root, 'verify-financial-restore.sql'), verifier);
    const expectedEvidence = await hashDeploymentBackupArtifact(
      root,
      'verify-financial-restore.sql'
    );

    const manifest = await sealDeploymentBackupBundle(root, backupId);

    expect(DEPLOYMENT_BACKUP_ARTIFACTS.filter((name) =>
      name === 'verify-financial-restore.sql'
    )).toHaveLength(1);
    expect(manifest.artifacts['verify-financial-restore.sql']).toEqual(expectedEvidence);
    expect(await readFile(join(root, 'verify-financial-restore.sql'), 'utf8')).toBe(verifier);
    expect(verifier.match(/plan6b-financial-catalog-v\d+/gu)).toEqual([
      'plan6b-financial-catalog-v3'
    ]);
    expect(verifier).not.toContain('plan6b-financial-catalog-v1');
    expect(/'0{64}'/u.test(verifier)).toBe(false);
    expect(verifier.includes('$catalog${}$catalog$')).toBe(false);
  });

  it('does not publish a bundle manifest when any authoritative artifact is absent', async () => {
    await rm(join(root, 'publication.tar.gz'));

    await expect(sealDeploymentBackupBundle(root, backupId))
      .rejects.toThrow(/inventory mismatch/);
    await expect(readdir(root)).resolves.not.toContain('backup-bundle.json');
  });

  it('rejects any tampered member before restore readiness can consume the bundle', async () => {
    await sealDeploymentBackupBundle(root, backupId);
    await writeFile(join(root, 'database.dump'), 'tampered');

    await expect(verifyDeploymentBackupBundle(root, backupId))
      .rejects.toThrow(/digest or byte mismatch/);
  });

  it('rejects a valid bundle selected under the wrong expected backup ID', async () => {
    await sealDeploymentBackupBundle(root, backupId);

    await expect(verifyDeploymentBackupBundle(root, 'fedcba9876543210fedcba9876543210'))
      .rejects.toThrow(/backup ID mismatch/iu);
  });

  it('rejects scratch, health, partial, and other unmanifested entries', async () => {
    await writeFile(join(root, 'scratch.tar.gz'), 'not-authoritative');
    await expect(sealDeploymentBackupBundle(root, backupId))
      .rejects.toThrow(/inventory mismatch/);
  });

  it('rejects a configured root that traverses an intermediate symbolic link', async () => {
    const actualParent = join(root, 'actual');
    const actualBundle = join(actualParent, 'bundle');
    const aliasParent = join(root, 'alias');
    await mkdir(actualBundle, { recursive: true });
    await writeArtifacts(actualBundle);
    await symlink(actualParent, aliasParent, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(sealDeploymentBackupBundle(join(aliasParent, 'bundle'), backupId))
      .rejects.toThrow(/symbolic links/iu);
  });

  it('rejects a same-size artifact mutation while hashing', async () => {
    const artifactPath = join(root, 'database.dump');
    const artifactBytes = 32 * 1024 * 1024;
    await writeFile(artifactPath, Buffer.alloc(artifactBytes));
    const handle = await open(artifactPath, 'r+');
    try {
      const hashing = hashDeploymentBackupArtifact(root, 'database.dump');
      const mutation = (async () => {
        for (let index = 0; index < 512; index += 1) {
          const value = Buffer.from([index % 251]);
          await handle.write(value, 0, value.byteLength, (index * 65_537) % artifactBytes);
          await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
        }
      })();
      const [hashResult] = await Promise.allSettled([hashing, mutation]);
      expect(hashResult.status).toBe('rejected');
      if (hashResult.status === 'rejected') {
        expect(hashResult.reason).toBeInstanceOf(Error);
        expect((hashResult.reason as Error).message).toMatch(/changed while hashing/iu);
      }
    } finally {
      await handle.close();
    }
  });

  it('atomically refuses to clobber a manifest published by a competing process', async () => {
    const partial = join(root, '.backup-bundle-race.partial');
    const target = join(root, 'backup-bundle.json');
    await writeFile(partial, 'ours');
    await writeFile(target, 'competitor');

    await expect(publishDeploymentBackupManifestNoClobber(partial, target))
      .rejects.toMatchObject({ code: 'EEXIST' });
    await expect(readFile(target, 'utf8')).resolves.toBe('competitor');
  });
});
