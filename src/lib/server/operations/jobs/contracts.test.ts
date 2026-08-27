import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  JOB_DEFINITIONS,
  REGISTERED_JOB_KINDS,
  type JobRetryDisposition,
  type JobRetryPolicyAvailability,
  type OperationalJobFailureCode,
  type OperationalJobStatus,
  type RegisteredJobKind
} from '../../jobs/catalog';
import {
  JobOperationsInputError,
  parseCanonicalOperationsUuid,
  parseJobRetryCommandStatusDto,
  parseOperationalJobDto,
  parseOperationalJobListInput,
  prepareJobRetryCommand,
  type JobRetryCommandInput,
  type JobRetryCommandStatusDto,
  type OperationalJobDto,
  type OperationalJobListInput,
  type PreparedJobRetryCommand
} from './contracts';

const UUID_1 = '00000000-0000-4000-8000-000000000101';
const UUID_2 = '00000000-0000-4000-8000-000000000202';
const UUID_3 = '00000000-0000-4000-8000-000000000303';
const TIMESTAMP_1 = '2026-08-26T14:15:16.123456Z';
const TIMESTAMP_2 = '2026-08-26T14:15:17.123456Z';
const TIMESTAMP_3 = '2026-08-26T14:15:18.123456Z';

const invalidValues = [null, undefined, true, 1, 'value', [], new Date(0), new Map(),
  new Set(), new Number(1)] as const;

function expectInvalid(operation: () => unknown): JobOperationsInputError {
  let thrown: unknown;
  try {
    operation();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(JobOperationsInputError);
  expect(thrown).toMatchObject({
    name: 'JobOperationsInputError',
    message: 'Invalid job operations input',
    code: 'invalid_input'
  });
  expect(Object.hasOwn(thrown as object, 'cause')).toBe(false);
  return thrown as JobOperationsInputError;
}

function expectFreshInvalid(operation: () => unknown): JobOperationsInputError {
  const first = expectInvalid(operation);
  const second = expectInvalid(operation);
  expect(first).not.toBe(second);
  return first;
}

function accessorRecord(
  source: Record<string, unknown>,
  key: string,
  onRead: () => never
): Record<string, unknown> {
  const output = { ...source };
  Object.defineProperty(output, key, { enumerable: true, get: onRead });
  return output;
}

function revokedRecord(): object {
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  return revocable.proxy;
}

function validJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: UUID_1,
    kind: 'commerce.stripe-event',
    label: 'Stripe event',
    status: 'failed',
    attempts: 12,
    maxAttempts: 12,
    runAt: TIMESTAMP_1,
    completedAt: TIMESTAMP_2,
    createdAt: TIMESTAMP_1,
    updatedAt: TIMESTAMP_2,
    retryDisposition: 'rearm_existing',
    policyAvailability: 'enabled',
    safeFailureCode: 'source_unavailable',
    ...overrides
  };
}

function validCommand(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idempotencyKey: UUID_2,
    targetJobId: UUID_1,
    expectedKind: 'commerce.stripe-event',
    expectedStatus: 'failed',
    expectedAttempts: 12,
    expectedMaxAttempts: 12,
    expectedUpdatedAt: TIMESTAMP_1,
    reasonCode: 'dependency_recovered',
    ...overrides
  };
}

function validStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commandId: UUID_2,
    kind: 'retry_failed_job',
    targetJobId: UUID_1,
    targetKind: 'commerce.stripe-event',
    reasonCode: 'dependency_recovered',
    correlationId: 'operations.retry:303',
    status: 'succeeded',
    resultCode: 'rearmed_existing',
    createdAt: TIMESTAMP_1,
    updatedAt: TIMESTAMP_2,
    completedAt: TIMESTAMP_3,
    ...overrides
  };
}

