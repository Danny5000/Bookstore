import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { loadWorkerApplicationConfig } from '$lib/server/config/load';
import { createAuthServer } from '$lib/server/auth/options';
import {
  purgeCommerceClaimIssuances,
  registerCommerceClaimIssuance
} from '$lib/server/auth/commerce-claim-capability';
import {
  canSendCommerceMagicLink,
  canSendMagicLink,
  ensureCustomerRole
} from '$lib/server/auth/identity';
import {
  COMMERCE_CLAIM_EMAIL_JOB,
  COMMERCE_CLAIM_REQUEST_JOB,
  createClaimEmailHandler,
  createClaimEmailOperations,
  queueCommerceClaimEmail
} from '$lib/server/commerce/claim-email';
import { createCommerceMessageEnqueuer } from '$lib/server/commerce/email/enqueue';
import { createCommerceEmailHandler } from '$lib/server/commerce/email/handler';
import { COMMERCE_EMAIL_TOPIC } from '$lib/server/commerce/email/payload';
import {
  fulfillCheckoutEvent,
  recordFulfillmentException
} from '$lib/server/commerce/fulfillment';
import {
  createStripeEventHandler,
  defaultLoadStripeEvent,
  fulfillPayoutEvent
} from '$lib/server/commerce/handler';
import { STRIPE_EVENT_JOB } from '$lib/server/commerce/job';
import { fulfillDisputeEvent } from '$lib/server/commerce/disputes';
import { fulfillRefundEvent } from '$lib/server/commerce/refunds';
import { createStripeWorkerRuntime } from '$lib/server/commerce/stripe/runtime-core';
import { createFinancialAdminCommandExecutors } from '$lib/server/commerce/financial/admin-commands/executors';
import {
  createFinancialAdminCommandHandler,
  FINANCIAL_ADMIN_COMMAND_JOB,
  type FinancialAdminCommandExecutor
} from '$lib/server/commerce/financial/admin-commands/handler';
import {
  FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
  FINANCIAL_CLASSIFIER_VERSION
} from '$lib/server/commerce/financial/constants';
import {
  FINANCIAL_CLASSIFICATION_JOB,
  FINANCIAL_PAYOUT_JOB,
  FINANCIAL_SCAN_JOB,
  FINANCIAL_SOURCE_JOB
} from '$lib/server/commerce/financial/jobs';
import { createFinancialSourceHandler } from '$lib/server/commerce/financial/handlers/source';
import { createFinancialPayoutHandler } from '$lib/server/commerce/financial/handlers/payout';
import { createFinancialScanHandler } from '$lib/server/commerce/financial/handlers/scan';
import {
  createFinancialClassificationHandler
} from '$lib/server/commerce/financial/handlers/classification';
import {
  createFinancialScheduleEnsurer
} from '$lib/server/commerce/financial/scans/scheduler';
import {
  executeReportingCorrectionCreate
} from '$lib/server/commerce/financial/refund-review/corrections';
import {
  executeRefundDraftDiscard,
  executeRefundDraftSave
} from '$lib/server/commerce/financial/refund-review/drafts';
import {
  executeRefundAllocationFinalize
} from '$lib/server/commerce/financial/refund-review/finalize';
import {
  executeAdministrativeRecoveryActivate,
  executeAdministrativeRecoveryDeactivate
} from '$lib/server/commerce/financial/refund-review/recovery';
import { createDatabaseClient } from '$lib/server/db/client';
import { databaseEnvironmentForRole } from '$lib/server/db/database-role-provision';
import { probeDatabase } from '$lib/server/db/health';
import { AUTH_EMAIL_TOPIC, queueAuthEmail } from '$lib/server/email/enqueue';
import { createAuthEmailHandler } from '$lib/server/email/handler';
import { createNodemailerEmailTransport } from '$lib/server/email/nodemailer';
import { createRevisionIngestionHandler } from '$lib/server/ingestion/handler';
import { INGEST_REVISION_JOB } from '$lib/server/ingestion/job';
import { ingestionLimitsFromConfig } from '$lib/server/ingestion/limits';
import { createPostgresJobRepository } from '$lib/server/jobs/repository';
import { runWorker } from '$lib/server/jobs/runner';
import {
  createTestWorkerControl,
  prepareTestWorkerPoll
} from '$lib/server/jobs/test-worker-control';
import type { JobHandler } from '$lib/server/jobs/types';
import {
  createOutboxDispatchHandler,
  type OutboxTopicHandler
} from '$lib/server/outbox/dispatcher';
import { OUTBOX_DISPATCH_JOB } from '$lib/server/outbox/repository';
import { createObjectStorage } from '$lib/server/storage/factory';
import { probeStorage } from '$lib/server/storage/health';

