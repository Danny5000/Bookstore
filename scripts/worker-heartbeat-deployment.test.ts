import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const normalize = (value: string): string => value.replace(/\r\n?/gu, '\n');

async function source(path: string): Promise<string> {
  return normalize(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));
}

function serviceBlock(compose: string, name: string): string {
  const match = new RegExp(
    `^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]*:|^secrets:|^networks:|^volumes:)`,
    'mu'
  ).exec(compose);
  if (!match) throw new Error(`Missing Compose service ${name}`);
  return match[0];
}

function childBlock(service: string, name: string): string {
  const match = new RegExp(
    `^ {4}${name}:\\n([\\s\\S]*?)(?=^ {4}[a-z][a-z0-9_-]*:|^ {2}[a-z])`,
    'mu'
  ).exec(service);
  if (!match) throw new Error(`Missing Compose ${name} block`);
  return match[0];
}

const workerSettings = [
  'WORKER_READY_FILE',
  'WORKER_CONCURRENCY',
  'WORKER_HEARTBEAT_INTERVAL_MS',
  'WORKER_HEARTBEAT_MAX_AGE_MS'
] as const;

const workerSettingValues = [
  'WORKER_READY_FILE: /tmp/worker-ready',
  'WORKER_CONCURRENCY: ${WORKER_CONCURRENCY:-1}',
  'WORKER_HEARTBEAT_INTERVAL_MS: ${WORKER_HEARTBEAT_INTERVAL_MS:-5000}',
  'WORKER_HEARTBEAT_MAX_AGE_MS: ${WORKER_HEARTBEAT_MAX_AGE_MS:-20000}'
] as const;

describe('worker heartbeat deployment consumers', () => {
  it('scopes production freshness settings to the worker alone', async () => {
    const compose = await source('compose.prod.yaml');
    const worker = serviceBlock(compose, 'worker');

    for (const name of [
      'app',
      'migrate',
      'database-role-provision',
      'bootstrap-admin',
      'storage-cleanup'
    ]) {
      const block = serviceBlock(compose, name);
      for (const setting of workerSettings) {
        expect(block, `${name}:${setting}`).not.toContain(setting);
      }
    }
    for (const setting of workerSettingValues) expect(worker).toContain(setting);
    expect(compose.slice(0, compose.indexOf('services:'))).not.toMatch(/WORKER_(?:READY|CONCURRENCY|HEARTBEAT)/u);
  });

  it('tombstones every worker setting form on shared development non-workers', async () => {
    const compose = await source('compose.dev.yaml');
    for (const name of [
      'app',
      'migrate',
      'database-role-provision',
      'bootstrap-admin',
      'storage-cleanup'
    ]) {
      const block = serviceBlock(compose, name);
      expect(block).toContain('env_file:');
      for (const setting of workerSettings) {
        expect(block, `${name}:${setting}`).toMatch(
          new RegExp(`^ {6}${setting}: ["']{2}$`, 'mu')
        );
        expect(block, `${name}:${setting}_FILE`).toMatch(
          new RegExp(`^ {6}${setting}_FILE: ["']{2}$`, 'mu')
        );
      }
    }

    const worker = serviceBlock(compose, 'worker');
    for (const setting of [
      'WORKER_READY_FILE: /tmp/worker-ready',
      'WORKER_CONCURRENCY: ${WORKER_CONCURRENCY:-1}',
      'WORKER_HEARTBEAT_INTERVAL_MS: ${WORKER_HEARTBEAT_INTERVAL_MS:-5000}',
      'WORKER_HEARTBEAT_MAX_AGE_MS: ${WORKER_HEARTBEAT_MAX_AGE_MS:-20000}'
    ]) expect(worker).toContain(setting);
  });

  it('uses the packaged and source validators without opaque marker checks', async () => {
    const production = await source('compose.prod.yaml');
    const development = await source('compose.dev.yaml');
    const productionWorker = serviceBlock(production, 'worker');
    const developmentWorker = serviceBlock(development, 'worker');

    expect(childBlock(productionWorker, 'healthcheck')).toContain(
      'test: [CMD, node, build/services/worker-health.js]'
    );
    expect(childBlock(developmentWorker, 'healthcheck')).toContain(
      'test: [CMD, node, --import, tsx, src/worker-health.ts]'
    );
    for (const compose of [production, development]) {
      expect(compose).not.toMatch(/statSync\([^\n]*worker-ready|worker-ready[^\n]*(?:size|length|exists)/u);
    }
  });

  it('keeps worker runtime isolation unchanged while packaging the health leaf', async () => {
    const production = serviceBlock(await source('compose.prod.yaml'), 'worker');
    const development = serviceBlock(await source('compose.dev.yaml'), 'worker');
    const serviceBuild = await source('vite.services.config.ts');

    for (const worker of [production, development]) {
      expect(childBlock(worker, 'tmpfs')).toContain('/tmp:rw,noexec,nosuid,size=32m');
      expect(worker).not.toMatch(/^ {4}ports:/mu);
    }
    expect(serviceBuild).toContain(
      "'worker-health': resolve(import.meta.dirname, 'src/worker-health.ts')"
    );
  });

  it('routes both smoke harnesses through the built validator and rehearses fixed failures', async () => {
    const productionSmoke = await source('scripts/plan6b-production-smoke.ts');
    const fixtureProbe = await source('scripts/plan6b-fixture-runtime-probe.ts');

    expect(productionSmoke).toContain("'build/services/worker-health.js'");
    expect(fixtureProbe).toContain("'build/services/worker-health.js'");
    expect(productionSmoke).toContain('dependencies.now()');
    expect(productionSmoke).toContain('worker-heartbeat-stale-');
    expect(productionSmoke).toContain('worker-heartbeat-missing-slot-');
    expect(productionSmoke).toContain(
      "['--env', `WORKER_READY_FILE=${heartbeatFile}`]"
    );
    const rehearsal = productionSmoke.slice(
      productionSmoke.indexOf('const rehearseWorkerHealthFailures'),
      productionSmoke.indexOf('return {', productionSmoke.indexOf('const rehearseWorkerHealthFailures'))
    );
    expect(rehearsal.match(/finally/gu)).toHaveLength(2);
    expect(productionSmoke).not.toContain('encodeWorkerHeartbeat');
  });

  it('does not expand public readiness to disclose worker state', async () => {
    const productionApp = serviceBlock(await source('compose.prod.yaml'), 'app');
    const developmentApp = serviceBlock(await source('compose.dev.yaml'), 'app');
    const readiness = await source('src/routes/health/ready/+server.ts');

    expect(productionApp).toContain("fetch('http://127.0.0.1:3000/health/ready')");
    expect(developmentApp).toContain("fetch('http://127.0.0.1:5173/health/ready')");
    expect(readiness).not.toMatch(/worker|heartbeat/iu);
    expect(readiness).toContain("probeStorage(getObjectStorage(), 'web')");
  });
});