describe('public job operations contract types and runtime surface', () => {
  it('exposes the exact public runtime API without runtime type artifacts', async () => {
    const runtime = await import('./contracts');
    expect(Object.keys(runtime).sort()).toEqual([
      'JobOperationsInputError',
      'parseCanonicalOperationsUuid',
      'parseJobRetryCommandStatusDto',
      'parseOperationalJobDto',
      'parseOperationalJobListInput',
      'prepareJobRetryCommand'
    ]);

    expectTypeOf<OperationalJobListInput>().toEqualTypeOf<{
      readonly kind?: RegisteredJobKind;
      readonly status?: OperationalJobStatus;
      readonly limit: number;
      readonly cursor?: Readonly<{ readonly updatedAt: string; readonly jobId: string }>;
    }>();
    expectTypeOf<OperationalJobDto>().toEqualTypeOf<{
      readonly jobId: string;
      readonly kind: RegisteredJobKind | 'unregistered';
      readonly label: string;
      readonly status: OperationalJobStatus;
      readonly attempts: number;
      readonly maxAttempts: number;
      readonly runAt: string;
      readonly completedAt: string | null;
      readonly createdAt: string;
      readonly updatedAt: string;
      readonly retryDisposition: JobRetryDisposition;
      readonly policyAvailability: JobRetryPolicyAvailability;
      readonly safeFailureCode: OperationalJobFailureCode | null;
    }>();
    expectTypeOf<PreparedJobRetryCommand>().toEqualTypeOf<{
      readonly command: JobRetryCommandInput;
      readonly canonicalInput: string;
      readonly idempotencyKeySha256: string;
      readonly inputFingerprintSha256: string;
    }>();
  });

  it('constructs fresh nonreflective cause-free input errors', () => {
    const error = expectFreshInvalid(() => parseOperationalJobListInput(null));
    expect(error.code).toBe('invalid_input');
    expect(Object.keys(error)).toEqual(['code']);
  });

  it('rejects transparent and side-effecting proxies before invoking reflection traps', () => {
    const cases = [
      [parseOperationalJobListInput, {}],
      [parseOperationalJobDto, validJob()],
      [prepareJobRetryCommand, validCommand()],
      [parseJobRetryCommandStatusDto, validStatus()]
    ] as const;
    for (const [parse, source] of cases) {
      expectInvalid(() => parse(new Proxy(source, {})));
      let reflectionTraps = 0;
      const proxy = new Proxy(source, {
        getPrototypeOf: (target) => {
          reflectionTraps += 1;
          return Reflect.getPrototypeOf(target);
        },
        ownKeys: (target) => {
          reflectionTraps += 1;
          return Reflect.ownKeys(target);
        },
        getOwnPropertyDescriptor: (target, key) => {
          reflectionTraps += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        }
      });
      expectInvalid(() => parse(proxy));
      expect(reflectionTraps).toBe(0);
    }
  });

  it('rejects hostile own keys across every public record parser without reflecting values', () => {
    const cases: readonly [
      name: string,
      parse: (value: unknown) => unknown,
      source: Record<string, unknown>
    ][] = [
      ['list', parseOperationalJobListInput, {}],
      ['job', parseOperationalJobDto, validJob()],
      ['command', prepareJobRetryCommand, validCommand()],
      ['status', parseJobRetryCommandStatusDto, validStatus()]
    ];
    const prototypeNames = ['__proto__', 'constructor', 'toString'] as const;
    for (const [name, parse, source] of cases) {
      let reflectedValues = 0;
      const privateCanary = `${name}-reflected-private-canary`;
      const hostileValue = new Proxy({}, {
        get: () => {
          reflectedValues += 1;
          throw new Error(`${privateCanary}-get`);
        },
        getPrototypeOf: () => {
          reflectedValues += 1;
          throw new Error(`${privateCanary}-prototype`);
        },
        ownKeys: () => {
          reflectedValues += 1;
          throw new Error(`${privateCanary}-keys`);
        }
      });

      const symbolRecord = { ...source };
      Object.defineProperty(symbolRecord, Symbol(`${name}-private-symbol`), {
        enumerable: true,
        value: hostileValue
      });
      const symbolError = expectFreshInvalid(() => parse(symbolRecord));
      expect(symbolError.message).not.toContain(privateCanary);

      const nonenumerableRecord = { ...source };
      Object.defineProperty(nonenumerableRecord, `${name}PrivateHidden`, {
        enumerable: false,
        value: hostileValue
      });
      const nonenumerableError = expectFreshInvalid(() => parse(nonenumerableRecord));
      expect(nonenumerableError.message).not.toContain(privateCanary);

      for (const key of prototypeNames) {
        const prototypeNamedRecord = { ...source };
        Object.defineProperty(prototypeNamedRecord, key, {
          configurable: true,
          enumerable: true,
          value: hostileValue,
          writable: true
        });
        const error = expectFreshInvalid(() => parse(prototypeNamedRecord));
        expect(error.message).not.toContain(privateCanary);
      }
      expect(reflectedValues, name).toBe(0);
    }
  });
});

