import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEPLOYMENT_BACKUP_ARTIFACTS,
  sealDeploymentBackupBundle,
  verifyDeploymentBackupBundle
} from './deployment-backup-bundle';
import {
  executeDeploymentCheckpoint,
  type CheckpointCommandResult,
  type CheckpointCommandRuntime,
  type DeploymentCheckpointDependencies
} from './deployment-checkpoint';
import type {
  StorageArchiveClass,
  StorageArchiveEntry,
  StorageArchiveManifest
} from '../src/storage-volume-backup-helper';

const backupId = '0123456789abcdef0123456789abcdef';
const sourceContext = 'source-context';
const restoreContext = 'restore-context';
const sourceEngineId = 'engine:source';
const restoreEngineId = 'engine:restore';
const sourceProject = 'pale-orbit-production';
const appImage = `registry.example/app@sha256:${'a'.repeat(64)}`;
const postgresImage = `registry.example/postgres@sha256:${'b'.repeat(64)}`;
const helperImage = `registry.example/helper@sha256:${'c'.repeat(64)}`;
const titleId = '00000000-0000-0000-0000-000000000001';
const revisionId = '00000000-0000-0000-0000-000000000002';
const objectId = '00000000-0000-0000-0000-000000000003';
const stagingKey = `staging/uploads/${titleId}`;
const originalKey = `titles/${titleId}/revisions/${revisionId}/original`;
const coverKey = `titles/${titleId}/covers/${objectId}.webp`;
const sentinelKey = 'health/publication/readiness-v1';
const sentinelValue = 'pale-orbit-publication-ready-v1';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function entry(key: string, contents: string): StorageArchiveEntry {
  return { key, bytes: Buffer.byteLength(contents), sha256: sha256(contents) };
}

const stagingEntry = entry(stagingKey, 'staging-object');
const originalEntry = entry(originalKey, 'publication-object');
const coverEntry = entry(coverKey, 'cover-object');
const sentinelEntry = entry(sentinelKey, sentinelValue);

function manifest(
  storageClass: StorageArchiveClass,
  entries: readonly StorageArchiveEntry[]
): StorageArchiveManifest {
  const ordered = [...entries].sort((left, right) =>
    left.key < right.key ? -1 : left.key > right.key ? 1 : 0
  );
  const digest = createHash('sha256');
  let bytes = 0;
  for (const item of ordered) {
    bytes += item.bytes;
    digest.update(`${item.sha256} ${item.bytes} ${item.key}\n`);
  }
  return {
    version: 1,
    storageClass,
    count: ordered.length,
    bytes,
    sha256: digest.digest('hex'),
    entries: ordered,
    ignored: { health: { count: 0, bytes: 0 } }
  };
}

const storageManifests: Readonly<Record<StorageArchiveClass, StorageArchiveManifest>> = {
  staging: manifest('staging', [stagingEntry]),
  publication: manifest('publication', [sentinelEntry, originalEntry]),
  covers: manifest('covers', [coverEntry])
};

const inventory = `storage_class,reference_kind,storage_key,checksum_sha256,byte_size
covers,title_cover,${coverKey},${coverEntry.sha256},${coverEntry.bytes}
publication,revision_original,${originalKey},${originalEntry.sha256},${originalEntry.bytes}
staging,revision_staging,${stagingKey},${stagingEntry.sha256},${stagingEntry.bytes}
`;
const migrationTimestamps = [
  1786232477025,
  1786232478281,
  1786241921927,
  1786291385389,
  1786320570009,
  1786379056134,
  1786407372329,
  1786504656905,
  1786766400000,
  1786793164447,
  1786810772351,
  1786823450867,
  1787280731368,
  1787414827000
] as const;
const migrationJournal = [
  'id,hash,created_at',
  ...migrationTimestamps.map((createdAt, index) =>
    `${index + 1},${index.toString(16).repeat(64)},${createdAt}`
  )
].join('\n') + '\n';
const rowCounts = `schema_name,table_name,row_count
public,titles,1
`;
const financialDiagnostics = `check_name,violation_count
failed_running_scan_permanent,0
failed_running_scan_retry_exhausted,0
pending_replay_child_incomplete,0
pending_replay_child_permanent,0
pending_replay_child_retry_exhausted,0
`;

function imageId(image: string): string {
  return `sha256:${sha256(image)}`;
}

