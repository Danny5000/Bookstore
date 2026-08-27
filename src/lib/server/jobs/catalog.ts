import { isProxy } from 'node:util/types';

import type { JobRecord } from './types';

export interface JobDiagnosticMetadata {
  readonly correlationId?: unknown;
  readonly generation?: unknown;
}

const EMPTY_JOB_DIAGNOSTIC_METADATA: JobDiagnosticMetadata = Object.freeze({});
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function isPositiveSignedInt32(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 2_147_483_647;
}

function ownDataValue(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

function parseIngestionGeneration(payload: unknown): number | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload) || isProxy(payload)) {
    return undefined;
  }

  const prototype = Object.getPrototypeOf(payload);
  if (prototype !== Object.prototype && prototype !== null) {
    return undefined;
  }

  const keys = Reflect.ownKeys(payload);
  if (keys.length !== 2 || !keys.includes('revisionId') || !keys.includes('generation')) {
    return undefined;
  }

  const revisionDescriptor = Object.getOwnPropertyDescriptor(payload, 'revisionId');
  const generationDescriptor = Object.getOwnPropertyDescriptor(payload, 'generation');
  if (
    revisionDescriptor === undefined ||
    generationDescriptor === undefined ||
    !('value' in revisionDescriptor) ||
    !('value' in generationDescriptor) ||
    revisionDescriptor.enumerable !== true ||
    generationDescriptor.enumerable !== true ||
    typeof revisionDescriptor.value !== 'string' ||
    !CANONICAL_UUID_PATTERN.test(revisionDescriptor.value) ||
    !isPositiveSignedInt32(generationDescriptor.value)
  ) {
    return undefined;
  }

  return generationDescriptor.value;
}

export function parseRegisteredJobDiagnosticMetadata(
  job: Readonly<JobRecord>
): JobDiagnosticMetadata {
  try {
    if (
      typeof job !== 'object' ||
      job === null ||
      isProxy(job) ||
      Object.getPrototypeOf(job) !== Object.prototype
    ) {
      return EMPTY_JOB_DIAGNOSTIC_METADATA;
    }

    const type = ownDataValue(job, 'type');
    let generation: number | undefined;
    if (type === 'catalog.ingest_revision') {
      generation = parseIngestionGeneration(ownDataValue(job, 'payload'));
    } else if (type === 'operations.job-retry-command') {
      const candidate = ownDataValue(job, 'operationsJobLeaseGeneration');
      generation = isPositiveSignedInt32(candidate) ? candidate : undefined;
    }

    return generation === undefined
      ? EMPTY_JOB_DIAGNOSTIC_METADATA
      : Object.freeze({ generation });
  } catch {
    return EMPTY_JOB_DIAGNOSTIC_METADATA;
  }
}

export const REGISTERED_JOB_KINDS = Object.freeze([
  'outbox.dispatch',
  'commerce.claim-email',
  'commerce.claim-email-request',
  'commerce.stripe-event',
  'commerce.financial-source',
  'commerce.financial-payout',
  'commerce.financial-scan',
  'commerce.financial-classification',
  'commerce.financial-admin-command',
  'catalog.ingest_revision',
  'operations.job-retry-command'
] as const);

export type RegisteredJobKind = typeof REGISTERED_JOB_KINDS[number];
export type OperationalJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';
export type JobRetryDisposition =
  | 'never'
  | 'rearm_existing'
  | 'enqueue_successor'
  | 'provider_verified_recovery';
export type JobRetryPolicyAvailability = 'enabled' | 'disabled' | 'excluded';
export type OperationalJobFailureCode =
  | 'unregistered_job_kind'
  | 'invalid_job_identity'
  | 'source_unavailable'
  | 'domain_state_not_retryable'
  | 'retry_command_exhausted'
  | 'unexpected_failure';
export type JobDiagnosticGeneration =
  | 'none'
  | 'payload_generation'
  | 'operations_lease_generation';

export const JOB_RETRY_POLICY_IDS = Object.freeze([
  'deny_retry_not_supported',
  'deny_retry_policy_not_enabled',
  'deny_provider_recovery_not_enabled',
  'rearm_pending_stripe_event',
  'rearm_financial_classification'
] as const);

export type JobRetryPolicyId = typeof JOB_RETRY_POLICY_IDS[number];
export type JobRetryCommandStatus = 'succeeded' | 'denied' | 'failed';
export const JOB_RETRY_COMMAND_RESULT_CODES = Object.freeze([
  'rearmed_existing',
  'successor_enqueued',
  'already_current',
  'retry_not_supported',
  'retry_policy_not_enabled',
  'provider_recovery_not_enabled',
  'target_not_failed',
  'target_state_changed',
  'domain_state_not_retryable',
  'source_unavailable',
  'actor_not_authorized',
  'retry_command_invalid',
  'retry_command_exhausted',
  'unexpected_failure'
] as const);
export type JobRetryCommandResultCode = typeof JOB_RETRY_COMMAND_RESULT_CODES[number];

