import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureStorageVolume,
  readStorageArchiveManifest,
  restoreStorageVolume,
  runStorageVolumeBackupFromEnvironment,
  verifyStorageRestoreInput,
  type StorageArchiveClass
} from './storage-volume-backup-helper';

const titleId = '11111111-1111-4111-8111-111111111111';
const revisionId = '22222222-2222-4222-8222-222222222222';
const objectId = '33333333-3333-4333-8333-333333333333';
const healthId = '44444444-4444-4444-8444-444444444444';
const publicationSentinelKey = 'health/publication/readiness-v1';
const publicationSentinelValue = 'pale-orbit-publication-ready-v1';

const keys: Record<StorageArchiveClass, readonly [string, string]> = {
  staging: [
    `staging/uploads/${objectId}`,
    `health/probes/${healthId}`
  ],
  publication: [
    `titles/${titleId}/revisions/${revisionId}/original`,
    `titles/${titleId}/revisions/${revisionId}/derived/v1/generations/4/prose-images/${objectId}.webp`
  ],
  covers: [
    `titles/${titleId}/covers/${objectId}.webp`,
    `titles/${titleId}/covers/55555555-5555-4555-8555-555555555555.webp`
  ]
};

async function put(root: string, key: string, contents: string | Buffer): Promise<void> {
  const target = join(root, ...key.split('/'));
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, contents);
}