function ok(stdout = ''): CheckpointCommandResult {
  return { status: 0, stdout, stderr: '' };
}

function argumentAfter(argumentsToRun: readonly string[], name: string): string {
  const index = argumentsToRun.indexOf(name);
  const value = argumentsToRun[index + 1];
  if (index < 0 || value === undefined) throw new Error(`Missing fake argument: ${name}`);
  return value;
}

function archiveMode(argumentsToRun: readonly string[]): string | undefined {
  return argumentsToRun.find((value) => value.startsWith('STORAGE_ARCHIVE_MODE='))
    ?.slice('STORAGE_ARCHIVE_MODE='.length);
}

function archiveClass(argumentsToRun: readonly string[]): StorageArchiveClass {
  const value = argumentsToRun.find((candidate) =>
    candidate.startsWith('STORAGE_ARCHIVE_CLASS=')
  )?.slice('STORAGE_ARCHIVE_CLASS='.length);
  if (value !== 'staging' && value !== 'publication' && value !== 'covers') {
    throw new Error('Fake helper storage class is missing');
  }
  return value;
}

function mountedBundleRoot(argumentsToRun: readonly string[]): string {
  const mount = argumentsToRun.find((value) =>
    value.endsWith(':/backup') || value.endsWith(':/backup:ro')
  );
  if (!mount) throw new Error('Fake helper bundle mount is missing');
  const suffix = mount.endsWith(':/backup:ro') ? ':/backup:ro' : ':/backup';
  return mount.slice(0, -suffix.length);
}

interface OwnedHelper {
  readonly id: string;
  readonly project: string;
  readonly ownerToken: string;
}

interface FakeRuntimeOptions {
  readonly failMaintenanceHealth?: boolean;
  readonly events?: string[];
  readonly surviveFinalHelper?: boolean;
}