const rawWorkerEnvironment = process.env;
const config = loadWorkerApplicationConfig(
  databaseEnvironmentForRole(rawWorkerEnvironment, 'worker')
);
const controller = new AbortController();
const testWorkerControl = createTestWorkerControl({
  environment: rawWorkerEnvironment,
  concurrency: config.jobs.concurrency,
  abortWorker: (reason) => controller.abort(reason)
});
const databaseClient = createDatabaseClient(config.database);
const workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
const emailTransport = createNodemailerEmailTransport(config.smtp);
const storage = createObjectStorage(config.storage);
const commerceMessages = createCommerceMessageEnqueuer(config.origin);
const workerAuth = createAuthServer({
  database: databaseClient.db,
  config,
  queueVerificationEmail: (input) => queueAuthEmail(databaseClient.db, input),
  queueResetEmail: (input) => queueAuthEmail(databaseClient.db, input),
  queueMagicEmail: (input) => queueAuthEmail(databaseClient.db, input),
  queueCommerceClaimEmail: (input) =>
    queueCommerceClaimEmail(databaseClient.db, commerceMessages, input),
  canSendMagicLink: (email) => canSendMagicLink(databaseClient.db, email),
  canSendCommerceMagicLink: (email) => canSendCommerceMagicLink(databaseClient.db, email),
  onUserCreated: (userId) => ensureCustomerRole(databaseClient.db, userId),
  registerCommerceClaimIssuance: (input) =>
    registerCommerceClaimIssuance(databaseClient.db, input)
});
const stripeRuntime = createStripeWorkerRuntime(config);
const topicHandlers = new Map<string, OutboxTopicHandler>([
  [
    AUTH_EMAIL_TOPIC,
    createAuthEmailHandler(emailTransport, config.smtp.from, new URL(config.origin).hostname)
  ],
  [
    COMMERCE_EMAIL_TOPIC,
    createCommerceEmailHandler(
      emailTransport,
      config.smtp.from,
      new URL(config.origin).hostname,
      config.origin
    )
  ]
]);
const stripeEventHandler: JobHandler = createStripeEventHandler(
  databaseClient.db,
  stripeRuntime.gateway,
  {
    loadStripeEvent: defaultLoadStripeEvent,
    fulfillCheckout: (database, input) => fulfillCheckoutEvent(database, input, {
      purchaseMessages: commerceMessages
    }),
    fulfillRefund: (database, input) => fulfillRefundEvent(database, input, {
      messages: commerceMessages
    }),
    fulfillDispute: (database, input) => fulfillDisputeEvent(database, input, {
      messages: commerceMessages
    }),
    fulfillPayout: fulfillPayoutEvent,
    recordException: (database, input) => recordFulfillmentException(database, input)
  }
);
const financialSourceHandler = createFinancialSourceHandler({
  database: databaseClient.db,
  gateway: stripeRuntime.gateway
});
const financialPayoutHandler = createFinancialPayoutHandler({
  database: databaseClient.db,
  gateway: stripeRuntime.gateway
});
const financialScanHandler = createFinancialScanHandler({
  database: databaseClient.db,
  gateway: stripeRuntime.gateway,
  runtimeMode: stripeRuntime.mode
});
const financialClassificationHandler = createFinancialClassificationHandler({
  database: databaseClient.db,
  targetClassifierVersion: FINANCIAL_CLASSIFIER_VERSION,
  targetAllocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION
});
const financialAdminCommandExecutors =
  testWorkerControl.decorateFinancialAdminExecutors(
    createFinancialAdminCommandExecutors({
      refundDraftSave: executeRefundDraftSave as FinancialAdminCommandExecutor,
      refundDraftDiscard: executeRefundDraftDiscard as FinancialAdminCommandExecutor,
      refundAllocationFinalize:
        executeRefundAllocationFinalize as FinancialAdminCommandExecutor,
      refundReportingCorrectionCreate:
        executeReportingCorrectionCreate as FinancialAdminCommandExecutor,
      administrativeRecoveryActivate:
        executeAdministrativeRecoveryActivate as FinancialAdminCommandExecutor,
      administrativeRecoveryDeactivate:
        executeAdministrativeRecoveryDeactivate as FinancialAdminCommandExecutor
    })
  );
