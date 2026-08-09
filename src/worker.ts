import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { loadApplicationConfig } from '$lib/server/config/load';
import { createDatabaseClient } from '$lib/server/db/client';
import { probeDatabase } from '$lib/server/db/health';
import { AUTH_EMAIL_TOPIC } from '$lib/server/email/enqueue';
import { createAuthEmailHandler } from '$lib/server/email/handler';
import { createNodemailerEmailTransport } from '$lib/server/email/nodemailer';
import { createRevisionIngestionHandler } from '$lib/server/ingestion/handler';
import { INGEST_REVISION_JOB } from '$lib/server/ingestion/job';
import { ingestionLimitsFromConfig } from '$lib/server/ingestion/limits';
import { createPostgresJobRepository } from '$lib/server/jobs/repository';
import { runWorker } from '$lib/server/jobs/runner';
import type { JobHandler } from '$lib/server/jobs/types';
import {
  createOutboxDispatchHandler,
  type OutboxTopicHandler
} from '$lib/server/outbox/dispatcher';
import { OUTBOX_DISPATCH_JOB } from '$lib/server/outbox/repository';
import { createObjectStorage } from '$lib/server/storage/factory';
import { probeStorage } from '$lib/server/storage/health';

const config = loadApplicationConfig(process.env);
const databaseClient = createDatabaseClient(config.database);
const controller = new AbortController();
const workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
const emailTransport = createNodemailerEmailTransport(config.smtp);
const storage = createObjectStorage(config.storage);
const topicHandlers = new Map<string, OutboxTopicHandler>([
  [
    AUTH_EMAIL_TOPIC,
    createAuthEmailHandler(emailTransport, config.smtp.from, new URL(config.origin).hostname)
  ]
]);
const handlers = new Map<string, JobHandler>([
  [OUTBOX_DISPATCH_JOB, createOutboxDispatchHandler(databaseClient.db, topicHandlers)],
  [
    INGEST_REVISION_JOB,
    createRevisionIngestionHandler(
      databaseClient.db,
      storage,
      ingestionLimitsFromConfig(config.ingestion)
    )
  ]
]);
const repository = createPostgresJobRepository(databaseClient.db, config.jobs);

function requestShutdown(): void {
  controller.abort();
}

process.once('SIGINT', requestShutdown);
process.once('SIGTERM', requestShutdown);

try {
  await probeDatabase(databaseClient.pool, config.database.readinessTimeoutMs);
  await probeStorage(storage);
  await writeFile(config.jobs.workerReadyFile, workerId, { encoding: 'utf8' });
  console.info('[worker] ready', { workerId });
  await runWorker({
    repository,
    handlers,
    workerId,
    concurrency: config.jobs.concurrency,
    pollIntervalMs: config.jobs.pollIntervalMs,
    signal: controller.signal
  });
} catch (error: unknown) {
  console.error('[worker] stopped unexpectedly', {
    name: error instanceof Error ? error.name : 'UnknownError'
  });
  process.exitCode = 1;
} finally {
  emailTransport.close();
  await rm(config.jobs.workerReadyFile, { force: true });
  await databaseClient.close();
}