describe('current split-volume archive helper', () => {
  const temporaryRoots: string[] = [];

  async function temporaryRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    temporaryRoots.push(root);
    return root;
  }

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
      recursive: true,
      force: true
    })));
  });

  it('runs the import-safe environment API and emits exact capture evidence', async () => {
    const source = await temporaryRoot('pale-orbit-entry-source-');
    const output = await temporaryRoot('pale-orbit-entry-output-');
    await put(source, keys.covers[0], 'cover');
    const lines: string[] = [];

    const result = await runStorageVolumeBackupFromEnvironment({
      STORAGE_ARCHIVE_MODE: 'capture',
      STORAGE_ARCHIVE_CLASS: 'covers',
      STORAGE_ARCHIVE_VOLUME_ROOT: source,
      STORAGE_ARCHIVE_BUNDLE_ROOT: output
    }, (value) => lines.push(value));

    expect(result).toMatchObject({ version: 1, storageClass: 'covers', count: 1, bytes: 5 });
    expect(JSON.parse(lines[0]!)).toMatchObject({
      version: 1,
      storageClass: 'covers',
      count: 1,
      bytes: 5
    });
  });

  it('builds the executable helper from a dedicated explicit entry module', async () => {
    const vite = await readFile(join(process.cwd(), 'vite.services.config.ts'), 'utf8');
    expect(vite).toMatch(
      /'storage-volume-backup-helper': resolve\([\s\S]*?'src\/storage-volume-backup-entry\.ts'/u
    );
    const entry = await readFile(
      join(process.cwd(), 'src/storage-volume-backup-entry.ts'),
      'utf8'
    );
    expect(entry).toContain('await runStorageVolumeBackupFromEnvironment(process.env)');
  });

  it('requires the exact fixed sentinel in every publication capture', async () => {
    const source = await temporaryRoot('pale-orbit-publication-sentinel-source-');
    const output = await temporaryRoot('pale-orbit-publication-sentinel-output-');
    await put(source, keys.publication[0], 'publication');

    await expect(captureStorageVolume({
      storageClass: 'publication',
      sourceRoot: source,
      outputRoot: output
    })).rejects.toThrow(/sentinel/iu);

    await put(source, publicationSentinelKey, 'wrong');
    await expect(captureStorageVolume({
      storageClass: 'publication',
      sourceRoot: source,
      outputRoot: output
    })).rejects.toThrow(/sentinel/iu);
  });

  it('rejects an internally coherent publication manifest that omits the sentinel', async () => {
    const source = await temporaryRoot('pale-orbit-publication-manifest-source-');
    const output = await temporaryRoot('pale-orbit-publication-manifest-output-');
    const destination = await temporaryRoot('pale-orbit-publication-manifest-restore-');
    await put(source, keys.publication[0], 'publication');
    await put(source, publicationSentinelKey, publicationSentinelValue);
    await captureStorageVolume({
      storageClass: 'publication',
      sourceRoot: source,
      outputRoot: output
    });
    const manifestPath = join(output, 'publication.manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      count: number;
      bytes: number;
      sha256: string;
      entries: Array<{ key: string; bytes: number; sha256: string }>;
    };
    manifest.entries = manifest.entries.filter(({ key }) => key !== publicationSentinelKey);
    manifest.count = manifest.entries.length;
    manifest.bytes = manifest.entries.reduce((total, entry) => total + entry.bytes, 0);
    const digest = createHash('sha256');
    for (const entry of manifest.entries) {
      digest.update(`${entry.sha256} ${entry.bytes} ${entry.key}\n`);
    }
    manifest.sha256 = digest.digest('hex');
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(verifyStorageRestoreInput({
      storageClass: 'publication',
      destinationRoot: destination,
      inputRoot: output
    })).rejects.toThrow(/sentinel/iu);
  });

  it('captures deterministic full-key archives and restores exact per-object equality', async () => {
    for (const storageClass of ['staging', 'publication', 'covers'] as const) {
      const source = await temporaryRoot(`pale-orbit-${storageClass}-source-`);
      const outputA = await temporaryRoot(`pale-orbit-${storageClass}-backup-a-`);
      const outputB = await temporaryRoot(`pale-orbit-${storageClass}-backup-b-`);
      const destination = await temporaryRoot(`pale-orbit-${storageClass}-restore-`);
      await put(source, keys[storageClass][0], 'alpha');
      await put(source, keys[storageClass][1], storageClass === 'staging' ? 'health' : 'beta');
      if (storageClass === 'publication') {
        await put(source, publicationSentinelKey, publicationSentinelValue);
      }

      const first = await captureStorageVolume({ storageClass, sourceRoot: source, outputRoot: outputA });
      const second = await captureStorageVolume({ storageClass, sourceRoot: source, outputRoot: outputB });

      expect(first).toEqual(second);
      expect(first.entries.map(({ key }) => key)).toEqual(
        storageClass === 'staging'
          ? [keys.staging[0]]
          : storageClass === 'publication'
            ? [...keys.publication, publicationSentinelKey].sort()
            : [...keys.covers].sort()
      );
      expect(first.ignored.health).toEqual(
        storageClass === 'staging' ? { count: 1, bytes: 6 } : { count: 0, bytes: 0 }
      );
      await expect(readFile(join(outputA, `${storageClass}.tar.gz`)))
        .resolves.toEqual(await readFile(join(outputB, `${storageClass}.tar.gz`)));

      await expect(verifyStorageRestoreInput({
        storageClass,
        destinationRoot: destination,
        inputRoot: outputA
      })).resolves.toEqual(first);
      await expect(readdir(destination)).resolves.toEqual([]);

      const restored = await restoreStorageVolume({
        storageClass,
        destinationRoot: destination,
        inputRoot: outputA
      });
      expect(restored).toEqual(first);
      for (const entry of first.entries) {
        await expect(readFile(join(destination, ...entry.key.split('/'))))
          .resolves.toEqual(await readFile(join(source, ...entry.key.split('/'))));
      }
      if (storageClass === 'staging') {
        await expect(readFile(join(destination, ...keys.staging[1].split('/')))).rejects.toThrow();
      }
    }
  });

  it('preserves zero-byte objects as an intentional archive contract', async () => {
    const source = await temporaryRoot('pale-orbit-zero-source-');
    const output = await temporaryRoot('pale-orbit-zero-backup-');
    const destination = await temporaryRoot('pale-orbit-zero-restore-');
    await put(source, keys.covers[0], Buffer.alloc(0));

    const manifest = await captureStorageVolume({
      storageClass: 'covers',
      sourceRoot: source,
      outputRoot: output
    });
    expect(manifest.entries[0]).toMatchObject({ key: keys.covers[0], bytes: 0 });
    await restoreStorageVolume({
      storageClass: 'covers',
      destinationRoot: destination,
      inputRoot: output
    });
    await expect(readFile(join(destination, ...keys.covers[0].split('/')))
      .then((value) => value.byteLength)).resolves.toBe(0);
  });

  it('exposes the same strict manifest parser to checkpoint orchestration', async () => {
    const source = await temporaryRoot('pale-orbit-manifest-source-');
    const output = await temporaryRoot('pale-orbit-manifest-backup-');
    await put(source, keys.covers[0], 'cover');
    const captured = await captureStorageVolume({
      storageClass: 'covers', sourceRoot: source, outputRoot: output
    });

    await expect(readStorageArchiveManifest(output, 'covers')).resolves.toEqual(captured);
  });

  it('rejects unknown, misrouted, and symbolic-link entries without publishing an archive', async () => {
    const source = await temporaryRoot('pale-orbit-unsafe-source-');
    const output = await temporaryRoot('pale-orbit-unsafe-backup-');
    await put(source, 'unknown/private.bin', 'unsafe');
    await expect(captureStorageVolume({
      storageClass: 'publication',
      sourceRoot: source,
      outputRoot: output
    })).rejects.toThrow(/unknown|misrouted/iu);

    await rm(source, { recursive: true, force: true });
    await mkdir(source);
    await put(source, keys.covers[0], 'wrong root');
    await expect(captureStorageVolume({
      storageClass: 'publication',
      sourceRoot: source,
      outputRoot: output
    })).rejects.toThrow(/misrouted/iu);

    await rm(source, { recursive: true, force: true });
    await mkdir(source);
    const linkedSource = await temporaryRoot('pale-orbit-linked-source-');
    await put(linkedSource, keys.publication[0].replace(/^titles\//u, ''), 'source');
    await symlink(
      linkedSource,
      join(source, 'titles'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    await expect(captureStorageVolume({
      storageClass: 'publication',
      sourceRoot: source,
      outputRoot: output
    })).rejects.toThrow(/symbolic link/iu);
    await expect(readFile(join(output, 'publication.tar.gz'))).rejects.toThrow();
    await expect(readFile(join(output, 'publication.manifest.json'))).rejects.toThrow();
  });

  it('rejects noncanonical or out-of-range generation directories', async () => {
    for (const value of ['01', '2147483648']) {
      const source = await temporaryRoot(`pale-orbit-generation-${value}-`);
      const output = await temporaryRoot(`pale-orbit-generation-output-${value}-`);
      await put(
        source,
        `titles/${titleId}/revisions/${revisionId}/derived/v1/generations/${value}/prose-images/${objectId}.webp`,
        'unsafe'
      );
      await expect(captureStorageVolume({
        storageClass: 'publication',
        sourceRoot: source,
        outputRoot: output
      })).rejects.toThrow(/unknown|misrouted/iu);
    }
  });

  it('rejects tampered archives and clears only the initially empty restore destination', async () => {
    const source = await temporaryRoot('pale-orbit-tamper-source-');
    const output = await temporaryRoot('pale-orbit-tamper-backup-');
    const destination = await temporaryRoot('pale-orbit-tamper-restore-');
    await put(source, keys.publication[0], 'retained-original');
    await put(source, publicationSentinelKey, publicationSentinelValue);
    await captureStorageVolume({
      storageClass: 'publication',
      sourceRoot: source,
      outputRoot: output
    });
    const archivePath = join(output, 'publication.tar.gz');
    const archive = await readFile(archivePath);
    const corruptedByte = Math.floor(archive.byteLength / 2);
    archive[corruptedByte] = archive[corruptedByte]! ^ 0xff;
    await writeFile(archivePath, archive);

    await expect(restoreStorageVolume({
      storageClass: 'publication',
      destinationRoot: destination,
      inputRoot: output
    })).rejects.toThrow();
    await expect(readFile(join(source, ...keys.publication[0].split('/')), 'utf8'))
      .resolves.toBe('retained-original');
    await expect(readdir(destination)).resolves.toEqual([]);
  });

  it('refuses nonempty restore roots and pre-existing archive destinations unchanged', async () => {
    const source = await temporaryRoot('pale-orbit-collision-source-');
    const output = await temporaryRoot('pale-orbit-collision-backup-');
    const destination = await temporaryRoot('pale-orbit-collision-restore-');
    await put(source, keys.staging[0], 'upload');
    await writeFile(join(output, 'staging.tar.gz'), 'foreign archive');

    await expect(captureStorageVolume({
      storageClass: 'staging',
      sourceRoot: source,
      outputRoot: output
    })).rejects.toThrow(/exists|inventory/iu);
    await expect(readFile(join(output, 'staging.tar.gz'), 'utf8')).resolves.toBe('foreign archive');

    await put(destination, keys.staging[0], 'foreign destination');
    await expect(restoreStorageVolume({
      storageClass: 'staging',
      destinationRoot: destination,
      inputRoot: output
    })).rejects.toThrow(/empty/iu);
    await expect(readFile(join(destination, ...keys.staging[0].split('/')), 'utf8'))
      .resolves.toBe('foreign destination');
  });
});
