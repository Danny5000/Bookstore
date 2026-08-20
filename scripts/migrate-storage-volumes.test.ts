import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  executeStorageVolumeMigration,
  executeStorageVolumeMigrationWithReport,
  parseStorageMigrationArguments,
  StorageVolumeMigrationPreflightError,
  type StorageMigrationCommandRuntime
} from './migrate-storage-volumes';

const project = 'pale-orbit-production';
const helperImage = `registry.example/pale-orbit@sha256:${'a'.repeat(64)}`;
const volumeNames = [
  `${project}_book_storage`,
  `${project}_book_staging`,
  `${project}_book_publication`,
  `${project}_book_covers`
];

const verifiedManifest = JSON.stringify({
  version: 1,
  classes: Object.fromEntries(['staging', 'publication', 'covers'].map((name) => [name, {
    count: 1,
    bytes: 7,
    sourceSha256: 'b'.repeat(64),
    destinationSha256: 'b'.repeat(64),
    verified: true
  }])),
  ignored: {
    health: { count: 0, bytes: 0 },
    scratch: { count: 0, bytes: 0 }
  }
});

function successfulRuntime(overrides: {
  running?: string;
  volumeUsers?: string | Partial<Record<string, string>>;
  volumeProject?: string;
  migrationOutput?: string;
  volumeInventory?: string[];
  createdVolumeOutput?: string;
  helperUser?: string;
} = {}): { runtime: StorageMigrationCommandRuntime; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    runtime: {
      async capture(argumentsToRun) {
        const args = [...argumentsToRun];
        calls.push(args);
        if (args[0] === 'compose') {
          return { status: 0, stdout: overrides.running ?? '', stderr: '' };
        }
        if (args[0] === 'container' && args[1] === 'ls') {
          const filter = args[args.indexOf('--filter') + 1] ?? '';
          const exactName = filter.startsWith('volume=') ? filter.slice('volume='.length) : '';
          const stdout = typeof overrides.volumeUsers === 'string'
            ? overrides.volumeUsers
            : overrides.volumeUsers?.[exactName] ?? '';
          return { status: 0, stdout, stderr: '' };
        }
        if (args[0] === 'volume' && args[1] === 'ls') {
          return {
            status: 0,
            stdout: `${(overrides.volumeInventory ?? volumeNames).join('\n')}\n`,
            stderr: ''
          };
        }
        if (args[0] === 'volume' && args[1] === 'create') {
          return {
            status: 0,
            stdout: `${overrides.createdVolumeOutput ?? args.at(-1)}\n`,
            stderr: ''
          };
        }
        if (args[0] === 'volume' && args[1] === 'inspect') {
          const name = args[2]!;
          return {
            status: 0,
            stdout: JSON.stringify({
              Name: name,
              Labels: {
                'com.docker.compose.project': overrides.volumeProject ?? project,
                'com.docker.compose.volume': name.slice(`${project}_`.length)
              }
            }),
            stderr: ''
          };
        }
        if (args[0] === 'image' && args[1] === 'inspect') {
          return {
            status: 0,
            stdout: JSON.stringify({
              RepoDigests: [helperImage],
              Config: { User: overrides.helperUser ?? 'node' }
            }),
            stderr: ''
          };
        }
        if (args[0] === 'run') {
          const mode = args[args.indexOf('STORAGE_MIGRATION_MODE=verify-empty')];
          return {
            status: 0,
            stdout: mode ? '{"version":1,"empty":true}' : overrides.migrationOutput ?? verifiedManifest,
            stderr: ''
          };
        }
        throw new Error(`unexpected Docker call: ${args.join(' ')}`);
      }
    }
  };
}

