import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  executeSplitStorageBackup,
  parseSplitStorageBackupArguments,
  type SplitStorageBackupRuntime
} from './split-storage-backup';

const project = 'pale-orbit-backup-test';
const helperImage = `registry.example/pale-orbit@sha256:${'a'.repeat(64)}`;
const dockerContext = 'production-context';
const dockerEngineId = 'engine:production-123';
const classes = ['staging', 'publication', 'covers'] as const;

interface RuntimeOverrides {
  running?: string;
  engineId?: string;
  volumeInventory?: string[];
  foreignProject?: string;
  helperOutputClass?: string;
  volumeUsers?: string;
}

function runtimeFixture(overrides: RuntimeOverrides = {}): {
  runtime: SplitStorageBackupRuntime;
  calls: string[][];
} {
  const calls: string[][] = [];
  const created = new Set<string>();
  const exactVolumes = classes.map((name) => `${project}_book_${name}`);
  return {
    calls,
    runtime: {
      async capture(argumentsToRun) {
        const args = [...argumentsToRun];
        calls.push(args);
        const command = args[2];
        if (command === 'info') {
          return {
            status: 0,
            stdout: JSON.stringify({ ID: overrides.engineId ?? dockerEngineId }),
            stderr: ''
          };
        }
        if (command === 'compose') {
          return { status: 0, stdout: overrides.running ?? '', stderr: '' };
        }
        if (command === 'image' && args[3] === 'inspect') {
          return {
            status: 0,
            stdout: JSON.stringify({ RepoDigests: [helperImage], Config: { User: 'node' } }),
            stderr: ''
          };
        }
        if (command === 'volume' && args[3] === 'ls') {
          return {
            status: 0,
            stdout: `${[...(overrides.volumeInventory ?? exactVolumes), ...created].join('\n')}\n`,
            stderr: ''
          };
        }
        if (command === 'volume' && args[3] === 'create') {
          const name = args.at(-1)!;
          created.add(name);
          return { status: 0, stdout: `${name}\n`, stderr: '' };
        }
        if (command === 'volume' && args[3] === 'inspect') {
          const name = args[4]!;
          return {
            status: 0,
            stdout: JSON.stringify({
              Name: name,
              Labels: {
                'com.docker.compose.project': overrides.foreignProject ?? project,
                'com.docker.compose.volume': name.slice(`${project}_`.length)
              }
            }),
            stderr: ''
          };
        }
        if (command === 'container' && args[3] === 'ls') {
          return { status: 0, stdout: overrides.volumeUsers ?? '', stderr: '' };
        }
        if (command === 'run') {
          const setting = args.find((value) => value.startsWith('STORAGE_ARCHIVE_CLASS='));
          const storageClass = overrides.helperOutputClass ?? setting?.split('=')[1];
          return {
            status: 0,
            stdout: JSON.stringify({
              version: 1,
              storageClass,
              count: 1,
              bytes: 5,
              sha256: 'b'.repeat(64)
            }),
            stderr: ''
          };
        }
        throw new Error(`Unexpected Docker arguments: ${args.join(' ')}`);
      }
    }
  };
}