const SAFE_STATUSES = Object.freeze([
  'pending',
  'running',
  'succeeded',
  'failed'
] as const satisfies readonly OperationalJobStatus[]);

export interface JobDefinition {
  readonly kind: RegisteredJobKind;
  readonly label: string;
  readonly maxAttempts: number;
  readonly retryDisposition: JobRetryDisposition;
  readonly retryPolicyId: JobRetryPolicyId;
  readonly retryPolicyAvailability: JobRetryPolicyAvailability;
  readonly diagnosticGeneration: JobDiagnosticGeneration;
  readonly automaticRetryOwner: 'postgres_job_repository_exponential_backoff';
  readonly providerVerificationRequired: false;
  readonly providerCallsInPlan7A: false;
  readonly safeStatuses: readonly OperationalJobStatus[];
}

type DefinitionSpecific = Omit<
  JobDefinition,
  | 'automaticRetryOwner'
  | 'providerVerificationRequired'
  | 'providerCallsInPlan7A'
  | 'safeStatuses'
>;

type DefinitionCommon = Pick<
  JobDefinition,
  | 'automaticRetryOwner'
  | 'providerVerificationRequired'
  | 'providerCallsInPlan7A'
  | 'safeStatuses'
>;

function definition<const Specific extends DefinitionSpecific>(
  specific: Specific
): Readonly<Specific & DefinitionCommon> {
  return Object.freeze({
    ...specific,
    automaticRetryOwner: 'postgres_job_repository_exponential_backoff',
    providerVerificationRequired: false,
    providerCallsInPlan7A: false,
    safeStatuses: SAFE_STATUSES
  });
}

export const JOB_DEFINITIONS = Object.freeze([
  definition({
    kind: 'outbox.dispatch', label: 'Outbox dispatch', maxAttempts: 8,
    retryDisposition: 'rearm_existing', retryPolicyId: 'deny_retry_policy_not_enabled',
    retryPolicyAvailability: 'disabled', diagnosticGeneration: 'none'
  }),
  definition({
    kind: 'commerce.claim-email', label: 'Claim email', maxAttempts: 8,
    retryDisposition: 'enqueue_successor', retryPolicyId: 'deny_retry_policy_not_enabled',
    retryPolicyAvailability: 'disabled', diagnosticGeneration: 'none'
  }),
  definition({
    kind: 'commerce.claim-email-request', label: 'Claim email request', maxAttempts: 8,
    retryDisposition: 'enqueue_successor', retryPolicyId: 'deny_retry_policy_not_enabled',
    retryPolicyAvailability: 'disabled', diagnosticGeneration: 'none'
  }),
  definition({
    kind: 'commerce.stripe-event', label: 'Stripe event', maxAttempts: 12,
    retryDisposition: 'rearm_existing', retryPolicyId: 'rearm_pending_stripe_event',
    retryPolicyAvailability: 'enabled', diagnosticGeneration: 'none'
  }),
  definition({
    kind: 'commerce.financial-source', label: 'Financial source', maxAttempts: 12,
    retryDisposition: 'enqueue_successor', retryPolicyId: 'deny_retry_policy_not_enabled',
    retryPolicyAvailability: 'disabled', diagnosticGeneration: 'none'
  }),
  definition({
    kind: 'commerce.financial-payout', label: 'Financial payout', maxAttempts: 12,
    retryDisposition: 'enqueue_successor', retryPolicyId: 'deny_retry_policy_not_enabled',
    retryPolicyAvailability: 'disabled', diagnosticGeneration: 'none'
  }),
  definition({
    kind: 'commerce.financial-scan', label: 'Financial scan', maxAttempts: 8,
    retryDisposition: 'enqueue_successor', retryPolicyId: 'deny_retry_policy_not_enabled',
    retryPolicyAvailability: 'disabled', diagnosticGeneration: 'none'
  }),
  definition({
    kind: 'commerce.financial-classification', label: 'Financial classification',
    maxAttempts: 5, retryDisposition: 'rearm_existing',
    retryPolicyId: 'rearm_financial_classification', retryPolicyAvailability: 'enabled',
    diagnosticGeneration: 'none'
  }),
  definition({
    kind: 'commerce.financial-admin-command', label: 'Financial administrator command',
    maxAttempts: 8, retryDisposition: 'never', retryPolicyId: 'deny_retry_not_supported',
    retryPolicyAvailability: 'excluded', diagnosticGeneration: 'none'
  }),
  definition({
    kind: 'catalog.ingest_revision', label: 'Revision ingestion', maxAttempts: 5,
    retryDisposition: 'enqueue_successor', retryPolicyId: 'deny_retry_policy_not_enabled',
    retryPolicyAvailability: 'disabled', diagnosticGeneration: 'payload_generation'
  }),
  definition({
    kind: 'operations.job-retry-command', label: 'Operations job retry command',
    maxAttempts: 8, retryDisposition: 'never', retryPolicyId: 'deny_retry_not_supported',
    retryPolicyAvailability: 'excluded', diagnosticGeneration: 'operations_lease_generation'
  })
] as const satisfies readonly JobDefinition[]);

