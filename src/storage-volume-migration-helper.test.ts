import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyLegacyStoragePath,
  migrateLegacyStorage,
  runStorageVolumeMigrationFromEnvironment,
  StorageVolumeMigrationError
} from './storage-volume-migration-helper';

const title = '018f0000-0000-7000-8000-000000000010';
const revision = '018f0000-0000-7000-8000-000000000011';
const objectOne = '018f0000-0000-7000-8000-000000000001';
const objectTwo = '018f0000-0000-7000-8000-000000000002';

describe('storage volume migration helper', () => {
  let parent: string;
  let legacyRoot: string;
  let stagingRoot: string;
  let publicationRoot: string;
  let coversRoot: string;

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'pale-orbit-storage-migration-'));
    legacyRoot = join(parent, 'legacy');
    stagingRoot = join(parent, 'staging');
    publicationRoot = join(parent, 'publication');
    coversRoot = join(parent, 'covers');
    await Promise.all([legacyRoot, stagingRoot, publicationRoot, coversRoot].map((root) =>
      mkdir(root, { recursive: true })
    ));
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  async function legacyFile(key: string, contents: string | Buffer): Promise<void> {
    const target = join(legacyRoot, ...key.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }

  it('classifies only the exact authoritative and explicitly non-authoritative key grammars', () => {
    expect(classifyLegacyStoragePath(`staging/uploads/${objectOne}`, 'file')).toBe('staging');
    expect(classifyLegacyStoragePath(
      `titles/${title}/revisions/${revision}/original`,
      'file'
    )).toBe('publication');
    expect(classifyLegacyStoragePath(
      `titles/${title}/revisions/${revision}/derived/v1/prose-images/${objectOne}.webp`,
      'file'
    )).toBe('publication');
    expect(classifyLegacyStoragePath(
      `titles/${title}/revisions/${revision}/derived/v1/generations/9/comic-pages/${objectTwo}.webp`,
      'file'
    )).toBe('publication');
    expect(classifyLegacyStoragePath(`titles/${title}/covers/${objectTwo}.webp`, 'file'))
      .toBe('covers');
    expect(classifyLegacyStoragePath(`health/probes/${objectOne}`, 'file')).toBe('health');
    expect(classifyLegacyStoragePath('health/publication/readiness-v1', 'file'))
      .toBe('publication');
    expect(classifyLegacyStoragePath(`.verified-downloads/${objectOne}`, 'file')).toBe('scratch');
    expect(() => classifyLegacyStoragePath(`titles/${title}/other/file`, 'file'))
      .toThrow(StorageVolumeMigrationError);
    expect(() => classifyLegacyStoragePath(`staging/uploads/${objectOne}/extra`, 'file'))
      .toThrow(StorageVolumeMigrationError);
    expect(() => classifyLegacyStoragePath(
      `titles/${title}/revisions/${revision}/derived/v1/generations/09/comic-pages/${objectTwo}.webp`,
      'file'
    )).toThrow(StorageVolumeMigrationError);
    expect(() => classifyLegacyStoragePath(
      `titles/${title}/revisions/${revision}/derived/v1/generations/2147483648/comic-pages/${objectTwo}.webp`,
      'file'
    )).toThrow(StorageVolumeMigrationError);
  });

  it('runs the import-safe environment API and emits exact verify-empty evidence', async () => {
    const output: string[] = [];
    const result = await runStorageVolumeMigrationFromEnvironment({
      STORAGE_MIGRATION_MODE: 'verify-empty',
      STORAGE_MIGRATION_LEGACY_ROOT: legacyRoot,
      STORAGE_MIGRATION_STAGING_ROOT: stagingRoot,
      STORAGE_MIGRATION_PUBLICATION_ROOT: publicationRoot,
      STORAGE_MIGRATION_COVERS_ROOT: coversRoot
    }, (value) => output.push(value));

    expect(result).toEqual({ version: 1, empty: true });
    expect(output).toEqual(['{"version":1,"empty":true}']);
  });

  it('builds the executable helper from a dedicated explicit entry module', async () => {
    const vite = await readFile(join(process.cwd(), 'vite.services.config.ts'), 'utf8');
    expect(vite).toMatch(
      /'storage-volume-migration-helper': resolve\([\s\S]*?'src\/storage-volume-migration-entry\.ts'/u
    );
    const entry = await readFile(
      join(process.cwd(), 'src/storage-volume-migration-entry.ts'),
      'utf8'
    );
    expect(entry).toContain('await runStorageVolumeMigrationFromEnvironment(process.env)');
  });

  it('copies each authoritative class under its full logical key and proves count, bytes, and SHA256 equality', async () => {
    const keys = {
      staging: `staging/uploads/${objectOne}`,
      publication: `titles/${title}/revisions/${revision}/original`,
      covers: `titles/${title}/covers/${objectTwo}.webp`
    } as const;
    await legacyFile(keys.staging, 'upload');
    await legacyFile(keys.publication, '');
    await legacyFile(keys.covers, 'cover');
    await legacyFile(`health/probes/${objectOne}`, 'probe');
    await legacyFile(`.verified-downloads/${objectTwo}`, 'snapshot');

    const manifest = await migrateLegacyStorage({
      legacyRoot,
      stagingRoot,
      publicationRoot,
      coversRoot
    });

    expect(manifest.version).toBe(1);
    expect(manifest.classes.staging).toMatchObject({ count: 1, bytes: 6, verified: true });
    expect(manifest.classes.publication).toMatchObject({ count: 1, bytes: 0, verified: true });
    expect(manifest.classes.covers).toMatchObject({ count: 1, bytes: 5, verified: true });
    for (const storageClass of ['staging', 'publication', 'covers'] as const) {
      const entry = manifest.classes[storageClass];
      expect(entry.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(entry.destinationSha256).toBe(entry.sourceSha256);
      const root = { staging: stagingRoot, publication: publicationRoot, covers: coversRoot }[
        storageClass
      ];
      await expect(readFile(join(root, ...keys[storageClass].split('/')), 'utf8')).resolves.toBe(
        { staging: 'upload', publication: '', covers: 'cover' }[storageClass]
      );
    }
    expect(manifest.ignored).toEqual({
      health: { count: 1, bytes: 5 },
      scratch: { count: 1, bytes: 8 }
    });
    await expect(readFile(join(legacyRoot, ...keys.staging.split('/')), 'utf8')).resolves.toBe(
      'upload'
    );
  });

  it('rejects unknown legacy entries and removes every destination created by the failed run', async () => {
    await legacyFile(`staging/uploads/${objectOne}`, 'upload');
    await legacyFile('unknown.bin', 'foreign');

    await expect(migrateLegacyStorage({
      legacyRoot,
      stagingRoot,
      publicationRoot,
      coversRoot
    })).rejects.toThrow(StorageVolumeMigrationError);
    await expect(readdir(stagingRoot, { recursive: true })).resolves.toEqual([]);
    await expect(readdir(publicationRoot, { recursive: true })).resolves.toEqual([]);
    await expect(readdir(coversRoot, { recursive: true })).resolves.toEqual([]);
    await expect(readFile(join(legacyRoot, 'unknown.bin'), 'utf8')).resolves.toBe('foreign');
  });

  it('rejects nonempty destinations and symbolic links before copying', async () => {
    await legacyFile(`staging/uploads/${objectOne}`, 'upload');
    await writeFile(join(coversRoot, 'preexisting'), 'do-not-touch');
    await expect(migrateLegacyStorage({
      legacyRoot,
      stagingRoot,
      publicationRoot,
      coversRoot
    })).rejects.toThrow(/empty/);
    await expect(readFile(join(coversRoot, 'preexisting'), 'utf8')).resolves.toBe('do-not-touch');

    await rm(join(coversRoot, 'preexisting'));
    await symlink(join(legacyRoot, 'staging'), join(legacyRoot, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir');
    await expect(migrateLegacyStorage({
      legacyRoot,
      stagingRoot,
      publicationRoot,
      coversRoot
    })).rejects.toThrow(/symbolic links/);
  });
});
