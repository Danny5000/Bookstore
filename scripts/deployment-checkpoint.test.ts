import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEPLOYMENT_BACKUP_ARTIFACTS, sealDeploymentBackupBundle } from './deployment-backup-bundle';
import {
  assertStorageReferencesAuthenticated,
  createSyntheticRehearsalEnvironment,
  checkpointResourceIdentifierFormat,
  executeDeploymentCheckpoint,
  parseDeploymentCheckpointArguments,
  parseStorageReferenceInventory,
  snapshotDeploymentBackupBundle
} from './deployment-checkpoint';

const digest = 'a'.repeat(64);
const image = `registry.example/pale-orbit@sha256:${digest}`;
const backupId = '0123456789abcdef0123456789abcdef';

const inventory = `storage_class,reference_kind,storage_key,checksum_sha256,byte_size
covers,title_cover,titles/00000000-0000-0000-0000-000000000001/covers/00000000-0000-0000-0000-000000000003.webp,${digest},14
publication,revision_original,titles/00000000-0000-0000-0000-000000000001/revisions/00000000-0000-0000-0000-000000000002/original,${digest},13
staging,revision_staging,staging/uploads/00000000-0000-0000-0000-000000000001,${digest},12
`;

const manifests = {
  staging: { version: 1, storageClass: 'staging', count: 1, bytes: 12, sha256: digest,
    entries: [{ key: 'staging/uploads/00000000-0000-0000-0000-000000000001', bytes: 12, sha256: digest }],
    ignored: { health: { count: 0, bytes: 0 } } },
  publication: { version: 1, storageClass: 'publication', count: 1, bytes: 13, sha256: digest,
    entries: [{ key: 'titles/00000000-0000-0000-0000-000000000001/revisions/00000000-0000-0000-0000-000000000002/original', bytes: 13, sha256: digest }],
    ignored: { health: { count: 0, bytes: 0 } } },
  covers: { version: 1, storageClass: 'covers', count: 1, bytes: 14, sha256: digest,
    entries: [{ key: 'titles/00000000-0000-0000-0000-000000000001/covers/00000000-0000-0000-0000-000000000003.webp', bytes: 14, sha256: digest }],
    ignored: { health: { count: 0, bytes: 0 } } }
} as const;

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('deployment checkpoint storage-reference inventory', () => {
  it('captures every authoritative reference while matching the 0011 staging liveness rule', async () => {
    const sql = await readFile('scripts/capture-storage-reference-inventory.sql', 'utf8');

    expect(sql).toContain(
      'storage_class, reference_kind, storage_key, checksum_sha256, byte_size'
    );
    for (const family of [
      "'title_cover'",
      "'revision_staging'",
      "'revision_original'",
      "'prose_image'",
      "'comic_page'",
      "'revision_cover_suggestion'"
    ]) expect(sql).toContain(family);
    expect(sql).not.toMatch(/limit\s+5/iu);
    expect(sql).toContain("referenced_revision.state in ('uploaded', 'processing')");
    expect(sql).toContain("active_job.type = 'catalog.ingest_revision'");
    expect(sql).toContain("active_job.status in ('pending', 'running')");
    expect(sql).toContain("active_job.payload ->> 'revisionId' = referenced_revision.id::text");
    expect(sql).toContain(
      "active_job.payload ->> 'generation' = referenced_revision.ingestion_generation::text"
    );
    expect(sql).not.toContain("referenced_revision.state = 'failed'");
  });
});