const financialAdminCommandHandler = createFinancialAdminCommandHandler({
  database: databaseClient.db,
  executors: financialAdminCommandExecutors,
  accessMessages: commerceMessages
});
const handlers = new Map<string, JobHandler>([
  [OUTBOX_DISPATCH_JOB, createOutboxDispatchHandler(databaseClient.db, topicHandlers)],
  [
    COMMERCE_CLAIM_EMAIL_JOB,
    createClaimEmailHandler(createClaimEmailOperations(
      databaseClient.db,
      workerAuth,
      commerceMessages,
      config.origin
    ))
  ],
  [
    COMMERCE_CLAIM_REQUEST_JOB,
    createClaimEmailHandler(createClaimEmailOperations(
      databaseClient.db,
      workerAuth,
      commerceMessages,
      config.origin
    ), { allowExistingReceipt: true })
  ],
  [STRIPE_EVENT_JOB, stripeEventHandler],
  [FINANCIAL_SOURCE_JOB, financialSourceHandler],
  [FINANCIAL_PAYOUT_JOB, financialPayoutHandler],
  [FINANCIAL_SCAN_JOB, financialScanHandler],
  [FINANCIAL_CLASSIFICATION_JOB, financialClassificationHandler],
  [FINANCIAL_ADMIN_COMMAND_JOB, financialAdminCommandHandler],
  [
    INGEST_REVISION_JOB,
    createRevisionIngestionHandler(
      databaseClient.db,
      storage,
      ingestionLimitsFromConfig(config.ingestion)
    )
  ]
]);
const repository = createPostgresJobRepository(
  databaseClient.db,
  config.jobs,
  undefined,
  stripeRuntime.mode === 'disabled' ? 'local-only' : 'all'
);
const ensureFinancialSchedule = createFinancialScheduleEnsurer({
  database: databaseClient.db,
  runtimeMode: stripeRuntime.mode,
  classifierVersion: FINANCIAL_CLASSIFIER_VERSION,
  allocationAlgorithmVersion: FINANCIAL_ALLOCATION_ALGORITHM_VERSION
});
let nextClaimIssuancePurgeAt = 0;

async function prepareWorkerPoll(
  context: Parameters<typeof ensureFinancialSchedule>[0]
): Promise<void> {
  await prepareTestWorkerPoll({
    control: testWorkerControl,
    signal: context.signal,
    maintenance: async () => {
      const observedAt = context.now.getTime();
      if (observedAt >= nextClaimIssuancePurgeAt) {
        await purgeCommerceClaimIssuances(databaseClient.db);
        nextClaimIssuancePurgeAt = observedAt + 60_000;
      }
      await ensureFinancialSchedule(context);
    }
  });
}

function requestShutdown(): void {
  controller.abort();
}

process.once('SIGINT', requestShutdown);
process.once('SIGTERM', requestShutdown);

try {
  await probeDatabase(databaseClient.pool, config.database.readinessTimeoutMs);
  await probeStorage(storage, 'writer');
  await writeFile(config.jobs.workerReadyFile, workerId, { encoding: 'utf8' });
  console.info('[worker] ready', { workerId });
  await runWorker({
    repository,
    handlers,
    workerId,
    concurrency: config.jobs.concurrency,
    pollIntervalMs: config.jobs.pollIntervalMs,
    leaseRenewalIntervalMs: Math.max(1, Math.floor(config.jobs.leaseMs / 3)),
    beforePoll: prepareWorkerPoll,
    signal: controller.signal
  });
  testWorkerControl.throwIfFailed();
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