const DEFINITIONS_BY_KIND = new Map(
  JOB_DEFINITIONS.map((item) => [item.kind, item] as const)
);

export function isRegisteredJobKind(value: unknown): value is RegisteredJobKind {
  return typeof value === 'string' && DEFINITIONS_BY_KIND.has(value as RegisteredJobKind);
}

export function definitionForJobKind(value: unknown): JobDefinition | undefined {
  return isRegisteredJobKind(value) ? DEFINITIONS_BY_KIND.get(value) : undefined;
}

export const OUTBOX_DISPATCH_JOB = JOB_DEFINITIONS[0].kind;
export const OUTBOX_DISPATCH_JOB_MAX_ATTEMPTS = JOB_DEFINITIONS[0].maxAttempts;
export const COMMERCE_CLAIM_EMAIL_JOB = JOB_DEFINITIONS[1].kind;
export const COMMERCE_CLAIM_EMAIL_JOB_MAX_ATTEMPTS = JOB_DEFINITIONS[1].maxAttempts;
export const COMMERCE_CLAIM_REQUEST_JOB = JOB_DEFINITIONS[2].kind;
export const COMMERCE_CLAIM_REQUEST_JOB_MAX_ATTEMPTS = JOB_DEFINITIONS[2].maxAttempts;
export const STRIPE_EVENT_JOB = JOB_DEFINITIONS[3].kind;
export const STRIPE_EVENT_JOB_MAX_ATTEMPTS = JOB_DEFINITIONS[3].maxAttempts;
export const FINANCIAL_SOURCE_JOB = JOB_DEFINITIONS[4].kind;
export const FINANCIAL_SOURCE_JOB_MAX_ATTEMPTS = JOB_DEFINITIONS[4].maxAttempts;
export const FINANCIAL_PAYOUT_JOB = JOB_DEFINITIONS[5].kind;
export const FINANCIAL_PAYOUT_JOB_MAX_ATTEMPTS = JOB_DEFINITIONS[5].maxAttempts;
export const FINANCIAL_SCAN_JOB = JOB_DEFINITIONS[6].kind;
export const FINANCIAL_SCAN_JOB_MAX_ATTEMPTS = JOB_DEFINITIONS[6].maxAttempts;
export const FINANCIAL_CLASSIFICATION_JOB = JOB_DEFINITIONS[7].kind;
export const FINANCIAL_CLASSIFICATION_JOB_MAX_ATTEMPTS = JOB_DEFINITIONS[7].maxAttempts;
export const FINANCIAL_ADMIN_COMMAND_JOB = JOB_DEFINITIONS[8].kind;
export const FINANCIAL_ADMIN_COMMAND_MAX_ATTEMPTS = JOB_DEFINITIONS[8].maxAttempts;
export const INGEST_REVISION_JOB = JOB_DEFINITIONS[9].kind;
export const INGEST_REVISION_JOB_MAX_ATTEMPTS = JOB_DEFINITIONS[9].maxAttempts;
export const OPERATIONS_JOB_RETRY_COMMAND_JOB = JOB_DEFINITIONS[10].kind;
export const OPERATIONS_JOB_RETRY_COMMAND_MAX_ATTEMPTS = JOB_DEFINITIONS[10].maxAttempts;

type JobRetryPolicyOutcome = readonly [
  policyId: JobRetryPolicyId,
  status: JobRetryCommandStatus,
  resultCode: JobRetryCommandResultCode
];

function outcome(
  policyId: JobRetryPolicyId,
  status: JobRetryCommandStatus,
  resultCode: JobRetryCommandResultCode
): JobRetryPolicyOutcome {
  return Object.freeze([policyId, status, resultCode] as const);
}

