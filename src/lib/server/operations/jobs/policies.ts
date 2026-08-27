import { isProxy } from 'node:util/types';

import type { DatabaseTransaction } from '../../db/transaction';
import {
  isJobRetryPolicyOutcomeAllowed,
  JOB_RETRY_POLICY_IDS,
  type JobDefinition,
  type JobRetryPolicyId,
  type RegisteredJobKind
} from '../../jobs/catalog';
import type {
  JobRetryDenialResultCode,
  JobRetryFailureResultCode,
  JobRetrySuccessResultCode
} from './contracts';

export interface JobRetryPolicyTarget {
  readonly commandId: string;
  readonly targetJobId: string;
  readonly expectedKind: RegisteredJobKind;
  readonly expectedStatus: 'failed';
  readonly expectedAttempts: number;
  readonly expectedMaxAttempts: number;
  readonly expectedUpdatedAt: string;
}

export interface JobRetryPolicyContext {
  readonly transaction: DatabaseTransaction;
  readonly target: JobRetryPolicyTarget;
  readonly signal: AbortSignal;
}

export type JobRetryPolicyOutcome =
  | Readonly<{ status: 'succeeded'; resultCode: JobRetrySuccessResultCode }>
  | Readonly<{ status: 'denied'; resultCode: JobRetryDenialResultCode }>
  | Readonly<{
      status: 'failed';
      resultCode: Extract<JobRetryFailureResultCode, 'retry_command_invalid'>;
    }>;

export type JobRetryPolicyAdapter =
  (context: JobRetryPolicyContext) => Promise<JobRetryPolicyOutcome>;

export type JobRetryPolicyAdapterId = JobRetryPolicyId;

export class InvalidJobRetryPolicyIdentityError extends Error {
  constructor() {
    super('Invalid job retry policy identity');
    this.name = 'InvalidJobRetryPolicyIdentityError';
  }
}

const ENABLED_ADAPTER_KEYS = Object.freeze([
  'rearmPendingStripeEvent',
  'rearmFinancialClassification'
] as const);
const OUTCOME_KEYS = Object.freeze(['status', 'resultCode'] as const);

type DataRecord = Record<string, unknown>;

function invalidIdentity(): never {
  throw new InvalidJobRetryPolicyIdentityError();
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[]
): DataRecord {
  if (
    value === null ||
    typeof value !== 'object' ||
    isProxy(value) ||
    Array.isArray(value)
  ) return invalidIdentity();

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return invalidIdentity();

  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => typeof key !== 'string' || !expectedKeys.includes(key))
  ) return invalidIdentity();

  const record: DataRecord = Object.create(null) as DataRecord;
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, 'value') ||
      descriptor.enumerable !== true
    ) return invalidIdentity();
    record[key] = descriptor.value;
  }
  return record;
}

function policyIdFromDefinition(definition: unknown): JobRetryPolicyId {
  if (
    definition === null ||
    typeof definition !== 'object' ||
    isProxy(definition) ||
    Array.isArray(definition)
  ) return invalidIdentity();

  const descriptor = Object.getOwnPropertyDescriptor(definition, 'retryPolicyId');
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
    return invalidIdentity();
  }
  const policyId = descriptor.value;
  if (
    typeof policyId !== 'string' ||
    !JOB_RETRY_POLICY_IDS.includes(policyId as JobRetryPolicyId)
  ) return invalidIdentity();
  return policyId as JobRetryPolicyId;
}

const RETRY_NOT_SUPPORTED = Object.freeze({
  status: 'denied',
  resultCode: 'retry_not_supported'
} as const satisfies JobRetryPolicyOutcome);
const RETRY_POLICY_NOT_ENABLED = Object.freeze({
  status: 'denied',
  resultCode: 'retry_policy_not_enabled'
} as const satisfies JobRetryPolicyOutcome);
const PROVIDER_RECOVERY_NOT_ENABLED = Object.freeze({
  status: 'denied',
  resultCode: 'provider_recovery_not_enabled'
} as const satisfies JobRetryPolicyOutcome);

const denyRetryNotSupported: JobRetryPolicyAdapter =
  () => Promise.resolve(RETRY_NOT_SUPPORTED);
const denyRetryPolicyNotEnabled: JobRetryPolicyAdapter =
  () => Promise.resolve(RETRY_POLICY_NOT_ENABLED);
const denyProviderRecoveryNotEnabled: JobRetryPolicyAdapter =
  () => Promise.resolve(PROVIDER_RECOVERY_NOT_ENABLED);

export function createJobRetryPolicyAdapters(
  enabledAdapters: Readonly<{
    rearmPendingStripeEvent: JobRetryPolicyAdapter;
    rearmFinancialClassification: JobRetryPolicyAdapter;
  }>
): ReadonlyMap<JobRetryPolicyAdapterId, JobRetryPolicyAdapter> {
  try {
    const record = exactDataRecord(enabledAdapters, ENABLED_ADAPTER_KEYS);
    const rearmPendingStripeEvent = record.rearmPendingStripeEvent;
    const rearmFinancialClassification = record.rearmFinancialClassification;
    if (
      typeof rearmPendingStripeEvent !== 'function' ||
      typeof rearmFinancialClassification !== 'function' ||
      isProxy(rearmPendingStripeEvent) ||
      isProxy(rearmFinancialClassification)
    ) return invalidIdentity();

    return new Map<JobRetryPolicyAdapterId, JobRetryPolicyAdapter>([
      ['deny_retry_not_supported', denyRetryNotSupported],
      ['deny_retry_policy_not_enabled', denyRetryPolicyNotEnabled],
      ['deny_provider_recovery_not_enabled', denyProviderRecoveryNotEnabled],
      ['rearm_pending_stripe_event', rearmPendingStripeEvent as JobRetryPolicyAdapter],
      [
        'rearm_financial_classification',
        rearmFinancialClassification as JobRetryPolicyAdapter
      ]
    ]);
  } catch {
    return invalidIdentity();
  }
}

export function validateJobRetryPolicyOutcome(
  definition: JobDefinition,
  outcome: JobRetryPolicyOutcome
): JobRetryPolicyOutcome {
  try {
    const policyId = policyIdFromDefinition(definition);
    const record = exactDataRecord(outcome, OUTCOME_KEYS);
    const status = record.status;
    const resultCode = record.resultCode;
    if (!isJobRetryPolicyOutcomeAllowed(policyId, status, resultCode)) {
      return invalidIdentity();
    }

    if (status === 'succeeded') {
      return Object.freeze({
        status,
        resultCode: resultCode as JobRetrySuccessResultCode
      });
    }
    if (status === 'denied') {
      return Object.freeze({
        status,
        resultCode: resultCode as JobRetryDenialResultCode
      });
    }
    if (status === 'failed' && resultCode === 'retry_command_invalid') {
      return Object.freeze({ status, resultCode });
    }
    return invalidIdentity();
  } catch {
    return invalidIdentity();
  }
}
