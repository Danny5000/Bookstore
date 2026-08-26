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

  it('documents the implemented observability and worker-freshness operator contract', async () => {
    const readme = await source('README.md');
    const workers = await source('docs/database-and-workers.md');
    const environments = await source('docs/runtime-environments.md');
    const exampleEnvironment = await source('.env.example');
    const operatorDocumentation = [readme, workers, environments].join('\n');

    expect.soft(operatorDocumentation).toContain('schema version `1`');
    expect.soft(operatorDocumentation).toContain('newline-delimited JSON (NDJSON)');
    expect.soft(operatorDocumentation).toContain(
      'written only to local standard output or standard error'
    );
    expect.soft(operatorDocumentation).toContain(
      '`^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$`'
    );
    expect.soft(operatorDocumentation).toContain(
      'a missing or invalid value is replaced with a generated lowercase UUID'
    );
    expect.soft(operatorDocumentation).toContain('is not echoed in a response header');
    expect.soft(operatorDocumentation).toContain(
      'never logs a URL, query string, request or response body, raw header, or raw error or stack'
    );
    for (const event of [
      'http.request.completed',
      'http.request.rejected',
      'http.request.failed',
      'worker.started',
      'worker.ready',
      'worker.stopping',
      'worker.stopped',
      'worker.failed',
      'worker.heartbeat_failed',
      'job.claimed',
      'job.succeeded',
      'job.failed',
      'job.lease_lost'
    ]) {
      expect.soft(operatorDocumentation, event).toContain(`\`${event}\``);
    }
    expect.soft(operatorDocumentation).toContain(
      'smoke emission and generalized release evidence remain deferred to Checkpoint D'
    );

    expect.soft(workers).toContain(
      '`version`, `workerId`, `processStartedAt`, `publishedAt`, `sequence`, `configuredSlots`, and `slots`'
    );
    expect.soft(workers).toContain(
      '`slotId`, `state`, `lastSuccessfulPollAt`, and `lastProgressAt`'
    );
    expect.soft(workers).toContain(
      '`polling` means the slot is preparing or attempting its next queue claim, including waiting to enter or executing the serialized before-poll hook; `idle` means it owns no claimed job after an empty poll, terminal settlement, or lease loss; and `handling` means it owns a claimed job'
    );
    expect.soft(workers).toContain('Slots are zero-based, and every configured slot appears exactly once');
    expect.soft(workers).toContain('A successful poll, including an empty poll, advances both timestamps');
    expect.soft(workers).toContain(
      'successful lease renewal advances `lastProgressAt` without changing `lastSuccessfulPollAt`'
    );
    expect.soft(workers).toContain('terminal settlement advances `lastProgressAt` and returns the slot to `idle`');
    expect.soft(workers).toContain('Merely awaiting a handler is not progress');
    expect.soft(workers).toContain(
      'a long-running handler remains fresh only while successful lease renewals continue'
    );

    expect.soft(environments).toContain('default `5,000` milliseconds');
    expect.soft(environments).toContain('between `1,000` and `30,000` milliseconds');
    expect.soft(environments).toContain('default `20,000` milliseconds');
    expect.soft(environments).toContain(
      '`WORKER_HEARTBEAT_MAX_AGE_MS >= 3 * WORKER_HEARTBEAT_INTERVAL_MS`'
    );
    expect.soft(environments).toContain(
      '`WORKER_HEARTBEAT_MAX_AGE_MS >= JOB_POLL_INTERVAL_MS + 2 * WORKER_HEARTBEAT_INTERVAL_MS`'
    );
    expect.soft(environments).toContain(
      '`WORKER_HEARTBEAT_MAX_AGE_MS < JOB_LEASE_MS`'
    );
    expect.soft(environments).toContain('`WORKER_HEARTBEAT_MAX_AGE_MS <= 300000`');
    expect.soft(environments).toContain(
      '`WORKER_READY_FILE`, `WORKER_CONCURRENCY`, `WORKER_HEARTBEAT_INTERVAL_MS`, `WORKER_HEARTBEAT_MAX_AGE_MS`, `JOB_POLL_INTERVAL_MS`, and `JOB_LEASE_MS`'
    );
    expect.soft(environments).toContain(
      'Web, migration, role provisioning, bootstrap, and storage cleanup do not read or retain the worker heartbeat settings'
    );

    expect.soft(workers).toContain(
      'dependency probes succeed, every configured slot completes its first successful poll, and the first atomic publication succeeds'
    );
    expect.soft(workers).toContain('The worker has no published port');
    expect.soft(workers).toContain(
      'a same-directory temporary sibling formed as `${WORKER_READY_FILE}.tmp`'
    );
    expect.soft(workers).toContain(
      'failure emits one `worker.heartbeat_failed`, aborts worker activity, and exits nonzero'
    );
    expect.soft(workers).toContain('at most 10 seconds');
    expect.soft(workers).toContain('force-exits with status `1`');
    expect.soft(workers).toContain('normal `SIGINT` or `SIGTERM` retains the Compose 30-second stop grace');
    expect.soft(workers).toContain(
      'removes the target and temporary evidence, and then closes email and database clients'
    );

    expect.soft(operatorDocumentation).toContain('`npm run worker:health`');
    expect.soft(operatorDocumentation).toContain('`node --import tsx src/worker-health.ts`');
    expect.soft(operatorDocumentation).toContain('`node build/services/worker-health.js`');
    expect.soft(operatorDocumentation).toContain('5,000-millisecond future tolerance');
    expect.soft(operatorDocumentation).toContain('65,536-byte maximum');
    expect.soft(workers).toContain(
      'missing, malformed, stale, too-far-future, wrong-slot-count, missing-slot, or stale-slot evidence as unhealthy'
    );
    expect.soft(operatorDocumentation).toContain('does not read or require database credentials');
    expect.soft(operatorDocumentation).toContain('has no network endpoint or public response');
    expect.soft(operatorDocumentation).toContain(
      'Compose does not restart a container merely because it is unhealthy'
    );
    expect.soft(operatorDocumentation).toContain(
      'fatal publisher failure exits nonzero under `restart: unless-stopped`'
    );

    expect.soft(readme).toContain('Plan 7A Checkpoint A dependency and test boundaries are implemented');
    expect.soft(readme).toContain(
      'Plan 7A Checkpoint B structured logging, correlation, and worker freshness are implemented'
    );
    expect.soft(readme).toContain('Plan 7A is not complete');
    expect.soft(readme).toContain(
      'General job operations and retry administration, monitoring and alert transport, generalized release and smoke evidence, scheduled off-host backups, deployment automation and hardening, final pool and capacity tuning, production activation, and Stripe enablement remain deferred'
    );
    expect.soft(workers).toContain(
      'Checkpoint B deliberately adds no monitoring or alert transport, generalized smoke evidence, operations catalog or UI, activation input, production-live mode, or Stripe enablement'
    );

    expect.soft(exampleEnvironment).toMatch(
      /WORKER_READY_FILE=.worker-ready\nWORKER_CONCURRENCY=1\nWORKER_HEARTBEAT_INTERVAL_MS=5000\nWORKER_HEARTBEAT_MAX_AGE_MS=20000/u
    );
    expect.soft(exampleEnvironment).not.toMatch(
      /^(?:LOGGING_ENDPOINT|LOGGING_TOKEN|ALERT_DESTINATION)=/mu
    );
    expect.soft(workers).not.toContain(
      'Its Compose health check requires a non-empty `/tmp/worker-ready` file written only after the initial database probe succeeds.'
    );
    expect.soft(environments).not.toContain(
      'Worker health proves the worker completed its initial database probe, atomically provisioned and verified that sentinel, used canonical disposable keys to round-trip all three roots, and entered the polling loop'
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