export const JOB_RETRY_POLICY_OUTCOMES = Object.freeze([
  outcome('deny_retry_not_supported', 'denied', 'retry_not_supported'),
  outcome('deny_retry_policy_not_enabled', 'denied', 'retry_policy_not_enabled'),
  outcome('deny_provider_recovery_not_enabled', 'denied', 'provider_recovery_not_enabled'),
  outcome('rearm_pending_stripe_event', 'succeeded', 'rearmed_existing'),
  outcome('rearm_pending_stripe_event', 'denied', 'target_state_changed'),
  outcome('rearm_pending_stripe_event', 'denied', 'domain_state_not_retryable'),
  outcome('rearm_pending_stripe_event', 'denied', 'source_unavailable'),
  outcome('rearm_pending_stripe_event', 'failed', 'retry_command_invalid'),
  outcome('rearm_financial_classification', 'succeeded', 'rearmed_existing'),
  outcome('rearm_financial_classification', 'denied', 'target_state_changed'),
  outcome('rearm_financial_classification', 'denied', 'domain_state_not_retryable'),
  outcome('rearm_financial_classification', 'denied', 'source_unavailable'),
  outcome('rearm_financial_classification', 'failed', 'retry_command_invalid')
] as const satisfies readonly JobRetryPolicyOutcome[]);

export function isJobRetryPolicyOutcomeAllowed(
  policyId: unknown,
  status: unknown,
  resultCode: unknown
): boolean {
  return JOB_RETRY_POLICY_OUTCOMES.some((candidate) =>
    candidate[0] === policyId && candidate[1] === status && candidate[2] === resultCode
  );
}

const SAFE_FAILURES: Readonly<
  Record<RegisteredJobKind, Readonly<Record<string, OperationalJobFailureCode>>>
> = Object.freeze({
  'outbox.dispatch': Object.freeze({
    'Outbox job is missing outboxId': 'invalid_job_identity',
    'Invalid auth email payload': 'invalid_job_identity',
    'Invalid commerce email payload': 'invalid_job_identity',
    'Outbox message does not exist': 'source_unavailable'
  }),
  'commerce.claim-email': Object.freeze({
    'Invalid commerce claim-email payload': 'invalid_job_identity',
    'Commerce claim-email order is not eligible': 'domain_state_not_retryable'
  }),
  'commerce.claim-email-request': Object.freeze({
    'Invalid commerce claim-email payload': 'invalid_job_identity',
    'Commerce claim-email order is not eligible': 'domain_state_not_retryable'
  }),
  'commerce.stripe-event': Object.freeze({
    'Invalid Stripe event job payload.': 'invalid_job_identity',
    'Stripe event no longer exists.': 'source_unavailable'
  }),
  'commerce.financial-source': Object.freeze({
    'Invalid financial source job identity.': 'invalid_job_identity',
    'Financial source evidence is invalid.': 'domain_state_not_retryable'
  }),
  'commerce.financial-payout': Object.freeze({
    'Invalid financial payout job identity.': 'invalid_job_identity',
    'Financial payout evidence is invalid.': 'domain_state_not_retryable'
  }),
  'commerce.financial-scan': Object.freeze({
    'Invalid financial scan job identity.': 'invalid_job_identity',
    'Financial scan evidence is invalid.': 'domain_state_not_retryable'
  }),
  'commerce.financial-classification': Object.freeze({
    'Invalid financial classification job payload.': 'invalid_job_identity',
    'Financial classification evidence is invalid.': 'domain_state_not_retryable'
  }),
  'commerce.financial-admin-command': Object.freeze({
    'Invalid financial administrator command job identity.': 'invalid_job_identity',
    'Financial administrator command identity is invalid.': 'invalid_job_identity',
    'Financial administrator command is already terminal.': 'domain_state_not_retryable',
    'Financial administrator command was denied.': 'domain_state_not_retryable',
    'Financial administrator command conflicted with current state.':
      'domain_state_not_retryable'
  }),
  'catalog.ingest_revision': Object.freeze({
    'Invalid revision ingestion payload': 'invalid_job_identity',
    'Revision ingestion target does not exist': 'source_unavailable',
    'Revision staging metadata is incomplete': 'source_unavailable'
  }),
  'operations.job-retry-command': Object.freeze({
    'Invalid operations job retry command identity.': 'invalid_job_identity',
    'Operations job retry command exhausted.': 'retry_command_exhausted'
  })
});

export function isOperationalFailureCodeAllowedForJobKind(
  kind: unknown,
  code: unknown
): code is OperationalJobFailureCode | null {
  if (!isRegisteredJobKind(kind)) return false;
  if (code === null || code === 'unexpected_failure') return true;
  if (typeof code !== 'string') return false;
  return Object.values(SAFE_FAILURES[kind]).some((candidate) => candidate === code);
}

export function safeOperationalFailureCode(
  kind: unknown,
  lastError: unknown
): OperationalJobFailureCode | null {
  if (!isRegisteredJobKind(kind)) return 'unregistered_job_kind';
  if (lastError === null) return null;
  if (typeof lastError !== 'string') return 'unexpected_failure';
  const failures = SAFE_FAILURES[kind];
  return Object.hasOwn(failures, lastError) ? failures[lastError]! : 'unexpected_failure';
}
