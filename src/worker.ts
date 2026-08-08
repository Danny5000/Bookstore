import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { loadApplicationConfig } from '$lib/server/config/load';
import { createDatabaseClient } from '$lib/server/db/client';
import { probeDatabase } from '$lib/server/db/health';
import { createPostgresJobRepository } from '$lib/server/jobs/repository';
import { runWorker } from '$lib/server/jobs/runner';
import type { JobHandler } from '$lib/server/jobs/types';
import {
  createOutboxDispatchHandler,
  type OutboxTopicHandler
} from '$lib/server/outbox/dispatcher';
import { OUTBOX_DISPATCH_JOB } from '$lib/server/outbox/repository';

const config = loadApplicationConfig(process.env);
const databaseClient = createDatabaseClient(config.database);
const controller = new AbortController();
const workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
const topicHandlers = new Map<string, OutboxTopicHandler>();
const handlers = new Map<string, JobHandler>([
  [OUTBOX_DISPATCH_JOB, createOutboxDispatchHandler(databaseClient.db, topicHandlers)]
]);
const repository = createPostgresJobRepository(databaseClient.db, config.jobs);

function requestShutdown(): void {
  controller.abort();
}

process.once('SIGINT', requestShutdown);
process.once('SIGTERM', requestShutdown);

try {
  await probeDatabase(databaseClient.pool, config.database.readinessTimeoutMs);
  await writeFile(config.jobs.workerReadyFile, workerId, { encoding: 'utf8' });
  console.info('[worker] ready', { workerId });
  await runWorker({
    repository,
    handlers,
    workerId,
    pollIntervalMs: config.jobs.pollIntervalMs,
    signal: controller.signal
  });
} catch (error: unknown) {
  console.error('[worker] stopped unexpectedly', {
    name: error instanceof Error ? error.name : 'UnknownError'
  });
  process.exitCode = 1;
} finally {
  await rm(config.jobs.workerReadyFile, { force: true });
  await databaseClient.close();
}