class FakeCheckpointRuntime implements CheckpointCommandRuntime {
  readonly calls: string[][] = [];
  readonly #events: string[];
  readonly #failMaintenanceHealth: boolean;
  readonly #surviveFinalHelper: boolean;
  readonly #sourceVolumes = new Set([
    `${sourceProject}_book_staging`,
    `${sourceProject}_book_publication`,
    `${sourceProject}_book_covers`
  ]);
  readonly #restoreVolumes = new Set<string>();
  #restoreProject: string | undefined;
  #restoreStarted = false;
  #ownedHelper: OwnedHelper | undefined;

  constructor(options: FakeRuntimeOptions = {}) {
    this.#events = options.events ?? [];
    this.#failMaintenanceHealth = options.failMaintenanceHealth ?? false;
    this.#surviveFinalHelper = options.surviveFinalHelper ?? false;
  }

  leaveOwnedHelper(project: string, ownerToken: string): void {
    this.#ownedHelper = { id: 'checkpoint-helper', project, ownerToken };
  }

  async capture(
    argumentsToRun: readonly string[],
    options: { readonly environment: NodeJS.ProcessEnv; readonly input?: string }
  ): Promise<CheckpointCommandResult> {
    const args = [...argumentsToRun];
    this.calls.push(args);
    this.#events.push(`docker ${args.join(' ')}`);
    if (args[0] !== '--context') throw new Error(`Unexpected fake Docker prefix: ${args.join(' ')}`);
    const context = args[1];
    const command = args[2];
    if (context !== sourceContext && context !== restoreContext) {
      throw new Error(`Unexpected fake Docker context: ${String(context)}`);
    }
    if (command === 'info') {
      return ok(JSON.stringify({ ID: context === sourceContext ? sourceEngineId : restoreEngineId }));
    }
    if (command === 'image') return this.#image(args);
    if (command === 'compose') return this.#compose(context, args, options);
    if (command === 'container') return this.#container(context, args);
    if (command === 'volume') return this.#volume(context, args);
    if (command === 'network') return this.#network(context, args);
    if (command === 'cp') return this.#copy(context, args);
    if (command === 'run') return this.#helper(args);
    throw new Error(`Unmatched fake Docker command: ${args.join(' ')}`);
  }

  #image(args: readonly string[]): CheckpointCommandResult {
    if (args[3] !== 'inspect') throw new Error(`Unmatched fake image command: ${args.join(' ')}`);
    const requestedImage = args[4];
    if (!requestedImage) throw new Error('Fake image is missing');
    return ok(JSON.stringify({
      Id: imageId(requestedImage),
      RepoDigests: [requestedImage],
      Config: { User: 'node' }
    }));
  }

  #compose(
    context: string,
    args: readonly string[],
    options: { readonly environment: NodeJS.ProcessEnv; readonly input?: string }
  ): CheckpointCommandResult {
    const project = argumentAfter(args, '--project-name');
    const action = args.find((value, index) =>
      index > 2 && ['ps', 'exec', 'run', 'up', 'down'].includes(value)
    );
    if (!action) throw new Error(`Unmatched fake Compose command: ${args.join(' ')}`);
    if (action === 'ps') {
      if (args.includes('--quiet') && args.includes('postgres')) {
        if (context === sourceContext) return ok('source-postgres\n');
        return ok(this.#restoreStarted ? 'restore-postgres\n' : '');
      }
      return ok();
    }
    if (action === 'run') return ok();
    if (action === 'up') {
      if (context !== restoreContext) throw new Error('Fake source Compose must not be started');
      this.#restoreProject = project;
      this.#restoreStarted = true;
      this.#restoreVolumes.add(`${project}_postgres_data`);
      return ok();
    }
    if (action === 'down') {
      if (!args.includes('--volumes') || !args.includes('--remove-orphans')) {
        throw new Error('Fake teardown requires exact volume and orphan cleanup');
      }
      this.#restoreStarted = false;
      this.#restoreVolumes.clear();
      this.#ownedHelper = undefined;
      return ok();
    }
    if (args.includes('pg_dump') || args.includes('pg_restore')) return ok();
    if (args.includes('rm') && args.includes('/tmp/database.dump')) return ok();
    if (args.includes('rm') && args.some((value) => value.endsWith('.dump'))) return ok();
    if (args.includes('psql')) {
      if (args.includes('-c')) return ok(migrationJournal);
      if (options.input?.includes('restore_row_counts')) return ok(rowCounts);
      if (options.input?.includes('storage_references')) return ok(inventory);
      if (options.input?.includes('restore_financial_checks')) return ok(financialDiagnostics);
      throw new Error('Unmatched fake psql input');
    }
    if (args.includes('app') && args.includes('node')) {
      return this.#failMaintenanceHealth
        ? { status: 1, stdout: '', stderr: 'injected health failure' }
        : ok();
    }
    throw new Error(`Unmatched fake Compose exec: ${args.join(' ')}`);
  }

  #container(context: string, args: readonly string[]): CheckpointCommandResult {
    const action = args[3];
    if (action === 'ls') {
      const filter = args.includes('--filter') ? argumentAfter(args, '--filter') : undefined;
      if (filter?.startsWith('volume=')) return ok();
      if (filter?.startsWith('label=io.pale-orbit.deployment-checkpoint=')) {
        const ownerToken = filter.slice('label=io.pale-orbit.deployment-checkpoint='.length);
        return ok(this.#ownedHelper?.ownerToken === ownerToken ? `${this.#ownedHelper.id}\n` : '');
      }
      if (filter?.startsWith('label=com.docker.compose.project=')) {
        const project = filter.slice('label=com.docker.compose.project='.length);
        return ok(this.#restoreStarted && this.#restoreProject === project ? 'restore-postgres\n' : '');
      }
      return ok(this.#restoreStarted && context === restoreContext ? 'restore-postgres\n' : '');
    }
    if (action === 'inspect') {
      const id = args[4];
      if (id === 'source-postgres') {
        return ok(JSON.stringify({
          Name: `/${sourceProject}-postgres-1`,
          Image: imageId(postgresImage),
          Config: {
            Image: postgresImage,
            Labels: {
              'com.docker.compose.project': sourceProject,
              'com.docker.compose.service': 'postgres'
            }
          }
        }));
      }
      if (id === this.#ownedHelper?.id) {
        return ok(JSON.stringify({
          'com.docker.compose.project': this.#ownedHelper.project,
          'com.docker.compose.service': 'deployment-checkpoint-storage',
          'io.pale-orbit.deployment-checkpoint': this.#ownedHelper.ownerToken
        }));
      }
      throw new Error(`Unmatched fake container inspect: ${String(id)}`);
    }
    if (action === 'rm' && args[4] === '--force' && args[5] === this.#ownedHelper?.id) {
      this.#ownedHelper = undefined;
      return ok();
    }
    throw new Error(`Unmatched fake container command: ${args.join(' ')}`);
  }

  #volume(context: string, args: readonly string[]): CheckpointCommandResult {
    const action = args[3];
    if (action === 'ls') {
      if (args.includes('--filter')) {
        const project = argumentAfter(args, '--filter')
          .replace('label=com.docker.compose.project=', '');
        const matching = [...this.#restoreVolumes].filter((name) => name.startsWith(`${project}_`));
        return ok(matching.length ? `${matching.join('\n')}\n` : '');
      }
      const volumes = context === sourceContext ? this.#sourceVolumes : this.#restoreVolumes;
      return ok(volumes.size ? `${[...volumes].join('\n')}\n` : '');
    }
    if (action === 'create') {
      const name = argumentAfter(args, '--name');
      this.#restoreVolumes.add(name);
      return ok(`${name}\n`);
    }
    if (action === 'inspect') {
      const name = args[4];
      if (!name) throw new Error('Fake volume inspect name is missing');
      const suffix = ['staging', 'publication', 'covers'].find((value) =>
        name.endsWith(`_book_${value}`)
      );
      if (!suffix) throw new Error(`Unmatched fake volume inspect: ${name}`);
      const project = name.slice(0, -`_book_${suffix}`.length);
      return ok(JSON.stringify({
        Name: name,
        Labels: {
          'com.docker.compose.project': project,
          'com.docker.compose.volume': `book_${suffix}`
        }
      }));
    }
    throw new Error(`Unmatched fake volume command: ${args.join(' ')}`);
  }

  #network(_context: string, args: readonly string[]): CheckpointCommandResult {
    if (args[3] !== 'ls') throw new Error(`Unmatched fake network command: ${args.join(' ')}`);
    return ok();
  }

  async #copy(context: string, args: readonly string[]): Promise<CheckpointCommandResult> {
    if (context === sourceContext) {
      const destination = args[4];
      if (!destination) throw new Error('Fake dump destination is missing');
      await writeFile(destination, 'authenticated-database-dump');
      return ok();
    }
    if (context === restoreContext && args[4]?.endsWith(':/tmp/database.dump')) return ok();
    throw new Error(`Unmatched fake copy command: ${args.join(' ')}`);
  }

  async #helper(args: readonly string[]): Promise<CheckpointCommandResult> {
    const mode = archiveMode(args);
    if (mode !== 'capture' && mode !== 'restore' && mode !== 'verify-restore') {
      throw new Error(`Unmatched fake helper mode: ${String(mode)}`);
    }
    const storageClass = archiveClass(args);
    const projectLabel = args.find((value) => value.startsWith('com.docker.compose.project='));
    const ownerLabel = args.find((value) =>
      value.startsWith('io.pale-orbit.deployment-checkpoint=')
    );
    if (!projectLabel || !ownerLabel) throw new Error('Fake helper ownership labels are missing');
    if (mode === 'capture') {
      const root = mountedBundleRoot(args);
      await writeFile(join(root, `${storageClass}.tar.gz`), `archive:${storageClass}`);
      await writeFile(
        join(root, `${storageClass}.manifest.json`),
        `${JSON.stringify(storageManifests[storageClass], null, 2)}\n`
      );
    }
    if (this.#surviveFinalHelper && mode === 'restore' && storageClass === 'covers') {
      this.leaveOwnedHelper(
        projectLabel.slice('com.docker.compose.project='.length),
        ownerLabel.slice('io.pale-orbit.deployment-checkpoint='.length)
      );
    }
    const evidence = storageManifests[storageClass];
    return ok(`${JSON.stringify({
      version: evidence.version,
      storageClass: evidence.storageClass,
      count: evidence.count,
      bytes: evidence.bytes,
      sha256: evidence.sha256
    })}\n`);
  }
}

