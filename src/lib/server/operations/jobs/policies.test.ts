import { describe, expect, expectTypeOf, it } from 'vitest';

import type { DatabaseTransaction } from '../../db/transaction';
import {
  JOB_DEFINITIONS,
  JOB_RETRY_COMMAND_RESULT_CODES,
  JOB_RETRY_POLICY_IDS,
  JOB_RETRY_POLICY_OUTCOMES,
  type JobDefinition,
  type JobRetryPolicyId,
  type RegisteredJobKind
} from '../../jobs/catalog';
import type {
  JobRetryDenialResultCode,
  JobRetryFailureResultCode,
  JobRetrySuccessResultCode
} from './contracts';
import {
  createJobRetryPolicyAdapters,
  InvalidJobRetryPolicyIdentityError,
  validateJobRetryPolicyOutcome,
  type JobRetryPolicyAdapter,
  type JobRetryPolicyAdapterId,
  type JobRetryPolicyContext,
  type JobRetryPolicyOutcome,
  type JobRetryPolicyTarget
} from './policies';

const ERROR_MESSAGE = 'Invalid job retry policy identity';

const succeeded = (): JobRetryPolicyOutcome => Object.freeze({
  status: 'succeeded',
  resultCode: 'rearmed_existing'
});

const denied = (): JobRetryPolicyOutcome => Object.freeze({
  status: 'denied',
  resultCode: 'domain_state_not_retryable'
});

const createEnabledAdapters = () => ({
  rearmFinancialClassification: async (): Promise<JobRetryPolicyOutcome> => denied(),
  rearmPendingStripeEvent: async (): Promise<JobRetryPolicyOutcome> => succeeded()
});

const expectIdentityError = (work: () => unknown): void => {
  try {
    work();
    throw new Error('Expected the policy identity to be rejected');
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidJobRetryPolicyIdentityError);
    expect(error).toMatchObject({
      name: 'InvalidJobRetryPolicyIdentityError',
      message: ERROR_MESSAGE
    });
    expect(error).not.toHaveProperty('cause');
  }
};

const definitionForPolicy = (policyId: JobRetryPolicyId): JobDefinition => {
  const selected = JOB_DEFINITIONS.find((definition) => definition.retryPolicyId === policyId);
  if (selected !== undefined) return selected;

  return Object.freeze({
    ...JOB_DEFINITIONS[0],
    retryPolicyId: policyId
  });
};