describe('split storage backup Docker orchestrator', () => {
  const temporaryRoots: string[] = [];

  async function backupRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'pale-orbit-split-backup-'));
    temporaryRoots.push(root);
    return root;
  }

  async function seedStorageArtifacts(root: string): Promise<void> {
    for (const storageClass of classes) {
      await writeFile(join(root, `${storageClass}.tar.gz`), `archive:${storageClass}`);
      await writeFile(join(root, `${storageClass}.manifest.json`), `manifest:${storageClass}`);
    }
  }

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
      recursive: true,
      force: true
    })));
  });

  it('captures all exact owned volumes read-only with a pinned no-network helper', async () => {
    const root = await backupRoot();
    const fixture = runtimeFixture();

    const evidence = await executeSplitStorageBackup({
      mode: 'capture',
      project,
      helperImage,
      dockerContext,
      expectedDockerEngineId: dockerEngineId,
      bundleRoot: root
    }, fixture.runtime);

    expect(evidence.map(({ storageClass }) => storageClass)).toEqual(classes);
    const quiescence = fixture.calls.filter((args) => args[2] === 'compose');
    expect(quiescence.length).toBeGreaterThanOrEqual(4);
    for (const call of quiescence) {
      expect(call).toContain('app');
      expect(call).toContain('worker');
      expect(call).toContain('storage-cleanup');
    }
    const helpers = fixture.calls.filter((args) => args[2] === 'run');
    expect(helpers).toHaveLength(3);
    for (const [index, call] of helpers.entries()) {
      const storageClass = classes[index]!;
      expect(call.slice(0, 2)).toEqual(['--context', dockerContext]);
      expect(call).toContain('--pull');
      expect(call).toContain('never');
      expect(call).toContain('--network');
      expect(call).toContain('none');
      expect(call).toContain('--read-only');
      expect(call).toContain('--cap-drop');
      expect(call).toContain('ALL');
      expect(call).toContain('--tmpfs');
      expect(call).toContain('/tmp:rw,noexec,nosuid,size=64m');
      expect(call).toContain(`${project}_book_${storageClass}:/var/lib/pale-orbit/${storageClass}:ro`);
      expect(call).toContain(`${root}:/backup`);
      expect(call).toContain(helperImage);
    }
    const volumeUserChecks = fixture.calls.filter(
      (args) => args[2] === 'container' && args[3] === 'ls'
    );
    expect(volumeUserChecks).toHaveLength(9);
    for (const call of volumeUserChecks) {
      expect(call).toContain('--all');
      expect(call).toContain('--filter');
      expect(call.some((value) => value.startsWith('volume=pale-orbit-backup-test_book_')))
        .toBe(true);
    }
    expect(fixture.calls.some((args) => args[2] === 'volume' && args[3] === 'create')).toBe(false);
  });

  it('labels every helper with an exact checkpoint owner token for finally cleanup', async () => {
    const root = await backupRoot();
    const fixture = runtimeFixture();
    const checkpointOwnerToken = '0123456789abcdef0123456789abcdef';

    await executeSplitStorageBackup({
      mode: 'capture', project, helperImage, dockerContext,
      expectedDockerEngineId: dockerEngineId, bundleRoot: root, checkpointOwnerToken
    }, fixture.runtime);

    for (const call of fixture.calls.filter((args) => args[2] === 'run')) {
      expect(call).toContain(`com.docker.compose.project=${project}`);
      expect(call).toContain('com.docker.compose.service=deployment-checkpoint-storage');
      expect(call).toContain(`io.pale-orbit.deployment-checkpoint=${checkpointOwnerToken}`);
    }
  });

  it('creates exact labeled empty restore volumes and mounts them at node-owned image paths', async () => {
    const root = await backupRoot();
    await seedStorageArtifacts(root);
    const fixture = runtimeFixture({ volumeInventory: [] });

    await executeSplitStorageBackup({
      mode: 'restore',
      project,
      helperImage,
      dockerContext,
      expectedDockerEngineId: dockerEngineId,
      bundleRoot: root
    }, fixture.runtime);

    const creates = fixture.calls.filter(
      (args) => args[2] === 'volume' && args[3] === 'create'
    );
    expect(creates).toHaveLength(3);
    for (const [index, call] of creates.entries()) {
      const storageClass = classes[index]!;
      expect(call).toContain(`com.docker.compose.project=${project}`);
      expect(call).toContain(`com.docker.compose.volume=book_${storageClass}`);
      expect(call).toContain(`${project}_book_${storageClass}`);
    }
    const preflights = fixture.calls.filter((args) =>
      args[2] === 'run' && args.includes('STORAGE_ARCHIVE_MODE=verify-restore')
    );
    expect(preflights).toHaveLength(3);
    for (const [index, call] of preflights.entries()) {
      const storageClass = classes[index]!;
      expect(call).toContain(`${project}_book_${storageClass}:/var/lib/pale-orbit/${storageClass}:ro`);
      expect(call).toContain(`${root}:/backup:ro`);
    }
    const helpers = fixture.calls.filter((args) =>
      args[2] === 'run' && args.includes('STORAGE_ARCHIVE_MODE=restore')
    );
    expect(helpers).toHaveLength(3);
    for (const [index, call] of helpers.entries()) {
      const storageClass = classes[index]!;
      expect(call).toContain(`${project}_book_${storageClass}:/var/lib/pale-orbit/${storageClass}`);
      expect(call).not.toContain(`${project}_book_${storageClass}:/var/lib/pale-orbit/${storageClass}:ro`);
      expect(call).toContain(`${root}:/backup:ro`);
    }
  });

  it('fails before helpers for a running process, wrong engine, or foreign exact volume', async () => {
    const root = await backupRoot();
    for (const [fixture, expected] of [
      [runtimeFixture({ running: 'storage-cleanup\n' }), /must be stopped/iu],
      [runtimeFixture({ engineId: 'foreign-engine' }), /engine/iu],
      [runtimeFixture({ foreignProject: 'foreign-project' }), /foreign volume/iu]
    ] as const) {
      await expect(executeSplitStorageBackup({
        mode: 'capture',
        project,
        helperImage,
        dockerContext,
        expectedDockerEngineId: dockerEngineId,
        bundleRoot: root
      }, fixture.runtime)).rejects.toThrow(expected);
      expect(fixture.calls.some((args) => args[2] === 'run')).toBe(false);
    }
  });

  it('rejects any running or stopped container that still mounts an exact split volume', async () => {
    const root = await backupRoot();
    const fixture = runtimeFixture({ volumeUsers: 'stale-container-id stale-app\n' });

    await expect(executeSplitStorageBackup({
      mode: 'capture',
      project,
      helperImage,
      dockerContext,
      expectedDockerEngineId: dockerEngineId,
      bundleRoot: root
    }, fixture.runtime)).rejects.toThrow(/mounted by a container/iu);
    expect(fixture.calls.some((args) => args[2] === 'run')).toBe(false);
    const consumerCheck = fixture.calls.find(
      (args) => args[2] === 'container' && args[3] === 'ls'
    )!;
    expect(consumerCheck).toContain('--all');
  });

  it('preflights all six storage artifacts before any Docker inspection or mutation', async () => {
    const captureRoot = await backupRoot();
    await writeFile(join(captureRoot, 'publication.tar.gz'), 'foreign');
    const capture = runtimeFixture();
    await expect(executeSplitStorageBackup({
      mode: 'capture',
      project,
      helperImage,
      dockerContext,
      expectedDockerEngineId: dockerEngineId,
      bundleRoot: captureRoot
    }, capture.runtime)).rejects.toThrow(/artifact/iu);
    expect(capture.calls).toHaveLength(0);
    await expect(readFile(join(captureRoot, 'publication.tar.gz'), 'utf8'))
      .resolves.toBe('foreign');

    const restoreRoot = await backupRoot();
    const restore = runtimeFixture({ volumeInventory: [] });
    await expect(executeSplitStorageBackup({
      mode: 'restore',
      project,
      helperImage,
      dockerContext,
      expectedDockerEngineId: dockerEngineId,
      bundleRoot: restoreRoot
    }, restore.runtime)).rejects.toThrow(/artifact/iu);
    expect(restore.calls).toHaveLength(0);
  });

  it('rejects malformed helper evidence and strict CLI ambiguity', async () => {
    const root = await backupRoot();
    const fixture = runtimeFixture({ helperOutputClass: 'wrong' });
    await expect(executeSplitStorageBackup({
      mode: 'capture',
      project,
      helperImage,
      dockerContext,
      expectedDockerEngineId: dockerEngineId,
      bundleRoot: root
    }, fixture.runtime)).rejects.toThrow(/evidence/iu);

    expect(parseSplitStorageBackupArguments([
      'capture',
      '--project', project,
      '--root', root,
      '--context', dockerContext,
      '--engine-id', dockerEngineId
    ])).toEqual({
      mode: 'capture',
      project,
      bundleRoot: root,
      dockerContext,
      expectedDockerEngineId: dockerEngineId
    });
    expect(() => parseSplitStorageBackupArguments([
      'restore', '--project', project, '--root', root
    ])).toThrow(/Usage/);
  });

  it('publishes the tested helper and orchestrator as executable service commands', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    const buildConfig = await readFile('vite.services.config.ts', 'utf8');

    expect(packageJson.scripts['storage:backup-volumes'])
      .toBe('node --env-file-if-exists=.env --import tsx scripts/split-storage-backup.ts');
    expect(buildConfig).toContain("'storage-volume-backup-helper': resolve(");
    expect(buildConfig).toContain("'src/storage-volume-backup-entry.ts'");
  });
});