const captureEnvironment: NodeJS.ProcessEnv = {
  APP_IMAGE: appImage,
  POSTGRES_IMAGE: postgresImage,
  STORAGE_BACKUP_HELPER_IMAGE: helperImage,
  DATABASE_OWNER_USER: 'pale_orbit_owner',
  DATABASE_NAME: 'pale_orbit',
  PATH: process.env.PATH
};

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

async function captureBundle(
  root: string,
  runtime: FakeCheckpointRuntime,
  dependencies?: DeploymentCheckpointDependencies
): Promise<void> {
  await executeDeploymentCheckpoint({
    mode: 'capture',
    project: sourceProject,
    bundleRoot: root,
    dockerContext: sourceContext,
    expectedDockerEngineId: sourceEngineId,
    backupId
  }, runtime, captureEnvironment, dependencies);
}

function callIndex(
  runtime: FakeCheckpointRuntime,
  predicate: (args: readonly string[]) => boolean
): number {
  return runtime.calls.findIndex(predicate);
}

function lastCallIndex(
  runtime: FakeCheckpointRuntime,
  predicate: (args: readonly string[]) => boolean
): number {
  for (let index = runtime.calls.length - 1; index >= 0; index -= 1) {
    if (predicate(runtime.calls[index]!)) return index;
  }
  return -1;
}

