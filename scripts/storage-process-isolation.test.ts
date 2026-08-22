import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(resolve(path), 'utf8');

function serviceBlock(compose: string, name: string): string {
  const match = new RegExp(
    `^  ${name}:\\r?\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:|^secrets:|^networks:|^volumes:)`,
    'mu'
  ).exec(compose);
  if (!match) throw new Error(`Missing Compose service ${name}`);
  return match[0];
}

const storageEnvironment = [
  'STORAGE_STAGING_ROOT: /var/lib/pale-orbit/staging',
  'STORAGE_PUBLICATION_ROOT: /var/lib/pale-orbit/publication',
  'STORAGE_COVERS_ROOT: /var/lib/pale-orbit/covers',
  'STORAGE_SCRATCH_ROOT: /tmp/pale-orbit-verified'
] as const;

describe('storage process isolation deployment', () => {
  it('mounts publication read-only in web and all persistent roots read-write in worker', () => {
    const compose = source('compose.prod.yaml');
    const app = serviceBlock(compose, 'app');
    const worker = serviceBlock(compose, 'worker');

    for (const setting of storageEnvironment) {
      expect(app).toContain(setting);
      expect(worker).toContain(setting);
    }
    expect(app).toContain('book_staging:/var/lib/pale-orbit/staging');
    expect(app).toContain('book_publication:/var/lib/pale-orbit/publication:ro');
    expect(app).toContain('book_covers:/var/lib/pale-orbit/covers');
    expect(worker).toContain('book_staging:/var/lib/pale-orbit/staging');
    expect(worker).toContain('book_publication:/var/lib/pale-orbit/publication');
    expect(worker).not.toContain('book_publication:/var/lib/pale-orbit/publication:ro');
    expect(worker).toContain('book_covers:/var/lib/pale-orbit/covers');
    expect(app).not.toContain('book_storage:');
    expect(worker).not.toContain('book_storage:');
  });

  it('uses capability-specific split-root readiness without weakening publication isolation', () => {
    expect(source('src/routes/health/ready/+server.ts')).toContain(
      "probeStorage(getObjectStorage(), 'web')"
    );
    expect(source('src/worker.ts')).toContain("probeStorage(storage, 'writer')");
    expect(source('src/cleanup-storage.ts')).toContain("probeStorage(storage, 'writer')");
    const runtime = source('docs/runtime-environments.md');
    expect(runtime).toContain('round-trips staging and covers');
    expect(runtime).toContain('fixed publication sentinel');
    expect(runtime).toContain('round-trip all three roots');
  });

  it('gives cleanup explicit read-write access to all persistent roots and ephemeral scratch', () => {
    const cleanup = serviceBlock(source('compose.prod.yaml'), 'storage-cleanup');
    for (const setting of storageEnvironment) expect(cleanup).toContain(setting);
    for (const mount of [
      'book_staging:/var/lib/pale-orbit/staging',
      'book_publication:/var/lib/pale-orbit/publication',
      'book_covers:/var/lib/pale-orbit/covers'
    ]) {
      expect(cleanup).toContain(mount);
      expect(cleanup).not.toContain(`${mount}:ro`);
    }
    expect(cleanup).toMatch(/^ {4}tmpfs:\r?\n\s+- \/tmp:rw,noexec,nosuid,size=/mu);
  });

  it('gives cleanup only its dedicated production database credential', () => {
    const cleanup = serviceBlock(source('compose.prod.yaml'), 'storage-cleanup');

    expect(cleanup).toContain(
      'DATABASE_STORAGE_CLEANUP_USER: ${DATABASE_STORAGE_CLEANUP_USER:'
    );
    expect(cleanup).toContain(
      'DATABASE_STORAGE_CLEANUP_PASSWORD_FILE: /run/secrets/database_storage_cleanup_password'
    );
    expect(cleanup).toMatch(/^\s+- database_storage_cleanup_password\s*$/mu);
    expect(cleanup).not.toContain('DATABASE_USER:');
    expect(cleanup).not.toContain('/run/secrets/database_password');
    expect(cleanup).not.toContain('DATABASE_OWNER_');
    expect(cleanup).not.toContain('DATABASE_WORKER_');
  });

  it('declares three persistent production volumes and no authoritative scratch volume', () => {
    const compose = source('compose.prod.yaml');
    const volumes = compose.slice(compose.lastIndexOf('\nvolumes:'));
    expect(volumes).toContain('  book_staging:');
    expect(volumes).toContain('  book_publication:');
    expect(volumes).toContain('  book_covers:');
    expect(volumes).not.toContain('  book_storage:');
    expect(volumes).not.toMatch(/scratch/iu);
  });

  it('mirrors the same read-only publication boundary in development Compose', () => {
    const compose = source('compose.dev.yaml');
    const app = serviceBlock(compose, 'app');
    const worker = serviceBlock(compose, 'worker');
    const cleanup = serviceBlock(compose, 'storage-cleanup');
    for (const block of [app, worker, cleanup]) {
      for (const setting of storageEnvironment) expect(block).toContain(setting);
    }
    expect(app).toContain('./.data/storage-publication:/var/lib/pale-orbit/publication:ro');
    expect(worker).toContain('./.data/storage-publication:/var/lib/pale-orbit/publication');
    expect(cleanup).toContain('./.data/storage-publication:/var/lib/pale-orbit/publication');
  });

  it('documents only the routed storage settings in the environment template', () => {
    const example = source('.env.example');
    expect(example).toContain('STORAGE_STAGING_ROOT=.data/storage-staging');
    expect(example).toContain('STORAGE_PUBLICATION_ROOT=.data/storage-publication');
    expect(example).toContain('STORAGE_COVERS_ROOT=.data/storage-covers');
    expect(example).not.toContain('STORAGE_LOCAL_ROOT');
  });

  it('documents the generation-aware derived-key rollout without requiring a legacy backfill', () => {
    const runbook = source('docs/storage-ingestion-and-publication.md');

    expect(runbook).toContain(
      '`derived/v1/generations/<canonical 0..2147483647>/<class>/<uuid>.webp`'
    );
    expect(runbook).toContain('`derived/v1/<class>/<uuid>.webp`');
    expect(runbook).toContain('no backfill');
    expect(runbook).toContain('protects an active legacy derived key conservatively');
    expect(runbook).toContain('exact revision ID and generation');
  });

  it('requires an explicit writer-quiescence attestation for every cleanup apply', () => {
    const runbook = source('docs/storage-ingestion-and-publication.md');
    const runtime = source('docs/runtime-environments.md');
    const packageConfiguration = JSON.parse(source('package.json')) as {
      scripts: Record<string, string>;
    };

    expect(packageConfiguration.scripts['storage:cleanup:apply']).toBe(
      'node --env-file-if-exists=.env --import tsx src/cleanup-storage.ts --apply --writers-quiesced'
    );
    for (const document of [runbook, runtime]) {
      expect(document).toContain('--apply --writers-quiesced');
      expect(document).not.toMatch(/cleanup-storage\.js --apply(?:\r?\n|$)/u);
    }
    expect(runbook).toContain(
      'docker compose --file compose.prod.yaml --profile tools stop app worker storage-cleanup'
    );
    expect(runbook).toContain(
      'docker compose --file compose.prod.yaml --profile tools ps --all app worker storage-cleanup'
    );
    for (const path of ['staging', 'publication', 'covers']) {
      expect(runbook).toContain(
        `docker ps --all --filter volume=/var/lib/pale-orbit/${path}`
      );
    }
    expect(runbook).toContain("inspect every all-state container's `.Mounts[].Source`");
    expect(runbook).toContain('three resolved `.data` paths');
    for (const document of [runbook, runtime]) {
      for (const volume of ['book_staging', 'book_publication', 'book_covers']) {
        expect(document).toContain(`docker ps --all --filter volume=<project>_${volume}`);
      }
    }
    expect(runbook).toContain('all-state consumer check');
  });

  it('keeps owned production smoke and fixture-probe resources on the three-root topology', () => {
    const smoke = source('scripts/plan6b-production-smoke.ts');
    const fixture = source('scripts/plan6b-fixture-runtime-probe.ts');
    for (const storageSource of [smoke, fixture]) {
      expect(storageSource).toContain('book_staging');
      expect(storageSource).toContain('book_publication');
      expect(storageSource).toContain('book_covers');
      expect(storageSource).not.toContain('STORAGE_LOCAL_ROOT');
    }
    expect(fixture).toContain('book_publication:/var/lib/pale-orbit/publication:ro');
    expect(fixture).toContain('book_publication:/var/lib/pale-orbit/publication');
  });

  it('documents a fail-closed legacy-volume migration with explicit rollback and disposition', () => {
    const runbook = source('docs/storage-ingestion-and-publication.md');
    for (const expected of [
      '## Split-volume upgrade',
      'docker compose --file compose.prod.yaml --profile tools stop app worker storage-cleanup',
      'STORAGE_MIGRATION_HELPER_IMAGE',
      '@sha256:',
      'npm run storage:migrate-volumes',
      'book_storage',
      'book_staging',
      'book_publication',
      'book_covers',
      'No running or stopped container may mount the legacy or any new exact storage volume during migration.',
      'count, byte, and SHA-256',
      'rollback',
      'legacy volume untouched'
    ]) expect(runbook).toContain(expected);
    expect(runbook).toMatch(/new volumes[^.]*empty/iu);
    expect(runbook).toMatch(/app and worker[^.]*stopped/iu);
  });

  it('gates canonical production cleanup and startup on the legacy split-volume migration', () => {
    for (const path of [
      'docs/database-and-workers.md',
      'docs/runtime-environments.md'
    ]) {
      const document = source(path);
      const sectionStart = document.indexOf(
        path.endsWith('database-and-workers.md')
          ? '## Production deployment order'
          : '## Production baseline'
      );
      const section = document.slice(sectionStart);
      const provision = section.indexOf('run --rm database-role-provision');
      const split = section.indexOf('npm run storage:migrate-volumes');
      const cleanup = section.indexOf('run --rm storage-cleanup');
      const startup = section.indexOf('up --detach --wait');

      expect(sectionStart, path).toBeGreaterThan(-1);
      expect(split, path).toBeGreaterThan(provision);
      expect(cleanup, path).toBeGreaterThan(split);
      expect(startup, path).toBeGreaterThan(cleanup);
      expect(section, path).toMatch(/already-split[^.]*verified/iu);
      expect(section, path).toMatch(
        /brand-new[^.]*legacy[^.]*absent[^.]*no storage-referencing/iu
      );
      expect(section, path).toMatch(/must not[^.]*storage-cleanup[^.]*migration report/iu);
    }
  });

  it('documents one atomic DB-plus-three-volume bundle verified before readiness', () => {
    const document = source('docs/storage-ingestion-and-publication.md');
    const runbook = document.slice(
      document.indexOf('## Current atomic split-volume backup and restore'),
      document.indexOf('## Coordinated backup')
    );
    for (const expected of [
      '## Current atomic split-volume backup and restore',
      'No running or stopped container may mount',
      'database.dump',
      'staging.tar.gz',
      'staging.manifest.json',
      'publication.tar.gz',
      'publication.manifest.json',
      'covers.tar.gz',
      'covers.manifest.json',
      'backup-bundle.json',
      'STORAGE_BACKUP_HELPER_IMAGE',
      'npm run deployment:checkpoint -- capture',
      'npm run deployment:checkpoint -- rehearse'
    ]) expect(runbook).toContain(expected);
    expect(runbook).not.toContain('npm run storage:backup-volumes');
    expect(runbook).not.toContain('npm run backup:bundle');
    expect(runbook).toMatch(
      /proves every restored database reference[^.]*checks maintenance liveness\/readiness only after/iu
    );
    expect(runbook).toMatch(/scratch[^.]*health[^.]*non-authoritative/iu);
    expect(runbook).toMatch(/archive[^.]*live volume[^.]*equality/iu);
    expect(runbook).toMatch(/restored volume[^.]*manifest[^.]*equality/iu);
  });
});