describe('storage volume migration orchestrator', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
      recursive: true,
      force: true
    })));
  });

  it('requires app, worker, and storage cleanup to be stopped before any helper mutation', async () => {
    const { runtime, calls } = successfulRuntime({ running: 'app\n' });
    await expect(executeStorageVolumeMigration({ project, helperImage }, runtime))
      .rejects.toThrow(/app, worker, and storage cleanup must be stopped/);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('ps');
    expect(calls[0]).toContain('storage-cleanup');
    expect(calls[0]).toContain('--profile');
    expect(calls[0]).toContain('tools');

    const cleanup = successfulRuntime({ running: 'storage-cleanup\n' });
    await expect(executeStorageVolumeMigration({ project, helperImage }, cleanup.runtime))
      .rejects.toThrow(/storage cleanup must be stopped/);
    expect(cleanup.calls.some((args) => args[0] === 'run')).toBe(false);
  });

  it('rejects a stopped stale container that mounts the exact legacy volume', async () => {
    const stale = successfulRuntime({
      volumeUsers: { [volumeNames[0]!]: 'deadbeef stale-stopped-container\n' }
    });

    await expect(executeStorageVolumeMigration({ project, helperImage }, stale.runtime))
      .rejects.toThrow(/mounted by a container/iu);
    expect(stale.calls.some((args) => args[0] === 'run')).toBe(false);
    const inspection = stale.calls.find((args) =>
      args[0] === 'container' && args.includes(`volume=${volumeNames[0]}`)
    );
    expect(inspection).toContain('--all');
  });

  it('rejects an unrelated container that mounts any exact new split volume', async () => {
    const foreign = successfulRuntime({
      volumeUsers: { [volumeNames[2]!]: 'cafebabe unrelated-foreign-container\n' }
    });

    await expect(executeStorageVolumeMigration({ project, helperImage }, foreign.runtime))
      .rejects.toThrow(/mounted by a container/iu);
    expect(foreign.calls.some((args) => args[0] === 'run')).toBe(false);
    expect(foreign.calls.some((args) =>
      args[0] === 'container' &&
      args.includes('--all') &&
      args.includes(`volume=${volumeNames[2]}`)
    )).toBe(true);
  });

  it('parses the documented exact project and absolute report flags', () => {
    const report = join(tmpdir(), 'pale-orbit-storage-migration.json');
    expect(parseStorageMigrationArguments([
      '--project', project,
      '--report', report
    ])).toEqual({ project, reportPath: report });
    expect(() => parseStorageMigrationArguments(['--project', project]))
      .toThrow(/Usage/);
    expect(() => parseStorageMigrationArguments([
      '--project', project,
      '--report', report,
      '--unknown', 'value'
    ])).toThrow(/Usage/);
  });

  it('reserves the exact report before Docker mutation, syncs success, and refuses collisions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pale-orbit-storage-migration-report-'));
    temporaryRoots.push(root);
    const reportPath = join(root, 'migration.json');
    const successful = successfulRuntime();
    let observedReservation = false;
    const runtime: StorageMigrationCommandRuntime = {
      async capture(args) {
        await access(reportPath);
        observedReservation = true;
        return successful.runtime.capture(args);
      }
    };

    const manifest = await executeStorageVolumeMigrationWithReport({
      project,
      helperImage,
      reportPath
    }, runtime);

    expect(observedReservation).toBe(true);
    expect(JSON.parse(await readFile(reportPath, 'utf8'))).toEqual(manifest);

    const collisionPath = join(root, 'collision.json');
    await writeFile(collisionPath, 'foreign');
    const collision = successfulRuntime();
    await expect(executeStorageVolumeMigrationWithReport({
      project,
      helperImage,
      reportPath: collisionPath
    }, collision.runtime)).rejects.toThrow(/report/iu);
    expect(collision.calls).toHaveLength(0);
    await expect(readFile(collisionPath, 'utf8')).resolves.toBe('foreign');
  });

  it('removes only its empty report reservation when migration fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pale-orbit-storage-migration-failure-'));
    temporaryRoots.push(root);
    const reportPath = join(root, 'migration.json');
    const failing = successfulRuntime({ running: 'worker\n' });

    await expect(executeStorageVolumeMigrationWithReport({
      project,
      helperImage,
      reportPath
    }, failing.runtime)).rejects.toThrow(/must be stopped/);
    await expect(access(reportPath)).rejects.toThrow();
  });

  it('rejects unpinned helpers and foreign exact-name volume labels', async () => {
    const { runtime } = successfulRuntime();
    await expect(executeStorageVolumeMigration({
      project,
      helperImage: 'registry.example/pale-orbit:latest'
    }, runtime)).rejects.toThrow(/digest-pinned/);

    const foreign = successfulRuntime({ volumeProject: 'foreign-project' });
    await expect(executeStorageVolumeMigration({ project, helperImage }, foreign.runtime))
      .rejects.toThrow(/foreign volume/);
    expect(foreign.calls.some((args) => args[0] === 'run')).toBe(false);
  });

  it('requires the digest-pinned migration helper to run as the image node user', async () => {
    const rootHelper = successfulRuntime({ helperUser: 'root' });

    await expect(executeStorageVolumeMigration({ project, helperImage }, rootHelper.runtime))
      .rejects.toThrow(/node user/iu);
    expect(rootHelper.calls.some((args) => args[0] === 'volume' && args[1] === 'create'))
      .toBe(false);
    expect(rootHelper.calls.some((args) => args[0] === 'run')).toBe(false);
  });

  it('uses a local pinned no-network helper, read-only legacy mount, and verifies all three classes', async () => {
    const { runtime, calls } = successfulRuntime();
    const manifest = await executeStorageVolumeMigration({ project, helperImage }, runtime);

    expect(manifest.version).toBe(1);
    expect(Object.values(manifest.classes).every((entry) => entry.verified)).toBe(true);
    const helperRuns = calls.filter((args) => args[0] === 'run');
    expect(helperRuns).toHaveLength(2);
    const volumeUserInspections = calls.filter((args) =>
      args[0] === 'container' && args[1] === 'ls'
    );
    expect(volumeUserInspections).toHaveLength(volumeNames.length * helperRuns.length);
    for (const exactName of volumeNames) {
      expect(volumeUserInspections.filter((args) => args.includes(`volume=${exactName}`)))
        .toHaveLength(helperRuns.length);
    }
    for (const helperRun of helperRuns) {
      const runIndex = calls.indexOf(helperRun);
      const immediatelyPrecedingInspections = calls.slice(
        runIndex - volumeNames.length,
        runIndex
      );
      expect(immediatelyPrecedingInspections).toHaveLength(volumeNames.length);
      expect(immediatelyPrecedingInspections.every((args) =>
        args[0] === 'container' && args[1] === 'ls' && args.includes('--all')
      )).toBe(true);
      expect(immediatelyPrecedingInspections.map((args) =>
        args.find((value) => value.startsWith('volume='))
      )).toEqual(volumeNames.map((name) => `volume=${name}`));
    }
    for (const run of helperRuns) {
      expect(run).toContain('--pull');
      expect(run).toContain('never');
      expect(run).toContain('--network');
      expect(run).toContain('none');
      expect(run).toContain('--read-only');
      expect(run).toContain(`${project}_book_storage:/legacy:ro`);
      expect(run).toContain(`${project}_book_staging:/var/lib/pale-orbit/staging`);
      expect(run).toContain(`${project}_book_publication:/var/lib/pale-orbit/publication`);
      expect(run).toContain(`${project}_book_covers:/var/lib/pale-orbit/covers`);
      expect(run).toContain(helperImage);
    }
    expect(helperRuns[0]).toContain('STORAGE_MIGRATION_MODE=verify-empty');
    expect(helperRuns[1]).toContain('STORAGE_MIGRATION_MODE=migrate');
  });

  it('creates missing exact labeled volumes and mounts them at image-owned node directories', async () => {
    const { runtime, calls } = successfulRuntime({ volumeInventory: [volumeNames[0]!] });

    await executeStorageVolumeMigration({ project, helperImage }, runtime);

    const creates = calls.filter((args) => args[0] === 'volume' && args[1] === 'create');
    expect(creates).toHaveLength(3);
    for (const [index, logicalName] of ['book_staging', 'book_publication', 'book_covers'].entries()) {
      const exactName = `${project}_${logicalName}`;
      const create = creates[index]!;
      expect(create).toContain('--name');
      expect(create).toContain(exactName);
      expect(create).toContain(`com.docker.compose.project=${project}`);
      expect(create).toContain(`com.docker.compose.volume=${logicalName}`);
    }
    const firstHelper = calls.find((args) => args[0] === 'run')!;
    expect(firstHelper).toContain('STORAGE_MIGRATION_STAGING_ROOT=/var/lib/pale-orbit/staging');
    expect(firstHelper).toContain('STORAGE_MIGRATION_PUBLICATION_ROOT=/var/lib/pale-orbit/publication');
    expect(firstHelper).toContain('STORAGE_MIGRATION_COVERS_ROOT=/var/lib/pale-orbit/covers');
    expect(calls.indexOf(creates.at(-1)!)).toBeLessThan(calls.indexOf(firstHelper));
  });

  it('rejects a volume create result that does not return the exact requested name', async () => {
    const foreign = successfulRuntime({
      volumeInventory: [volumeNames[0]!],
      createdVolumeOutput: 'foreign_volume'
    });

    await expect(executeStorageVolumeMigration({ project, helperImage }, foreign.runtime))
      .rejects.toThrow(/exact-name volume/iu);
    expect(foreign.calls.some((args) => args[0] === 'run')).toBe(false);
  });

  it('rejects a helper result without exact count, byte, and digest equality', async () => {
    const invalid = JSON.parse(verifiedManifest) as {
      classes: { publication: { destinationSha256: string } };
    };
    invalid.classes.publication.destinationSha256 = 'c'.repeat(64);
    const { runtime } = successfulRuntime({ migrationOutput: JSON.stringify(invalid) });

    await expect(executeStorageVolumeMigration({ project, helperImage }, runtime))
      .rejects.toThrow(StorageVolumeMigrationPreflightError);
  });
});