function rehearsalWorkspaceNames(entries: readonly string[]): string[] {
  return entries.filter((name) => name.startsWith('pale-orbit-rehearsal-workspace-')).sort();
}

describe('deployment checkpoint injected lifecycle runtime', () => {
  it('executes the full capture path and seals only after the final storage fence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pale-orbit-dynamic-capture-'));
    temporaryRoots.push(root);
    const events: string[] = [];
    const runtime = new FakeCheckpointRuntime({ events });
    const dependencies: DeploymentCheckpointDependencies = {
      async sealBundle(bundleRoot, expectedBackupId) {
        events.push('seal');
        return sealDeploymentBackupBundle(bundleRoot, expectedBackupId);
      },
      async verifyBundle(bundleRoot, expectedBackupId) {
        events.push('verify');
        return verifyDeploymentBackupBundle(bundleRoot, expectedBackupId);
      }
    };

    await captureBundle(root, runtime, dependencies);

    await expect(verifyDeploymentBackupBundle(root, backupId)).resolves.toMatchObject({
      version: 2,
      backupId
    });
    expect((await readdir(root)).sort()).toEqual(
      [...DEPLOYMENT_BACKUP_ARTIFACTS, 'backup-bundle.json'].sort()
    );
    const [sourceVerifier, copiedVerifier, copiedJournal, journalText] = await Promise.all([
      readFile('scripts/verify-financial-restore.sql', 'utf8'),
      readFile(join(root, 'verify-financial-restore.sql'), 'utf8'),
      readFile(join(root, 'migration-journal.csv'), 'utf8'),
      readFile('drizzle/meta/_journal.json', 'utf8')
    ]);
    const journal = JSON.parse(journalText) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };
    const copiedJournalRows = copiedJournal.trimEnd().split('\n');
    expect(copiedVerifier).toBe(sourceVerifier);
    expect(copiedVerifier.match(/plan6b-financial-catalog-v\d+/gu)).toEqual([
      'plan6b-financial-catalog-v3'
    ]);
    expect(copiedVerifier).not.toContain('plan6b-financial-catalog-v1');
    expect(/'0{64}'/u.test(copiedVerifier)).toBe(false);
    expect(copiedVerifier.includes('$catalog${}$catalog$')).toBe(false);
    expect(copiedJournalRows).toHaveLength(15);
    expect(copiedJournalRows.at(-1)).toBe(
      `14,${'d'.repeat(64)},${String(journal.entries.at(-1)?.when)}`
    );
    expect(journal.entries.at(-1)).toMatchObject({
      idx: 13,
      tag: '0013_plan6bii_reporting_correction_authority'
    });
    expect(events.slice(-2)).toEqual(['seal', 'verify']);
    expect(runtime.calls.some((args) => args.includes('pg_dump'))).toBe(true);
    expect(runtime.calls.filter((args) => archiveMode(args) === 'capture')).toHaveLength(3);
    const finalFence = lastCallIndex(runtime, (args) =>
      args.includes('ps') && args.includes('bootstrap-admin')
    );
    const finalHelper = lastCallIndex(runtime, (args) => archiveMode(args) === 'capture');
    expect(finalHelper).toBeGreaterThan(-1);
    expect(finalFence).toBeGreaterThan(finalHelper);
    expect(events.indexOf('seal')).toBeGreaterThan(finalFence);
    expect(runtime.calls.filter((args) => args.includes('psql'))).toHaveLength(4);
    expect(runtime.calls.some((args) =>
      args.includes('rm') && args.some((value) =>
        value === `/tmp/pale-orbit-checkpoint-${backupId}.dump`
      )
    )).toBe(true);
  });

  it('executes a full authenticated rehearsal then proves exact teardown and absence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pale-orbit-dynamic-rehearse-'));
    temporaryRoots.push(root);
    await captureBundle(root, new FakeCheckpointRuntime());
    const sourceManifest = await readFile(join(root, 'backup-bundle.json'), 'utf8');
    const sourceDump = await readFile(join(root, 'database.dump'));
    const beforeWorkspaces = rehearsalWorkspaceNames(await readdir(tmpdir()));
    const runtime = new FakeCheckpointRuntime();

    const result = await executeDeploymentCheckpoint({
      mode: 'rehearse',
      bundleRoot: root,
      dockerContext: restoreContext,
      expectedDockerEngineId: restoreEngineId,
      backupId
    }, runtime, { PATH: process.env.PATH });

    expect(result.project).toMatch(/^pale-orbit-restore-[a-f0-9]{32}$/u);
    expect(runtime.calls.filter((args) => archiveMode(args) === 'verify-restore')).toHaveLength(3);
    expect(runtime.calls.filter((args) => archiveMode(args) === 'restore')).toHaveLength(3);
    for (const args of runtime.calls.filter((candidate) => archiveMode(candidate) !== undefined)) {
      expect(mountedBundleRoot(args)).not.toBe(root);
      expect(mountedBundleRoot(args)).toContain('pale-orbit-checkpoint-');
    }
    const dumpCopy = runtime.calls.find((args) =>
      args[2] === 'cp' && args[4]?.endsWith(':/tmp/database.dump')
    );
    expect(dumpCopy?.[3]).not.toBe(join(root, 'database.dump'));
    expect(dumpCopy?.[3]).toContain('pale-orbit-checkpoint-');
    expect(runtime.calls.some((args) =>
      args.includes('up') && args.includes('postgres')
    )).toBe(true);
    expect(runtime.calls.some((args) =>
      args.includes('up') && args.includes('app')
    )).toBe(true);
    expect(runtime.calls.some((args) =>
      args.includes('up') && (args.includes('worker') || args.includes('caddy'))
    )).toBe(false);
    expect(runtime.calls.filter((args) => args.includes('psql'))).toHaveLength(4);
    expect(runtime.calls.some((args) =>
      args.includes('pg_restore') && args.includes('--no-owner') && !args.includes('--no-acl')
    )).toBe(true);
    const migrateCalls = runtime.calls
      .map((args, index) => ({ args, index }))
      .filter(({ args }) => args.includes('run') && args.includes('migrate'));
    const restoreCall = callIndex(runtime, (args) => args.includes('pg_restore'));
    const provisionCall = callIndex(runtime, (args) =>
      args.includes('run') && args.includes('database-role-provision')
    );
    expect(migrateCalls).toHaveLength(2);
    expect(migrateCalls[0]?.index).toBeLessThan(restoreCall);
    expect(migrateCalls[1]?.index).toBeGreaterThan(restoreCall);
    expect(provisionCall).toBeGreaterThan(migrateCalls[1]?.index ?? Number.MAX_SAFE_INTEGER);
    expect(runtime.calls.some((args) =>
      args.includes('run') && args.includes('storage-cleanup')
    )).toBe(true);
    expect(runtime.calls.some((args) =>
      args.includes('exec') && args.includes('app') && args.includes('node')
    )).toBe(true);
    const dumpCleanup = callIndex(runtime, (args) =>
      args.includes('exec') && args.includes('rm') && args.includes('/tmp/database.dump')
    );
    const down = callIndex(runtime, (args) =>
      args.includes('down') && args.includes('--volumes') && args.includes('--remove-orphans')
    );
    expect(dumpCleanup).toBeGreaterThan(-1);
    expect(down).toBeGreaterThan(dumpCleanup);
    expect(down).toBeGreaterThan(-1);
    const absenceCalls = runtime.calls.slice(down + 1);
    for (const kind of ['container', 'network', 'volume']) {
      expect(absenceCalls.some((args) =>
        args[2] === kind && args.includes('ls') &&
        args.includes(`label=com.docker.compose.project=${result.project}`)
      )).toBe(true);
      expect(absenceCalls.some((args) =>
        args[2] === kind && args.includes('ls') && !args.includes('--filter')
      )).toBe(true);
    }
    expect(await readFile(join(root, 'backup-bundle.json'), 'utf8')).toBe(sourceManifest);
    expect(await readFile(join(root, 'database.dump'))).toEqual(sourceDump);
    expect(rehearsalWorkspaceNames(await readdir(tmpdir()))).toEqual(beforeWorkspaces);
  });

  it('preserves the source and runs dump, helper, down, and absence cleanup after a late failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pale-orbit-dynamic-failure-'));
    temporaryRoots.push(root);
    await captureBundle(root, new FakeCheckpointRuntime());
    const sourceManifest = await readFile(join(root, 'backup-bundle.json'), 'utf8');
    const sourceDump = await readFile(join(root, 'database.dump'));
    const beforeWorkspaces = rehearsalWorkspaceNames(await readdir(tmpdir()));
    const runtime = new FakeCheckpointRuntime({
      failMaintenanceHealth: true,
      surviveFinalHelper: true
    });
    const rehearsal = executeDeploymentCheckpoint({
      mode: 'rehearse',
      bundleRoot: root,
      dockerContext: restoreContext,
      expectedDockerEngineId: restoreEngineId,
      backupId
    }, runtime, { PATH: process.env.PATH });

    await expect(rehearsal).rejects.toThrow(/health/iu);
    const projectLabel = runtime.calls.flat().find((value) =>
      value.startsWith('com.docker.compose.project=pale-orbit-restore-')
    );
    const project = projectLabel?.slice('com.docker.compose.project='.length);
    expect(project).toMatch(/^pale-orbit-restore-[a-f0-9]{32}$/u);
    const dumpCleanup = callIndex(runtime, (args) =>
      args.includes('exec') && args.includes('rm') && args.includes('/tmp/database.dump')
    );
    const helperCleanup = callIndex(runtime, (args) =>
      args.includes('container') && args.includes('rm') && args.includes('--force')
    );
    const down = callIndex(runtime, (args) =>
      args.includes('down') && args.includes('--volumes') && args.includes('--remove-orphans')
    );
    expect(dumpCleanup).toBeGreaterThan(-1);
    expect(helperCleanup).toBeGreaterThan(dumpCleanup);
    expect(down).toBeGreaterThan(helperCleanup);
    const absenceCalls = runtime.calls.slice(down + 1);
    for (const kind of ['container', 'network', 'volume']) {
      expect(absenceCalls.some((args) =>
        args[2] === kind && args.includes('ls') &&
        args.includes(`label=com.docker.compose.project=${String(project)}`)
      )).toBe(true);
    }
    expect(await readFile(join(root, 'backup-bundle.json'), 'utf8')).toBe(sourceManifest);
    expect(await readFile(join(root, 'database.dump'))).toEqual(sourceDump);
    expect(rehearsalWorkspaceNames(await readdir(tmpdir()))).toEqual(beforeWorkspaces);
  });

  it('invalidates a post-seal capture and removes only its injected owned helper', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pale-orbit-dynamic-post-seal-'));
    temporaryRoots.push(root);
    const runtime = new FakeCheckpointRuntime();
    const dependencies: DeploymentCheckpointDependencies = {
      sealBundle: sealDeploymentBackupBundle,
      async verifyBundle(bundleRoot, expectedBackupId) {
        await verifyDeploymentBackupBundle(bundleRoot, expectedBackupId);
        runtime.leaveOwnedHelper(sourceProject, backupId);
        throw new Error('injected post-seal proof failure');
      }
    };

    await expect(captureBundle(root, runtime, dependencies))
      .rejects.toThrow(/post-seal proof failure/iu);
    expect(await readdir(root)).not.toContain('backup-bundle.json');
    expect((await readdir(root)).sort()).toEqual([...DEPLOYMENT_BACKUP_ARTIFACTS].sort());
    expect(runtime.calls.some((args) =>
      args.includes('container') && args.includes('rm') && args.includes('--force') &&
      args.includes('checkpoint-helper')
    )).toBe(true);
    expect(runtime.calls.some((args) =>
      args.includes('container') && args.includes('rm') &&
      !args.includes('checkpoint-helper')
    )).toBe(false);
  });
});