describe('deployment checkpoint authenticated inputs', () => {
  it('parses only the exact capture and rehearsal command shapes', () => {
    expect(parseDeploymentCheckpointArguments([
      'capture', '--project', 'pale-orbit-prod', '--root', 'C:\\backup',
      '--context', 'production', '--engine-id', 'engine:prod', '--backup-id', backupId
    ])).toEqual({
      mode: 'capture', project: 'pale-orbit-prod', bundleRoot: 'C:\\backup',
      dockerContext: 'production', expectedDockerEngineId: 'engine:prod', backupId
    });
    expect(parseDeploymentCheckpointArguments([
      'rehearse', '--root', 'C:\\backup', '--context', 'rehearsal',
      '--engine-id', 'engine:restore', '--backup-id', backupId
    ])).toEqual({
      mode: 'rehearse', bundleRoot: 'C:\\backup', dockerContext: 'rehearsal',
      expectedDockerEngineId: 'engine:restore', backupId
    });
    expect(() => parseDeploymentCheckpointArguments(['rehearse', '--root', 'C:\\backup']))
      .toThrow(/Usage/);
  });

  it('uses a real Docker template field for each exact resource inventory', () => {
    expect(checkpointResourceIdentifierFormat('container')).toBe('{{.ID}}');
    expect(checkpointResourceIdentifierFormat('network')).toBe('{{.ID}}');
    expect(checkpointResourceIdentifierFormat('volume')).toBe('{{.Name}}');
  });

  it('rejects a relative checkpoint root before the Docker runtime is touched', async () => {
    let called = false;
    await expect(executeDeploymentCheckpoint({
      mode: 'capture', project: 'pale-orbit-prod', bundleRoot: '.',
      dockerContext: 'production', expectedDockerEngineId: 'engine:prod', backupId
    }, {
      async capture() {
        called = true;
        return { status: 1, stdout: '', stderr: '' };
      }
    }, {})).rejects.toThrow(/absolute/iu);
    expect(called).toBe(false);
  });

  it('requires every database reference to match bytes and digest in its routed manifest', () => {
    const references = parseStorageReferenceInventory(inventory);
    expect(() => assertStorageReferencesAuthenticated(references, manifests)).not.toThrow();
    expect(() => assertStorageReferencesAuthenticated(references, {
      ...manifests,
      publication: { ...manifests.publication, entries: [{
        ...manifests.publication.entries[0], bytes: 99
      }] }
    })).toThrow(/byte|manifest/iu);
    expect(() => parseStorageReferenceInventory(inventory.replace(',13\n', ',13\npublication,revision_original,' +
      `titles/duplicate,${digest},1\n`))).toThrow(/canonical|key/iu);
  });

  it('pins the destructive lifecycle to authenticated snapshot, owned helpers, and finally teardown', async () => {
    const source = await readFile('scripts/deployment-checkpoint.ts', 'utf8');
    expect(source.indexOf('snapshotDeploymentBackupBundle('))
      .toBeLessThan(source.indexOf('assertDockerEngine('));
    expect(source).toContain("'--no-owner'");
    expect(source).not.toContain("'--no-acl'");
    expect(source).toContain("'storage-cleanup'");
    expect(source).toContain("'app'");
    expect(source).not.toContain("up', '--detach', '--wait', 'worker'");
    expect(source).not.toContain("up', '--detach', '--wait', 'caddy'");
    expect(source).toContain('cleanupCheckpointHelpers');
    expect(source).toContain("'down', '--volumes', '--remove-orphans'");
    expect(source).toContain('assertProjectAbsent');
    const captureFence = source.slice(
      source.indexOf('async function assertCaptureQuiesced'),
      source.indexOf('async function inspectPinnedImage')
    );
    for (const service of [
      'app', 'worker', 'storage-cleanup', 'migrate', 'database-role-provision', 'bootstrap-admin'
    ]) expect(captureFence).toContain(`'${service}'`);
    const captureDatabase = source.slice(
      source.indexOf('async function captureDatabaseEvidence'),
      source.indexOf('async function captureImageEvidence')
    );
    expect(captureDatabase).toContain("'container', 'inspect'");
    expect(captureDatabase).toContain('POSTGRES_IMAGE');
    expect(source).toContain("'rm', '-f', '/tmp/database.dump'");
  });

  it('copies the calibrated Plan 7A catalog-v1 verifier and exhaustive 0015 database evidence', async () => {
    const [source, verifier, rowCountSql, journalText] = await Promise.all([
      readFile('scripts/deployment-checkpoint.ts', 'utf8'),
      readFile('scripts/verify-financial-restore.sql', 'utf8'),
      readFile('scripts/capture-restore-row-counts.sql', 'utf8'),
      readFile('drizzle/meta/_journal.json', 'utf8')
    ]);
    const journal = JSON.parse(journalText) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };

    expect(journal.entries.map(({ idx }) => idx)).toEqual(
      Array.from({ length: 16 }, (_value, idx) => idx)
    );
    expect(journal.entries.at(-1)).toMatchObject({
      idx: 15,
      tag: '0015_plan7a_operations_authority',
      when: 1787812813508
    });

    const journalCapture = source.match(
      /copy \(select \* from drizzle\.__drizzle_migrations order by id\) to stdout[^'\r\n]*/iu
    )?.[0];
    expect(journalCapture).toBeDefined();
    expect(journalCapture).not.toMatch(/\blimit\b/iu);
    expect(source).toContain("readFile('scripts/verify-financial-restore.sql', 'utf8')");
    expect(source).toContain("writeExclusive(join(root, 'verify-financial-restore.sql'), verifier)");

    expect(verifier.match(/plan7a-database-catalog-v\d+/gu)).toEqual([
      'plan7a-database-catalog-v1'
    ]);
    expect(verifier).not.toContain('plan6b-financial-catalog-v4');
    expect(/'0{64}'/u.test(verifier)).toBe(false);
    expect(verifier.includes('$catalog${}$catalog$')).toBe(false);

    expect(rowCountSql).toContain('from pg_catalog.pg_class c');
    expect(rowCountSql).toContain('join pg_catalog.pg_namespace n');
    expect(rowCountSql).toMatch(/c\.relkind\s+in\s*\(\s*'r'\s*,\s*'p'\s*\)/iu);
    expect(rowCountSql).not.toContain('financial_admin_commands');
    expect(rowCountSql).not.toContain('financial_admin_job_claims');
    expect(rowCountSql).not.toContain('operations_job_retry_commands');
    expect(rowCountSql).not.toContain('operations_job_retry_claims');
  });

  it('publishes one canonical current Plan 7A CLI and runbook flow', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['deployment:checkpoint'])
      .toBe('node --env-file-if-exists=.env --import tsx scripts/deployment-checkpoint.ts');
    const document = await readFile('docs/storage-ingestion-and-publication.md', 'utf8');
    const current = document.slice(
      document.indexOf('## Current atomic split-volume backup and restore'),
      document.indexOf('## Coordinated backup')
    );
    expect(current).toContain('npm run deployment:checkpoint -- capture');
    expect(current).toContain('npm run deployment:checkpoint -- rehearse');
    expect(current).not.toContain('npm run storage:backup-volumes');
    expect(current).not.toContain('npm run backup:bundle');
    expect(current).toContain('plan7a-database-catalog-v1');
    expect(current).toContain('0015_plan7a_operations_authority');
    expect(current).not.toContain('plan6b-financial-catalog-v4');
    expect(current).not.toContain('0014_plan6bii_issue_transition_fail_closed');
    expect(current).toContain('financial_admin_job_claims');
    expect(current).toContain('operations_job_retry_commands');
    expect(current).toContain('operations_job_retry_claims');
    expect(current).toContain('every ordinary or partitioned base table');
    for (const path of ['docs/database-and-workers.md', 'docs/runtime-environments.md']) {
      const runbook = await readFile(path, 'utf8');
      const production = runbook.slice(runbook.indexOf('## Production'));
      const capture = production.indexOf('npm run deployment:checkpoint -- capture');
      const rehearse = production.indexOf('npm run deployment:checkpoint -- rehearse');
      expect(capture, path).toBeGreaterThan(production.indexOf('npm run storage:migrate-volumes'));
      expect(rehearse, path).toBeGreaterThan(capture);
      expect(rehearse, path).toBeLessThan(production.indexOf('run --rm bootstrap-admin'));
      expect(production, path).toContain(
        'storage-ingestion-and-publication.md#current-atomic-split-volume-backup-and-restore'
      );
    }
  });

  it('builds a positive synthetic allowlist that cannot inherit Compose, PG, file, or Stripe overrides', async () => {
    const environment = createSyntheticRehearsalEnvironment({
      appImage: image,
      postgresImage: image,
      helperImage: image
    }, {
      PATH: 'safe-path', PGHOST: 'production', pgPORT: '5432', DATABASE_PASSWORD: 'production',
      DATABASE_PASSWORD_FILE: '/production', COMPOSE_FILE: 'foreign.yaml', DOCKER_HOST: 'tcp://prod',
      STRIPE_SECRET_KEY: 'secret', RANDOM_VALUE: 'nope'
    });
    expect(environment.PATH).toBe('safe-path');
    expect(environment.COMPOSE_DISABLE_ENV_FILE).toBe('1');
    expect(environment.APP_IMAGE).toBe(image);
    expect(environment.ORIGIN).toBe('https://rehearsal.invalid');
    expect(Object.keys(environment).some((key) => /^pg/iu.test(key))).toBe(false);
    expect(Object.keys(environment).filter((key) => /_FILE$/iu.test(key)))
      .toEqual(['COMPOSE_DISABLE_ENV_FILE']);
    expect(environment).not.toHaveProperty('COMPOSE_FILE');
    expect(environment).not.toHaveProperty('DOCKER_HOST');
    expect(environment).not.toHaveProperty('STRIPE_SECRET_KEY');
    expect(environment.DATABASE_PASSWORD).not.toBe('production');

    expect(environment).toMatchObject({
      DATABASE_OWNER_USER: 'pale_orbit_rehearsal_owner',
      DATABASE_USER: 'pale_orbit_rehearsal_web',
      DATABASE_WORKER_USER: 'pale_orbit_rehearsal_worker',
      DATABASE_STORAGE_CLEANUP_USER: 'pale_orbit_rehearsal_cleanup'
    });
    const compose = await readFile('compose.prod.yaml', 'utf8');
    const service = (name: string): string => compose.match(new RegExp(
      `^  ${name}:\\r?\\n[\\s\\S]*?(?=^  [a-z][a-z0-9-]*:|^networks:|^volumes:|^secrets:)`,
      'mu'
    ))?.[0] ?? '';
    const migration = service('migrate');
    expect(migration).toContain(
      'DATABASE_MIGRATION_WEB_USER: ${DATABASE_USER:?DATABASE_USER must be set}'
    );
    expect(migration).toContain(
      'DATABASE_MIGRATION_WORKER_USER: ${DATABASE_WORKER_USER:?DATABASE_WORKER_USER must be set}'
    );
    expect(migration).toContain(
      'DATABASE_MIGRATION_STORAGE_CLEANUP_USER: ${DATABASE_STORAGE_CLEANUP_USER:?DATABASE_STORAGE_CLEANUP_USER must be set}'
    );
    expect(migration).not.toMatch(/^\s+DATABASE_PASSWORD(?:_FILE)?:/mu);
    for (const name of [
      'app', 'worker', 'database-role-provision', 'bootstrap-admin', 'storage-cleanup'
    ]) {
      expect(service(name), name).not.toContain('DATABASE_MIGRATION_');
    }
  });

  it('copies then re-verifies an owned snapshot and rejects source mutation before Docker can consume it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pale-orbit-checkpoint-source-'));
    const snapshots = await mkdtemp(join(tmpdir(), 'pale-orbit-checkpoint-snapshots-'));
    temporaryRoots.push(root, snapshots);
    for (const name of DEPLOYMENT_BACKUP_ARTIFACTS) await writeFile(join(root, name), name);
    await sealDeploymentBackupBundle(root, backupId);

    let copied = 0;
    await expect(snapshotDeploymentBackupBundle(root, backupId, snapshots, {
      async beforeCopy() {
        if (copied++ === 0) await writeFile(join(root, 'database.dump'), 'changed');
      }
    })).rejects.toThrow(/digest|byte|changed/iu);
    expect(await readFile(join(root, 'database.dump'), 'utf8')).toBe('changed');
    expect(await readdir(snapshots)).toEqual([]);
  });

  it('anchors the snapshot to the initially verified manifest across a coherent same-ID source swap', async () => {
    const source = await mkdtemp(join(tmpdir(), 'pale-orbit-checkpoint-anchor-a-'));
    const replacement = await mkdtemp(join(tmpdir(), 'pale-orbit-checkpoint-anchor-b-'));
    const snapshots = await mkdtemp(join(tmpdir(), 'pale-orbit-checkpoint-anchor-snapshots-'));
    temporaryRoots.push(source, replacement, snapshots);
    for (const name of DEPLOYMENT_BACKUP_ARTIFACTS) {
      await writeFile(join(source, name), `a:${name}`);
      await writeFile(join(replacement, name), `b:${name}`);
    }
    await sealDeploymentBackupBundle(source, backupId);
    await sealDeploymentBackupBundle(replacement, backupId);
    let swapped = false;

    await expect(snapshotDeploymentBackupBundle(source, backupId, snapshots, {
      async beforeCopy() {
        if (swapped) return;
        swapped = true;
        for (const name of [...DEPLOYMENT_BACKUP_ARTIFACTS, 'backup-bundle.json']) {
          await copyFile(join(replacement, name), join(source, name));
        }
      }
    })).rejects.toThrow(/authenticated|digest|byte|changed/iu);
    expect(await readdir(snapshots)).toEqual([]);
  });
});