describe('job retry policy contracts', () => {
  it('exports the exact narrow target, context, outcome, adapter, and identifier types', () => {
    type ExpectedTarget = {
      readonly commandId: string;
      readonly targetJobId: string;
      readonly expectedKind: RegisteredJobKind;
      readonly expectedStatus: 'failed';
      readonly expectedAttempts: number;
      readonly expectedMaxAttempts: number;
      readonly expectedUpdatedAt: string;
    };
    type ExpectedContext = {
      readonly transaction: DatabaseTransaction;
      readonly target: JobRetryPolicyTarget;
      readonly signal: AbortSignal;
    };
    type ExpectedOutcome =
      | Readonly<{ status: 'succeeded'; resultCode: JobRetrySuccessResultCode }>
      | Readonly<{ status: 'denied'; resultCode: JobRetryDenialResultCode }>
      | Readonly<{
          status: 'failed';
          resultCode: Extract<JobRetryFailureResultCode, 'retry_command_invalid'>;
        }>;
    type ExpectedAdapter =
      (context: JobRetryPolicyContext) => Promise<JobRetryPolicyOutcome>;
    type ExpectedEnabledAdapters = Readonly<{
      rearmPendingStripeEvent: JobRetryPolicyAdapter;
      rearmFinancialClassification: JobRetryPolicyAdapter;
    }>;

    expectTypeOf<JobRetryPolicyTarget>().toEqualTypeOf<ExpectedTarget>();
    expectTypeOf<JobRetryPolicyContext>().toEqualTypeOf<ExpectedContext>();
    expectTypeOf<JobRetryPolicyOutcome>().toEqualTypeOf<ExpectedOutcome>();
    expectTypeOf<JobRetryPolicyAdapter>().toEqualTypeOf<ExpectedAdapter>();
    expectTypeOf<JobRetryPolicyAdapterId>().toEqualTypeOf<JobRetryPolicyId>();
    expectTypeOf<Parameters<typeof createJobRetryPolicyAdapters>[0]>()
      .toEqualTypeOf<ExpectedEnabledAdapters>();
    expectTypeOf<ReturnType<typeof createJobRetryPolicyAdapters>>()
      .toEqualTypeOf<ReadonlyMap<JobRetryPolicyAdapterId, JobRetryPolicyAdapter>>();
  });

  it('constructs a copied read-only map in canonical five-policy order', () => {
    const enabled = createEnabledAdapters();
    const stripe = enabled.rearmPendingStripeEvent;
    const classification = enabled.rearmFinancialClassification;

    const policies = createJobRetryPolicyAdapters(enabled);

    expect([...policies.keys()]).toEqual(JOB_RETRY_POLICY_IDS);
    expect(policies).toBeInstanceOf(Map);
    expect(policies).not.toBe(enabled);
    expect(policies.get('rearm_pending_stripe_event')).toBe(stripe);
    expect(policies.get('rearm_financial_classification')).toBe(classification);

    enabled.rearmPendingStripeEvent = async () => denied();
    enabled.rearmFinancialClassification = async () => succeeded();
    expect(policies.get('rearm_pending_stripe_event')).toBe(stripe);
    expect(policies.get('rearm_financial_classification')).toBe(classification);
    expect([...policies.keys()]).toEqual(JOB_RETRY_POLICY_IDS);
  });

  it('rejects missing, extra, symbolic, and nonfunction enabled adapter identities', () => {
    const enabled = createEnabledAdapters();
    const symbol = Symbol('extra policy');
    const malformed: unknown[] = [
      undefined,
      null,
      [],
      () => undefined,
      {},
      { rearmPendingStripeEvent: enabled.rearmPendingStripeEvent },
      { rearmFinancialClassification: enabled.rearmFinancialClassification },
      { ...enabled, extra: async () => succeeded() },
      { ...enabled, [symbol]: async () => succeeded() },
      { ...enabled, rearmPendingStripeEvent: undefined },
      { ...enabled, rearmPendingStripeEvent: null },
      { ...enabled, rearmPendingStripeEvent: {} },
      { ...enabled, rearmFinancialClassification: 'adapter' },
      Object.create(enabled),
      new (class EnabledAdapters {
        readonly rearmPendingStripeEvent = enabled.rearmPendingStripeEvent;
        readonly rearmFinancialClassification = enabled.rearmFinancialClassification;
      })()
    ];

    for (const value of malformed) {
      expectIdentityError(() => createJobRetryPolicyAdapters(
        value as Parameters<typeof createJobRetryPolicyAdapters>[0]
      ));
    }
  });

  it('rejects accessors without invoking them', () => {
    let stripeReads = 0;
    let classificationReads = 0;
    const accessors = Object.defineProperties({}, {
      rearmPendingStripeEvent: {
        enumerable: true,
        get: () => {
          stripeReads += 1;
          throw new Error('stripe accessor canary');
        }
      },
      rearmFinancialClassification: {
        enumerable: true,
        get: () => {
          classificationReads += 1;
          throw new Error('classification accessor canary');
        }
      }
    });

    expectIdentityError(() => createJobRetryPolicyAdapters(
      accessors as Parameters<typeof createJobRetryPolicyAdapters>[0]
    ));
    expect(stripeReads).toBe(0);
    expect(classificationReads).toBe(0);
  });

  it('rejects live and revoked proxies without exposing or invoking proxy traps', () => {
    let trapCalls = 0;
    const trapError = new Error('proxy trap canary');
    const liveProxy = new Proxy(createEnabledAdapters(), {
      getOwnPropertyDescriptor: () => {
        trapCalls += 1;
        throw trapError;
      },
      ownKeys: () => {
        trapCalls += 1;
        throw trapError;
      }
    });
    const revoked = Proxy.revocable(createEnabledAdapters(), {});
    revoked.revoke();

    expectIdentityError(() => createJobRetryPolicyAdapters(liveProxy));
    expectIdentityError(() => createJobRetryPolicyAdapters(revoked.proxy));
    expect(trapCalls).toBe(0);
  });

  it('rejects proxied enabled functions without invoking their traps', () => {
    const enabled = createEnabledAdapters();
    let applyCalls = 0;
    const proxiedAdapter = new Proxy(enabled.rearmPendingStripeEvent, {
      apply: () => {
        applyCalls += 1;
        throw new Error('adapter proxy canary');
      }
    });
    const revokedAdapter = Proxy.revocable(enabled.rearmFinancialClassification, {});
    revokedAdapter.revoke();

    expectIdentityError(() => createJobRetryPolicyAdapters({
      ...enabled,
      rearmPendingStripeEvent: proxiedAdapter
    }));
    expectIdentityError(() => createJobRetryPolicyAdapters({
      ...enabled,
      rearmFinancialClassification: revokedAdapter.proxy
    }));
    expect(applyCalls).toBe(0);
  });

  it('returns the three exact immutable fixed denials without inspecting context', async () => {
    const policies = createJobRetryPolicyAdapters(createEnabledAdapters());
    let reads = 0;
    const context = new Proxy({}, {
      get: () => {
        reads += 1;
        throw new Error('policy context canary');
      }
    }) as JobRetryPolicyContext;
    const expected = [
      ['deny_retry_not_supported', 'retry_not_supported'],
      ['deny_retry_policy_not_enabled', 'retry_policy_not_enabled'],
      ['deny_provider_recovery_not_enabled', 'provider_recovery_not_enabled']
    ] as const;

    for (const [policyId, resultCode] of expected) {
      const outcome = await policies.get(policyId)!(context);
      expect(outcome).toEqual({ status: 'denied', resultCode });
      expect(Reflect.ownKeys(outcome)).toEqual(['status', 'resultCode']);
      expect(Object.isFrozen(outcome)).toBe(true);
    }
    expect(reads).toBe(0);
  });

  it('exports the exact no-cause policy identity error', () => {
    const error = new InvalidJobRetryPolicyIdentityError();

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('InvalidJobRetryPolicyIdentityError');
    expect(error.message).toBe(ERROR_MESSAGE);
    expect(error).not.toHaveProperty('cause');
  });
});