describe('parseCanonicalOperationsUuid', () => {
  it('accepts only exact lowercase canonical UUID text', () => {
    expect(parseCanonicalOperationsUuid(UUID_1)).toBe(UUID_1);
    for (const value of [
      'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      `{${UUID_1}}`,
      UUID_1.replaceAll('-', ''),
      'g0000000-0000-4000-8000-000000000101',
      '',
      null,
      new String(UUID_1)
    ]) expectInvalid(() => parseCanonicalOperationsUuid(value));
  });
});

describe('parseOperationalJobListInput', () => {
  it('materializes and freezes the default and accepts boundary limits', () => {
    const parsed = parseOperationalJobListInput({});
    expect(parsed).toEqual({ limit: 50 });
    expect(Object.isFrozen(parsed)).toBe(true);
    for (const limit of [1, 50, 100]) {
      expect(parseOperationalJobListInput({ limit })).toEqual({ limit });
    }
  });

  it('accepts exact registered kind/status filters and a copied frozen nested cursor', () => {
    for (const kind of REGISTERED_JOB_KINDS) {
      expect(parseOperationalJobListInput({ kind })).toEqual({ kind, limit: 50 });
    }
    for (const status of ['pending', 'running', 'succeeded', 'failed'] as const) {
      expect(parseOperationalJobListInput({ status })).toEqual({ status, limit: 50 });
    }
    const cursor = { updatedAt: TIMESTAMP_1, jobId: UUID_1 };
    const parsed = parseOperationalJobListInput({ kind: 'commerce.stripe-event', status: 'failed',
      limit: 100, cursor });
    expect(parsed).toEqual({ kind: 'commerce.stripe-event', status: 'failed', limit: 100, cursor });
    expect(parsed.cursor).not.toBe(cursor);
    expect(Object.isFrozen(parsed.cursor)).toBe(true);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it('rejects invalid limits, filters, null optionals, flat cursors, and unknown keys', () => {
    for (const limit of [0, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '50', null]) {
      expectInvalid(() => parseOperationalJobListInput({ limit }));
    }
    for (const value of [
      { kind: null }, { kind: 'unknown.kind' }, { status: null }, { status: 'queued' },
      { cursor: null }, { updatedAt: TIMESTAMP_1, jobId: UUID_1 },
      { offset: 0 }, { search: '' }, { text: '' }, { count: true }, { includeTotal: true },
      { payload: 'private' }
    ]) expectInvalid(() => parseOperationalJobListInput(value));
  });

  it('rejects partial, malformed, exotic, accessor, proxy, and cyclic cursors', () => {
    for (const cursor of [
      {},
      { updatedAt: TIMESTAMP_1 },
      { jobId: UUID_1 },
      { updatedAt: TIMESTAMP_1, jobId: UUID_1, extra: true },
      { updatedAt: '2026-02-29T00:00:00.000000Z', jobId: UUID_1 },
      { updatedAt: TIMESTAMP_1, jobId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
      [],
      new Date(),
      new (class Cursor { updatedAt = TIMESTAMP_1; jobId = UUID_1; })(),
      revokedRecord()
    ]) expectInvalid(() => parseOperationalJobListInput({ cursor }));

    let reads = 0;
    const accessor = accessorRecord({ updatedAt: TIMESTAMP_1, jobId: UUID_1 }, 'jobId', () => {
      reads += 1;
      throw new Error('cursor-private-canary');
    });
    expectInvalid(() => parseOperationalJobListInput({ cursor: accessor }));
    expect(reads).toBe(0);

    const cyclic: Record<string, unknown> = { updatedAt: TIMESTAMP_1, jobId: UUID_1 };
    cyclic.extra = cyclic;
    expectInvalid(() => parseOperationalJobListInput({ cursor: cyclic }));
  });

  it('rejects non-record top levels and hostile reflection without leaking causes', () => {
    for (const value of invalidValues) expectInvalid(() => parseOperationalJobListInput(value));
    const proxy = new Proxy({}, {
      getPrototypeOf: () => { throw new Error('top-level-private-canary'); }
    });
    const error = expectInvalid(() => parseOperationalJobListInput(proxy));
    expect(error.message).not.toContain('private-canary');
  });
});

describe('timestamp validation', () => {
  it('accepts leap days and rejects lexical/calendar/time invalidity without Date coercion', () => {
    const valid = [
      '0001-01-01T00:00:00.000000Z',
      '2000-02-29T23:59:59.999999Z',
      '2024-02-29T00:00:00.000001Z',
      '9999-12-31T23:59:59.999999Z'
    ];
    for (const updatedAt of valid) {
      expect(parseOperationalJobListInput({ cursor: { updatedAt, jobId: UUID_1 } }).cursor?.updatedAt)
        .toBe(updatedAt);
    }

    const invalid = [
      '0000-01-01T00:00:00.000000Z',
      '1900-02-29T00:00:00.000000Z',
      '2026-02-29T00:00:00.000000Z',
      '2026-04-31T00:00:00.000000Z',
      '2026-00-01T00:00:00.000000Z',
      '2026-13-01T00:00:00.000000Z',
      '2026-01-00T00:00:00.000000Z',
      '2026-01-32T00:00:00.000000Z',
      '2026-01-01T24:00:00.000000Z',
      '2026-01-01T23:60:00.000000Z',
      '2026-01-01T23:59:60.000000Z',
      '2026-01-01T00:00:00.00000Z',
      '2026-01-01T00:00:00.0000000Z',
      '2026-01-01t00:00:00.000000Z',
      '2026-01-01T00:00:00.000000z',
      '2026-01-01T00:00:00.000000+00:00',
      ' 2026-01-01T00:00:00.000000Z'
    ];
    for (const updatedAt of invalid) {
      expectInvalid(() => parseOperationalJobListInput({ cursor: { updatedAt, jobId: UUID_1 } }));
    }
  });
});

describe('parseOperationalJobDto', () => {
  it('reconstructs an exact frozen registered row against every catalog definition', () => {
    for (const definition of JOB_DEFINITIONS) {
      const source = validJob({
        kind: definition.kind,
        label: definition.label,
        maxAttempts: definition.maxAttempts,
        attempts: definition.maxAttempts,
        retryDisposition: definition.retryDisposition,
        policyAvailability: definition.retryPolicyAvailability,
        safeFailureCode: null
      });
      const parsed = parseOperationalJobDto(source);
      expect(parsed).toEqual(source);
      expect(parsed).not.toBe(source);
      expect(Object.isFrozen(parsed)).toBe(true);
    }
  });

  it('accepts only the selected kind safe failure vocabulary', () => {
    const allowedByKind: Readonly<Record<RegisteredJobKind, readonly OperationalJobFailureCode[]>> = {
      'outbox.dispatch': ['invalid_job_identity', 'source_unavailable', 'unexpected_failure'],
      'commerce.claim-email': [
        'invalid_job_identity', 'domain_state_not_retryable', 'unexpected_failure'
      ],
      'commerce.claim-email-request': [
        'invalid_job_identity', 'domain_state_not_retryable', 'unexpected_failure'
      ],
      'commerce.stripe-event': [
        'invalid_job_identity', 'source_unavailable', 'unexpected_failure'
      ],
      'commerce.financial-source': [
        'invalid_job_identity', 'domain_state_not_retryable', 'unexpected_failure'
      ],
      'commerce.financial-payout': [
        'invalid_job_identity', 'domain_state_not_retryable', 'unexpected_failure'
      ],
      'commerce.financial-scan': [
        'invalid_job_identity', 'domain_state_not_retryable', 'unexpected_failure'
      ],
      'commerce.financial-classification': [
        'invalid_job_identity', 'domain_state_not_retryable', 'unexpected_failure'
      ],
      'commerce.financial-admin-command': [
        'invalid_job_identity', 'domain_state_not_retryable', 'unexpected_failure'
      ],
      'catalog.ingest_revision': [
        'invalid_job_identity', 'source_unavailable', 'unexpected_failure'
      ],
      'operations.job-retry-command': [
        'invalid_job_identity', 'retry_command_exhausted', 'unexpected_failure'
      ]
    };
    const globallyKnown = [
      'unregistered_job_kind', 'invalid_job_identity', 'source_unavailable',
      'domain_state_not_retryable', 'retry_command_exhausted', 'unexpected_failure'
    ] as const;
    for (const definition of JOB_DEFINITIONS) {
      const row = {
        kind: definition.kind,
        label: definition.label,
        attempts: definition.maxAttempts,
        maxAttempts: definition.maxAttempts,
        retryDisposition: definition.retryDisposition,
        policyAvailability: definition.retryPolicyAvailability
      };
      expect(parseOperationalJobDto(validJob({ ...row, safeFailureCode: null })).safeFailureCode)
        .toBeNull();
      for (const safeFailureCode of allowedByKind[definition.kind]) {
        expect(parseOperationalJobDto(validJob({ ...row, safeFailureCode })).safeFailureCode)
          .toBe(safeFailureCode);
      }
      for (const safeFailureCode of globallyKnown.filter(
        (candidate) => !allowedByKind[definition.kind].includes(candidate)
      )) expectInvalid(() => parseOperationalJobDto(validJob({ ...row, safeFailureCode })));
    }
    for (const safeFailureCode of ['raw_provider_error', '', 1, undefined]) {
      expectInvalid(() => parseOperationalJobDto(validJob({ safeFailureCode })));
    }
  });

  it('reconstructs only the fixed unregistered sentinel', () => {
    const source = validJob({
      kind: 'unregistered',
      label: 'Unregistered job',
      attempts: 2,
      maxAttempts: 3,
      retryDisposition: 'never',
      policyAvailability: 'excluded',
      safeFailureCode: 'unregistered_job_kind'
    });
    expect(parseOperationalJobDto(source)).toEqual(source);
    for (const changes of [
      { label: 'Unknown job' },
      { retryDisposition: 'rearm_existing' },
      { policyAvailability: 'disabled' },
      { safeFailureCode: 'unexpected_failure' },
      { maxAttempts: 0 },
      { attempts: 4 }
    ]) expectInvalid(() => parseOperationalJobDto({ ...source, ...changes }));
  });

  it('rejects catalog mismatches, invalid attempts/status/timestamps/nullable completion', () => {
    for (const changes of [
      { label: 'Stripe webhook' },
      { maxAttempts: 11 },
      { retryDisposition: 'enqueue_successor' },
      { policyAvailability: 'disabled' },
      { status: 'queued' },
      { attempts: -1 },
      { attempts: 13 },
      { attempts: 2.5 },
      { maxAttempts: 2_147_483_648 },
      { runAt: null },
      { runAt: 'not-a-timestamp' },
      { completedAt: undefined },
      { completedAt: '2026-02-29T00:00:00.000000Z' },
      { createdAt: new Date() },
      { updatedAt: TIMESTAMP_1.toLowerCase() }
    ]) expectInvalid(() => parseOperationalJobDto(validJob(changes)));
    expect(parseOperationalJobDto(validJob({ completedAt: null })).completedAt).toBeNull();
  });

  it('rejects private fields, unknown keys, inherited fields, accessors, exotic records and proxies', () => {
    for (const key of [
      'payload', 'deduplicationKey', 'lastError', 'rawError', 'lockedBy', 'lockedAt', 'lease',
      'provider', 'actor', 'expected', 'input', 'hash'
    ]) expectInvalid(() => parseOperationalJobDto({ ...validJob(), [key]: 'private' }));

    const inherited = Object.create({ jobId: UUID_1 }) as Record<string, unknown>;
    Object.assign(inherited, validJob());
    delete inherited.jobId;
    expectInvalid(() => parseOperationalJobDto(inherited));

    let reads = 0;
    const accessor = accessorRecord(validJob(), 'safeFailureCode', () => {
      reads += 1;
      throw new Error('job-private-canary');
    });
    expectInvalid(() => parseOperationalJobDto(accessor));
    expect(reads).toBe(0);

    for (const value of [[], new (class Job {} )(), revokedRecord()]) {
      expectInvalid(() => parseOperationalJobDto(value));
    }
  });
});

describe('prepareJobRetryCommand', () => {
  it('creates the exact canonical witness and SHA-256 hashes with copied frozen output', () => {
    const source = validCommand();
    const prepared = prepareJobRetryCommand(source);
    expect(prepared).toEqual({
      command: source,
      canonicalInput: '{"targetJobId":"00000000-0000-4000-8000-000000000101",' +
        '"expectedKind":"commerce.stripe-event","expectedStatus":"failed",' +
        '"expectedAttempts":12,"expectedMaxAttempts":12,' +
        '"expectedUpdatedAt":"2026-08-26T14:15:16.123456Z",' +
        '"reasonCode":"dependency_recovered"}',
      inputFingerprintSha256: 'e6df7201a7ee2edc48002ab36dfafe042c6f45091bb32d97a14fc863bc04bd1e',
      idempotencyKeySha256: '1a4832b559a43c0d8c0d857fadbf9bc1b6325c144e28b0c9f909d84196cd8220'
    });
    expect(prepared.command).not.toBe(source);
    expect(Object.isFrozen(prepared.command)).toBe(true);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(prepared.canonicalInput).not.toContain('idempotencyKey');
    expect(prepared.canonicalInput).not.toContain('correlation');
  });

  it('changes the fingerprint for every canonical command field but not just the idempotency key', () => {
    const baseline = prepareJobRetryCommand(validCommand());
    const alternatives = [
      { targetJobId: UUID_3 },
      { expectedKind: 'commerce.financial-classification', expectedAttempts: 5,
        expectedMaxAttempts: 5 },
      { expectedAttempts: 11 },
      { expectedUpdatedAt: TIMESTAMP_2 },
      { reasonCode: 'configuration_recovered' }
    ];
    for (const change of alternatives) {
      expect(prepareJobRetryCommand(validCommand(change)).inputFingerprintSha256)
        .not.toBe(baseline.inputFingerprintSha256);
    }
    const idempotencyChange = prepareJobRetryCommand(validCommand({ idempotencyKey: UUID_3 }));
    expect(idempotencyChange.inputFingerprintSha256).toBe(baseline.inputFingerprintSha256);
    expect(idempotencyChange.idempotencyKeySha256).not.toBe(baseline.idempotencyKeySha256);
  });

  it('accepts exact reasons and strict catalog identities', () => {
    for (const reasonCode of [
      'dependency_recovered', 'configuration_recovered', 'operator_reassessment'
    ]) expect(prepareJobRetryCommand(validCommand({ reasonCode })).command.reasonCode)
      .toBe(reasonCode);

    for (const definition of JOB_DEFINITIONS) {
      const prepared = prepareJobRetryCommand(validCommand({
        expectedKind: definition.kind,
        expectedAttempts: definition.maxAttempts,
        expectedMaxAttempts: definition.maxAttempts
      }));
      expect(prepared.command.expectedKind).toBe(definition.kind);
    }
  });

  it('rejects status, attempt, catalog, timestamp, reason, identity, and extra-field violations', () => {
    for (const changes of [
      { idempotencyKey: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
      { targetJobId: 'not-a-uuid' },
      { expectedKind: 'unregistered' },
      { expectedStatus: 'running' },
      { expectedAttempts: 0 },
      { expectedAttempts: -1 },
      { expectedAttempts: 13 },
      { expectedAttempts: 1.5 },
      { expectedMaxAttempts: 11 },
      { expectedMaxAttempts: 2_147_483_648 },
      { expectedUpdatedAt: '2026-02-29T00:00:00.000000Z' },
      { reasonCode: 'operator_override' },
      { correlationId: 'not-part-of-input' },
      { actor: 'private' },
      { hash: 'caller-controlled' }
    ]) expectInvalid(() => prepareJobRetryCommand(validCommand(changes)));
  });

  it('rejects accessors, inherited fields, cycles, exotic values, and hostile proxies cause-free', () => {
    let reads = 0;
    const accessor = accessorRecord(validCommand(), 'targetJobId', () => {
      reads += 1;
      throw new Error('command-private-canary');
    });
    expectInvalid(() => prepareJobRetryCommand(accessor));
    expect(reads).toBe(0);

    const inherited = Object.create({ expectedStatus: 'failed' }) as Record<string, unknown>;
    Object.assign(inherited, validCommand());
    delete inherited.expectedStatus;
    expectInvalid(() => prepareJobRetryCommand(inherited));

    const cycle = validCommand();
    cycle.extra = cycle;
    expectInvalid(() => prepareJobRetryCommand(cycle));
    for (const value of [...invalidValues, revokedRecord()]) expectInvalid(() => prepareJobRetryCommand(value));
  });
});

describe('parseJobRetryCommandStatusDto', () => {
  it('reconstructs exact frozen pending status with null result and completion', () => {
    const source = validStatus({ status: 'pending', resultCode: null, completedAt: null });
    const parsed = parseJobRetryCommandStatusDto(source);
    expect(parsed).toEqual(source);
    expect(parsed).not.toBe(source);
    expect(Object.isFrozen(parsed)).toBe(true);
    expectTypeOf(parsed).toEqualTypeOf<JobRetryCommandStatusDto>();
  });

  it('accepts catalog policy outcomes and global authorization/common failures', () => {
    const accepted = [
      ['commerce.stripe-event', 'succeeded', 'rearmed_existing'],
      ['commerce.stripe-event', 'denied', 'target_state_changed'],
      ['commerce.stripe-event', 'denied', 'domain_state_not_retryable'],
      ['commerce.stripe-event', 'denied', 'source_unavailable'],
      ['commerce.financial-classification', 'succeeded', 'rearmed_existing'],
      ['outbox.dispatch', 'denied', 'retry_policy_not_enabled'],
      ['commerce.financial-admin-command', 'denied', 'retry_not_supported'],
      ['outbox.dispatch', 'denied', 'actor_not_authorized'],
      ['commerce.financial-admin-command', 'failed', 'retry_command_invalid'],
      ['commerce.claim-email', 'failed', 'retry_command_exhausted'],
      ['catalog.ingest_revision', 'failed', 'unexpected_failure']
    ] as const;
    for (const [targetKind, status, resultCode] of accepted) {
      const parsed = parseJobRetryCommandStatusDto(validStatus({ targetKind, status, resultCode }));
      expect(parsed.status).toBe(status);
      expect(parsed.resultCode).toBe(resultCode);
    }
  });

  it('rejects globally named outcomes that the selected production policy cannot emit', () => {
    const rejected = [
      ['commerce.stripe-event', 'succeeded', 'successor_enqueued'],
      ['commerce.stripe-event', 'succeeded', 'already_current'],
      ['commerce.stripe-event', 'denied', 'target_not_failed'],
      ['outbox.dispatch', 'denied', 'target_state_changed'],
      ['commerce.financial-admin-command', 'succeeded', 'rearmed_existing'],
      ['commerce.financial-classification', 'denied', 'retry_policy_not_enabled'],
      ['outbox.dispatch', 'succeeded', 'rearmed_existing']
    ] as const;
    for (const [targetKind, status, resultCode] of rejected) {
      expectInvalid(() => parseJobRetryCommandStatusDto(
        validStatus({ targetKind, status, resultCode })
      ));
    }
  });

  it('enforces pending/terminal result and completion families', () => {
    for (const changes of [
      { status: 'pending', resultCode: 'rearmed_existing', completedAt: null },
      { status: 'pending', resultCode: null, completedAt: TIMESTAMP_3 },
      { status: 'succeeded', resultCode: null },
      { status: 'succeeded', completedAt: null },
      { status: 'succeeded', resultCode: 'target_state_changed' },
      { status: 'denied', resultCode: 'rearmed_existing' },
      { status: 'failed', resultCode: 'source_unavailable' },
      { status: 'cancelled', resultCode: null, completedAt: null }
    ]) expectInvalid(() => parseJobRetryCommandStatusDto(validStatus(changes)));
  });

  it('rejects malformed identity, kind, reason, correlation, timestamps, private data and extras', () => {
    for (const changes of [
      { commandId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
      { targetJobId: 'not-a-uuid' },
      { kind: 'retry_job' },
      { targetKind: 'unregistered' },
      { reasonCode: 'manual' },
      { correlationId: '' },
      { correlationId: 'x'.repeat(101) },
      { correlationId: 'contains space' },
      { createdAt: 'not-a-timestamp' },
      { updatedAt: '2026-02-29T00:00:00.000000Z' },
      { completedAt: new Date() },
      { actor: 'private' },
      { payload: {} },
      { expectedStatus: 'failed' },
      { inputFingerprintSha256: 'private' },
      { deduplicationKey: 'private' },
      { rawError: 'private' },
      { lease: 'private' },
      { provider: 'private' }
    ]) expectInvalid(() => parseJobRetryCommandStatusDto(validStatus(changes)));
  });

  it('rejects accessors, inherited fields, cycles, exotic values and hostile proxies', () => {
    let reads = 0;
    const accessor = accessorRecord(validStatus(), 'correlationId', () => {
      reads += 1;
      throw new Error('status-private-canary');
    });
    expectInvalid(() => parseJobRetryCommandStatusDto(accessor));
    expect(reads).toBe(0);

    const inherited = Object.create({ kind: 'retry_failed_job' }) as Record<string, unknown>;
    Object.assign(inherited, validStatus());
    delete inherited.kind;
    expectInvalid(() => parseJobRetryCommandStatusDto(inherited));
    const cycle = validStatus();
    cycle.extra = cycle;
    expectInvalid(() => parseJobRetryCommandStatusDto(cycle));
    for (const value of [...invalidValues, revokedRecord()]) {
      expectInvalid(() => parseJobRetryCommandStatusDto(value));
    }
  });
});