describe('validateJobRetryPolicyOutcome', () => {
  it('accepts exactly the Task 2 matrix and reconstructs fresh frozen outcomes', () => {
    const statuses = ['succeeded', 'denied', 'failed'] as const;

    for (const policyId of JOB_RETRY_POLICY_IDS) {
      const definition = definitionForPolicy(policyId);
      for (const status of statuses) {
        for (const resultCode of JOB_RETRY_COMMAND_RESULT_CODES) {
          const source = { status, resultCode };
          const allowed = JOB_RETRY_POLICY_OUTCOMES.some((candidate) =>
            candidate[0] === policyId &&
            candidate[1] === status &&
            candidate[2] === resultCode
          );

          if (!allowed) {
            expectIdentityError(() => validateJobRetryPolicyOutcome(
              definition,
              source as JobRetryPolicyOutcome
            ));
            continue;
          }

          const outcome = validateJobRetryPolicyOutcome(
            definition,
            source as JobRetryPolicyOutcome
          );
          expect(outcome).toEqual(source);
          expect(outcome).not.toBe(source);
          expect(Reflect.ownKeys(outcome)).toEqual(['status', 'resultCode']);
          expect(Object.isFrozen(outcome)).toBe(true);
        }
      }
    }
  });

  it('keeps actor demotion, non-emitted vocabulary, and early failures outside adapters', () => {
    const outsideAdapterOutcomes = [
      { status: 'denied', resultCode: 'actor_not_authorized' },
      { status: 'failed', resultCode: 'retry_command_exhausted' },
      { status: 'failed', resultCode: 'unexpected_failure' },
      { status: 'succeeded', resultCode: 'successor_enqueued' },
      { status: 'succeeded', resultCode: 'already_current' },
      { status: 'denied', resultCode: 'target_not_failed' }
    ];

    for (const definition of JOB_DEFINITIONS) {
      for (const outcome of outsideAdapterOutcomes) {
        expectIdentityError(() => validateJobRetryPolicyOutcome(
          definition,
          outcome as JobRetryPolicyOutcome
        ));
      }
    }
  });

  it('rejects malformed outcome shapes, accessors, and proxies without reflecting them', () => {
    const definition = definitionForPolicy('rearm_pending_stripe_event');
    const malformed: unknown[] = [
      undefined,
      null,
      [],
      {},
      { status: 'succeeded' },
      { resultCode: 'rearmed_existing' },
      { status: 'succeeded', resultCode: 'rearmed_existing', extra: true },
      Object.create({ status: 'succeeded', resultCode: 'rearmed_existing' })
    ];
    for (const value of malformed) {
      expectIdentityError(() => validateJobRetryPolicyOutcome(
        definition,
        value as JobRetryPolicyOutcome
      ));
    }

    let reads = 0;
    const accessor = Object.defineProperties({}, {
      status: {
        enumerable: true,
        get: () => {
          reads += 1;
          throw new Error('status accessor canary');
        }
      },
      resultCode: {
        enumerable: true,
        value: 'rearmed_existing'
      }
    });
    expectIdentityError(() => validateJobRetryPolicyOutcome(
      definition,
      accessor as JobRetryPolicyOutcome
    ));
    expect(reads).toBe(0);

    let trapCalls = 0;
    const proxy = new Proxy({ status: 'succeeded', resultCode: 'rearmed_existing' }, {
      ownKeys: () => {
        trapCalls += 1;
        throw new Error('outcome proxy canary');
      }
    });
    const revoked = Proxy.revocable(
      { status: 'succeeded', resultCode: 'rearmed_existing' },
      {}
    );
    revoked.revoke();
    expectIdentityError(() => validateJobRetryPolicyOutcome(
      definition,
      proxy as JobRetryPolicyOutcome
    ));
    expectIdentityError(() => validateJobRetryPolicyOutcome(
      definition,
      revoked.proxy as JobRetryPolicyOutcome
    ));
    expect(trapCalls).toBe(0);
  });
});
