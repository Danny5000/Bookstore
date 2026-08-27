import { z } from 'zod';
import {
  FINANCIAL_CLASSIFICATION_JOB,
  FINANCIAL_PAYOUT_JOB,
  FINANCIAL_SCAN_JOB,
  FINANCIAL_SOURCE_JOB
} from '$lib/server/jobs/catalog';
import {
  FINANCIAL_CLASSIFICATION_JOB_MAX_ATTEMPTS,
  FINANCIAL_GENERATION_MAX,
  FINANCIAL_PAYOUT_JOB_MAX_ATTEMPTS,
  FINANCIAL_SCAN_JOB_MAX_ATTEMPTS,
  FINANCIAL_SOURCE_JOB_MAX_ATTEMPTS
} from './constants';
import { PermanentFinancialError } from './errors';

export {
  FINANCIAL_CLASSIFICATION_JOB,
  FINANCIAL_PAYOUT_JOB,
  FINANCIAL_SCAN_JOB,
  FINANCIAL_SOURCE_JOB
} from '$lib/server/jobs/catalog';

const sourceKindSchema = z.enum(['payment', 'refund', 'dispute']);
const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
const eventIdSchema = z.string().min(5).max(255).regex(/^evt_[A-Za-z0-9_-]+$/u);
const payoutProviderIdSchema = z.string().min(4).max(255).regex(/^po_[A-Za-z0-9_-]+$/u);
const sha256Schema = z.string().length(64).regex(/^[a-f0-9]{64}$/u);
const positiveInt32Schema = z.number().int().min(1).max(FINANCIAL_GENERATION_MAX);
const nonnegativeInt32Schema = z.number().int().min(0).max(FINANCIAL_GENERATION_MAX);
const pageLimitSchema = z.number().int().min(1).max(100);
const utcHourSchema = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):00:00\.000Z$/u)
  .refine((value) => {
    if (value.startsWith('0000-')) return false;
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
  });
const scanPhaseSchema = z.enum([
  'source_page',
  'payout_discovery_page',
  'incomplete_payout_run_page',
  'payout_impact_page',
  'classification_replay_page',
  'classification_replay_finalize'
]);
const subjectTypeSchema = z.enum(['balance_transaction', 'fee_detail']);

const sourceEventPayloadSchema = z.strictObject({
  sourceKind: sourceKindSchema,
  sourceId: uuidSchema,
  trigger: z.strictObject({
    kind: z.literal('event'),
    providerEventId: eventIdSchema
  })
});
const sourceGraphPayloadSchema = z.strictObject({
  sourceKind: sourceKindSchema,
  sourceId: uuidSchema,
  trigger: z.strictObject({
    kind: z.literal('graph'),
    providerEventId: eventIdSchema
  })
});
const sourceScanPayloadSchema = z.strictObject({
  sourceKind: sourceKindSchema,
  sourceId: uuidSchema,
  trigger: z.strictObject({
    kind: z.literal('scan'),
    scanRunId: uuidSchema,
    scanGenerationHour: utcHourSchema
  })
});
const sourcePayoutImpactPayloadSchema = z.strictObject({
  sourceKind: sourceKindSchema,
  sourceId: uuidSchema,
  trigger: z.strictObject({
    kind: z.literal('payout_impact'),
    payoutId: uuidSchema,
    payoutGeneration: positiveInt32Schema
  })
});

const payoutEventPayloadSchema = z.strictObject({
  providerPayoutId: payoutProviderIdSchema,
  trigger: z.strictObject({
    kind: z.literal('event'),
    providerEventId: eventIdSchema
  })
});
const payoutScanPayloadSchema = z.strictObject({
  providerPayoutId: payoutProviderIdSchema,
  trigger: z.strictObject({
    kind: z.literal('scan'),
    scanRunId: uuidSchema,
    scanGenerationHour: utcHourSchema
  })
});
const payoutRelatedPayloadSchema = z.strictObject({
  providerPayoutId: payoutProviderIdSchema,
  trigger: z.strictObject({
    kind: z.literal('related'),
    sourcePayoutId: payoutProviderIdSchema,
    sourceFingerprintSha256: sha256Schema
  })
}).refine(
  (value) => value.providerPayoutId !== value.trigger.sourcePayoutId,
  { path: ['trigger', 'sourcePayoutId'], message: 'related payout cannot reference itself' }
);
const payoutContinuationPayloadSchema = z.strictObject({
  providerPayoutId: payoutProviderIdSchema,
  trigger: z.strictObject({
    kind: z.literal('continuation'),
    payoutId: uuidSchema,
    runId: uuidSchema,
    payoutGeneration: nonnegativeInt32Schema,
    cursorDigestSha256: sha256Schema
  })
});

const initialScanPayloadSchema = z.strictObject({
  kind: z.literal('initial'),
  version: z.literal(1)
});
const hourlyScanPayloadSchema = z.strictObject({
  kind: z.literal('hourly'),
  scanGenerationHour: utcHourSchema
});
const payoutImpactScanPayloadSchema = z.strictObject({
  kind: z.literal('payout_impact'),
  payoutId: uuidSchema,
  payoutGeneration: positiveInt32Schema
});
const compositeReplayScanPayloadSchema = z.strictObject({
  kind: z.literal('composite_replay'),
  classifierVersion: positiveInt32Schema,
  allocationAlgorithmVersion: positiveInt32Schema,
  replayId: z.string().min(5).max(63).regex(/^c[1-9]\d*-a[1-9]\d*$/u)
});
const scanContinuationPayloadSchema = z.strictObject({
  kind: z.literal('continuation'),
  scanRunId: uuidSchema,
  phase: scanPhaseSchema,
  cursorDigestSha256: sha256Schema,
  limit: pageLimitSchema
});
const classificationSubjectPayloadSchema = z.strictObject({
  subjectType: subjectTypeSchema,
  subjectId: uuidSchema,
  sourceFingerprintSha256: sha256Schema,
  classifierVersion: positiveInt32Schema,
  allocationAlgorithmVersion: positiveInt32Schema,
  replayId: z.string().min(5).max(63).regex(/^c[1-9]\d*-a[1-9]\d*$/u),
  scanRunId: uuidSchema.optional()
});

export type FinancialSourceEventJobPayload = z.output<typeof sourceEventPayloadSchema>;
export type FinancialSourceGraphJobPayload = z.output<typeof sourceGraphPayloadSchema>;
export type FinancialSourceScanJobPayload = z.output<typeof sourceScanPayloadSchema>;
export type FinancialSourcePayoutImpactJobPayload = z.output<typeof sourcePayoutImpactPayloadSchema>;
export type FinancialSourceJobPayload =
  | FinancialSourceEventJobPayload
  | FinancialSourceGraphJobPayload
  | FinancialSourceScanJobPayload
  | FinancialSourcePayoutImpactJobPayload;
export type FinancialPayoutEventJobPayload = z.output<typeof payoutEventPayloadSchema>;
export type FinancialPayoutScanJobPayload = z.output<typeof payoutScanPayloadSchema>;
export type FinancialPayoutRelatedJobPayload = z.output<typeof payoutRelatedPayloadSchema>;
export type FinancialPayoutContinuationJobPayload =
  z.output<typeof payoutContinuationPayloadSchema>;
export type FinancialPayoutJobPayload =
  | FinancialPayoutEventJobPayload
  | FinancialPayoutScanJobPayload
  | FinancialPayoutRelatedJobPayload
  | FinancialPayoutContinuationJobPayload;
export type FinancialInitialScanJobPayload = z.output<typeof initialScanPayloadSchema>;
export type FinancialHourlyScanJobPayload = z.output<typeof hourlyScanPayloadSchema>;
export type FinancialPayoutImpactScanJobPayload = z.output<typeof payoutImpactScanPayloadSchema>;
export type FinancialCompositeReplayScanJobPayload = z.output<typeof compositeReplayScanPayloadSchema>;
export type FinancialScanContinuationJobPayload = z.output<typeof scanContinuationPayloadSchema>;
export type FinancialScanJobPayload =
  | FinancialInitialScanJobPayload
  | FinancialHourlyScanJobPayload
  | FinancialPayoutImpactScanJobPayload
  | FinancialCompositeReplayScanJobPayload
  | FinancialScanContinuationJobPayload;
export type FinancialClassificationSubjectJobPayload =
  z.output<typeof classificationSubjectPayloadSchema>;

export interface FinancialJobSpec<Type extends string, Payload> {
  readonly type: Type;
  readonly payload: Payload;
  readonly deduplicationKey: string;
  readonly maxAttempts: number;
}

export type FinancialSourceJobSpec = FinancialJobSpec<
  typeof FINANCIAL_SOURCE_JOB,
  FinancialSourceJobPayload
>;
export type FinancialPayoutJobSpec = FinancialJobSpec<
  typeof FINANCIAL_PAYOUT_JOB,
  FinancialPayoutJobPayload
>;
export type FinancialScanJobSpec = FinancialJobSpec<
  typeof FINANCIAL_SCAN_JOB,
  FinancialScanJobPayload
>;
export type FinancialClassificationJobSpec = FinancialJobSpec<
  typeof FINANCIAL_CLASSIFICATION_JOB,
  FinancialClassificationSubjectJobPayload
>;
export type FinancialJobIdentity =
  | FinancialSourceJobSpec
  | FinancialPayoutJobSpec
  | FinancialScanJobSpec
  | FinancialClassificationJobSpec;

function invalidJobPayload(): never {
  throw new PermanentFinancialError('invalid_job_payload');
}

function parseStrict<Output>(schema: z.ZodType<Output>, value: unknown): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return invalidJobPayload();
  return parsed.data;
}

function replayId(classifierVersion: number, allocationAlgorithmVersion: number): string {
  return `c${classifierVersion}-a${allocationAlgorithmVersion}`;
}

function assertReplayIdentity(value: {
  readonly classifierVersion: number;
  readonly allocationAlgorithmVersion: number;
  readonly replayId: string;
}): void {
  if (value.replayId !== replayId(value.classifierVersion, value.allocationAlgorithmVersion)) {
    invalidJobPayload();
  }
}

function sourceSpec<Payload extends FinancialSourceJobPayload>(
  payload: Payload,
  deduplicationKey: string
): FinancialJobSpec<typeof FINANCIAL_SOURCE_JOB, Payload> {
  return {
    type: FINANCIAL_SOURCE_JOB,
    payload,
    deduplicationKey,
    maxAttempts: FINANCIAL_SOURCE_JOB_MAX_ATTEMPTS
  };
}

function payoutSpec<Payload extends FinancialPayoutJobPayload>(
  payload: Payload,
  deduplicationKey: string
): FinancialJobSpec<typeof FINANCIAL_PAYOUT_JOB, Payload> {
  return {
    type: FINANCIAL_PAYOUT_JOB,
    payload,
    deduplicationKey,
    maxAttempts: FINANCIAL_PAYOUT_JOB_MAX_ATTEMPTS
  };
}

function scanSpec<Payload extends FinancialScanJobPayload>(
  payload: Payload,
  deduplicationKey: string
): FinancialJobSpec<typeof FINANCIAL_SCAN_JOB, Payload> {
  return {
    type: FINANCIAL_SCAN_JOB,
    payload,
    deduplicationKey,
    maxAttempts: FINANCIAL_SCAN_JOB_MAX_ATTEMPTS
  };
}

export function parseFinancialSourceEventJobPayload(value: unknown): FinancialSourceEventJobPayload {
  return parseStrict(sourceEventPayloadSchema, value);
}

export function createFinancialSourceEventJob(input: {
  sourceKind: FinancialSourceEventJobPayload['sourceKind'];
  sourceId: string;
  providerEventId: string;
}): FinancialJobSpec<typeof FINANCIAL_SOURCE_JOB, FinancialSourceEventJobPayload> {
  const payload = parseFinancialSourceEventJobPayload({
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    trigger: { kind: 'event', providerEventId: input.providerEventId }
  });
  return sourceSpec(payload, `stripe:financial-source:event:${payload.trigger.providerEventId}`);
}

export function parseFinancialSourceGraphJobPayload(value: unknown): FinancialSourceGraphJobPayload {
  return parseStrict(sourceGraphPayloadSchema, value);
}

export function createFinancialSourceGraphJob(input: {
  sourceKind: FinancialSourceGraphJobPayload['sourceKind'];
  sourceId: string;
  providerEventId: string;
}): FinancialJobSpec<typeof FINANCIAL_SOURCE_JOB, FinancialSourceGraphJobPayload> {
  const payload = parseFinancialSourceGraphJobPayload({
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    trigger: { kind: 'graph', providerEventId: input.providerEventId }
  });
  return sourceSpec(
    payload,
    `financial:source:graph:${payload.trigger.providerEventId}:${payload.sourceKind}:${payload.sourceId}`
  );
}

export function parseFinancialSourceScanJobPayload(value: unknown): FinancialSourceScanJobPayload {
  return parseStrict(sourceScanPayloadSchema, value);
}

export function createFinancialSourceScanJob(input: {
  sourceKind: FinancialSourceScanJobPayload['sourceKind'];
  sourceId: string;
  scanRunId: string;
  scanGenerationHour: string;
}): FinancialJobSpec<typeof FINANCIAL_SOURCE_JOB, FinancialSourceScanJobPayload> {
  const payload = parseFinancialSourceScanJobPayload({
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    trigger: {
      kind: 'scan',
      scanRunId: input.scanRunId,
      scanGenerationHour: input.scanGenerationHour
    }
  });
  return sourceSpec(
    payload,
    `financial:source:scan:${payload.sourceKind}:${payload.sourceId}:${payload.trigger.scanGenerationHour}`
  );
}

export function parseFinancialSourcePayoutImpactJobPayload(
  value: unknown
): FinancialSourcePayoutImpactJobPayload {
  return parseStrict(sourcePayoutImpactPayloadSchema, value);
}

export function createFinancialSourcePayoutImpactJob(input: {
  sourceKind: FinancialSourcePayoutImpactJobPayload['sourceKind'];
  sourceId: string;
  payoutId: string;
  payoutGeneration: number;
}): FinancialJobSpec<typeof FINANCIAL_SOURCE_JOB, FinancialSourcePayoutImpactJobPayload> {
  const payload = parseFinancialSourcePayoutImpactJobPayload({
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    trigger: {
      kind: 'payout_impact',
      payoutId: input.payoutId,
      payoutGeneration: input.payoutGeneration
    }
  });
  return sourceSpec(
    payload,
    `financial:source:payout-impact:${payload.trigger.payoutId}:${payload.trigger.payoutGeneration}:${payload.sourceKind}:${payload.sourceId}`
  );
}

export function parseFinancialPayoutEventJobPayload(value: unknown): FinancialPayoutEventJobPayload {
  return parseStrict(payoutEventPayloadSchema, value);
}

export function createFinancialPayoutEventJob(input: {
  providerPayoutId: string;
  providerEventId: string;
}): FinancialJobSpec<typeof FINANCIAL_PAYOUT_JOB, FinancialPayoutEventJobPayload> {
  const payload = parseFinancialPayoutEventJobPayload({
    providerPayoutId: input.providerPayoutId,
    trigger: { kind: 'event', providerEventId: input.providerEventId }
  });
  return payoutSpec(payload, `stripe:financial-payout:event:${payload.trigger.providerEventId}`);
}

export function parseFinancialPayoutScanJobPayload(value: unknown): FinancialPayoutScanJobPayload {
  return parseStrict(payoutScanPayloadSchema, value);
}

export function createFinancialPayoutScanJob(input: {
  providerPayoutId: string;
  scanRunId: string;
  scanGenerationHour: string;
}): FinancialJobSpec<typeof FINANCIAL_PAYOUT_JOB, FinancialPayoutScanJobPayload> {
  const payload = parseFinancialPayoutScanJobPayload({
    providerPayoutId: input.providerPayoutId,
    trigger: {
      kind: 'scan',
      scanRunId: input.scanRunId,
      scanGenerationHour: input.scanGenerationHour
    }
  });
  return payoutSpec(
    payload,
    `financial:payout:scan:${payload.providerPayoutId}:${payload.trigger.scanGenerationHour}`
  );
}

export function parseFinancialPayoutRelatedJobPayload(
  value: unknown
): FinancialPayoutRelatedJobPayload {
  return parseStrict(payoutRelatedPayloadSchema, value);
}

export function createFinancialPayoutRelatedJob(input: {
  providerPayoutId: string;
  sourcePayoutId: string;
  sourceFingerprintSha256: string;
}): FinancialJobSpec<typeof FINANCIAL_PAYOUT_JOB, FinancialPayoutRelatedJobPayload> {
  const payload = parseFinancialPayoutRelatedJobPayload({
    providerPayoutId: input.providerPayoutId,
    trigger: {
      kind: 'related',
      sourcePayoutId: input.sourcePayoutId,
      sourceFingerprintSha256: input.sourceFingerprintSha256
    }
  });
  return payoutSpec(
    payload,
    `stripe:financial-payout:link:${payload.trigger.sourcePayoutId}:${payload.providerPayoutId}:${payload.trigger.sourceFingerprintSha256}`
  );
}

export function parseFinancialPayoutContinuationJobPayload(
  value: unknown
): FinancialPayoutContinuationJobPayload {
  return parseStrict(payoutContinuationPayloadSchema, value);
}

export function createFinancialPayoutContinuationJob(input: {
  providerPayoutId: string;
  payoutId: string;
  runId: string;
  payoutGeneration: number;
  cursorDigestSha256: string;
}): FinancialJobSpec<typeof FINANCIAL_PAYOUT_JOB, FinancialPayoutContinuationJobPayload> {
  const payload = parseFinancialPayoutContinuationJobPayload({
    providerPayoutId: input.providerPayoutId,
    trigger: {
      kind: 'continuation',
      payoutId: input.payoutId,
      runId: input.runId,
      payoutGeneration: input.payoutGeneration,
      cursorDigestSha256: input.cursorDigestSha256
    }
  });
  return payoutSpec(
    payload,
    `financial:payout:import:${payload.trigger.payoutId}:${payload.trigger.runId}:${payload.trigger.payoutGeneration}:${payload.trigger.cursorDigestSha256}`
  );
}

export function parseFinancialInitialScanJobPayload(value: unknown): FinancialInitialScanJobPayload {
  return parseStrict(initialScanPayloadSchema, value);
}

export function createFinancialInitialScanJob(): FinancialJobSpec<
  typeof FINANCIAL_SCAN_JOB,
  FinancialInitialScanJobPayload
> {
  const payload = parseFinancialInitialScanJobPayload({ kind: 'initial', version: 1 });
  return scanSpec(payload, 'commerce.financial-scan:initial:v1');
}

export function parseFinancialHourlyScanJobPayload(value: unknown): FinancialHourlyScanJobPayload {
  return parseStrict(hourlyScanPayloadSchema, value);
}

export function createFinancialHourlyScanJob(input: {
  scanGenerationHour: string;
}): FinancialJobSpec<typeof FINANCIAL_SCAN_JOB, FinancialHourlyScanJobPayload> {
  const payload = parseFinancialHourlyScanJobPayload({
    kind: 'hourly',
    scanGenerationHour: input.scanGenerationHour
  });
  return scanSpec(payload, `commerce.financial-scan:${payload.scanGenerationHour}`);
}

export function parseFinancialPayoutImpactScanJobPayload(
  value: unknown
): FinancialPayoutImpactScanJobPayload {
  return parseStrict(payoutImpactScanPayloadSchema, value);
}

export function createFinancialPayoutImpactScanJob(input: {
  payoutId: string;
  payoutGeneration: number;
}): FinancialJobSpec<typeof FINANCIAL_SCAN_JOB, FinancialPayoutImpactScanJobPayload> {
  const payload = parseFinancialPayoutImpactScanJobPayload({
    kind: 'payout_impact',
    payoutId: input.payoutId,
    payoutGeneration: input.payoutGeneration
  });
  return scanSpec(
    payload,
    `financial:payout-impact:${payload.payoutId}:${payload.payoutGeneration}`
  );
}

export function parseFinancialCompositeReplayScanJobPayload(
  value: unknown
): FinancialCompositeReplayScanJobPayload {
  const payload = parseStrict(compositeReplayScanPayloadSchema, value);
  assertReplayIdentity(payload);
  return payload;
}

export function createFinancialCompositeReplayScanJob(input: {
  classifierVersion: number;
  allocationAlgorithmVersion: number;
}): FinancialJobSpec<typeof FINANCIAL_SCAN_JOB, FinancialCompositeReplayScanJobPayload> {
  const payload = parseFinancialCompositeReplayScanJobPayload({
    kind: 'composite_replay',
    classifierVersion: input.classifierVersion,
    allocationAlgorithmVersion: input.allocationAlgorithmVersion,
    replayId: replayId(input.classifierVersion, input.allocationAlgorithmVersion)
  });
  return scanSpec(
    payload,
    `commerce.financial-classification:scan:${payload.classifierVersion}:${payload.allocationAlgorithmVersion}`
  );
}

export function parseFinancialScanContinuationJobPayload(
  value: unknown
): FinancialScanContinuationJobPayload {
  return parseStrict(scanContinuationPayloadSchema, value);
}

export function createFinancialScanContinuationJob(input: {
  scanRunId: string;
  phase: FinancialScanContinuationJobPayload['phase'];
  cursorDigestSha256: string;
  limit: number;
}): FinancialJobSpec<typeof FINANCIAL_SCAN_JOB, FinancialScanContinuationJobPayload> {
  const payload = parseFinancialScanContinuationJobPayload({
    kind: 'continuation',
    scanRunId: input.scanRunId,
    phase: input.phase,
    cursorDigestSha256: input.cursorDigestSha256,
    limit: input.limit
  });
  return scanSpec(
    payload,
    `commerce.financial-scan:${payload.scanRunId}:${payload.phase}:${payload.cursorDigestSha256}`
  );
}

export function parseFinancialClassificationSubjectJobPayload(
  value: unknown
): FinancialClassificationSubjectJobPayload {
  const payload = parseStrict(classificationSubjectPayloadSchema, value);
  assertReplayIdentity(payload);
  return payload;
}

export function createFinancialClassificationSubjectJob(input: {
  subjectType: FinancialClassificationSubjectJobPayload['subjectType'];
  subjectId: string;
  sourceFingerprintSha256: string;
  classifierVersion: number;
  allocationAlgorithmVersion: number;
  scanRunId?: string;
}): FinancialClassificationJobSpec {
  const payload = parseFinancialClassificationSubjectJobPayload({
    ...input,
    replayId: replayId(input.classifierVersion, input.allocationAlgorithmVersion)
  });
  return {
    type: FINANCIAL_CLASSIFICATION_JOB,
    payload,
    deduplicationKey:
      `financial:classification:${payload.classifierVersion}:${payload.allocationAlgorithmVersion}:${payload.subjectType}:${payload.subjectId}:${payload.sourceFingerprintSha256}`,
    maxAttempts: FINANCIAL_CLASSIFICATION_JOB_MAX_ATTEMPTS
  };
}

const identityEnvelopeSchema = z.strictObject({
  type: z.enum([
    FINANCIAL_SOURCE_JOB,
    FINANCIAL_PAYOUT_JOB,
    FINANCIAL_SCAN_JOB,
    FINANCIAL_CLASSIFICATION_JOB
  ]),
  payload: z.unknown(),
  deduplicationKey: z.string().min(1).max(1024),
  maxAttempts: z.number().int().min(1).max(FINANCIAL_SOURCE_JOB_MAX_ATTEMPTS)
});

function expectedIdentity(type: FinancialJobIdentity['type'], payload: unknown): FinancialJobIdentity {
  if (type === FINANCIAL_SOURCE_JOB) {
    const triggerKind = parseStrict(z.strictObject({
      sourceKind: sourceKindSchema,
      sourceId: uuidSchema,
      trigger: z.object({ kind: z.string() }).passthrough()
    }), payload).trigger.kind;
    if (triggerKind === 'event') {
      const parsed = parseFinancialSourceEventJobPayload(payload);
      return sourceSpec(parsed, `stripe:financial-source:event:${parsed.trigger.providerEventId}`);
    }
    if (triggerKind === 'graph') {
      const parsed = parseFinancialSourceGraphJobPayload(payload);
      return sourceSpec(
        parsed,
        `financial:source:graph:${parsed.trigger.providerEventId}:${parsed.sourceKind}:${parsed.sourceId}`
      );
    }
    if (triggerKind === 'scan') {
      const parsed = parseFinancialSourceScanJobPayload(payload);
      return sourceSpec(
        parsed,
        `financial:source:scan:${parsed.sourceKind}:${parsed.sourceId}:${parsed.trigger.scanGenerationHour}`
      );
    }
    if (triggerKind === 'payout_impact') {
      const parsed = parseFinancialSourcePayoutImpactJobPayload(payload);
      return sourceSpec(
        parsed,
        `financial:source:payout-impact:${parsed.trigger.payoutId}:${parsed.trigger.payoutGeneration}:${parsed.sourceKind}:${parsed.sourceId}`
      );
    }
    return invalidJobPayload();
  }
  if (type === FINANCIAL_PAYOUT_JOB) {
    const triggerKind = parseStrict(z.strictObject({
      providerPayoutId: payoutProviderIdSchema,
      trigger: z.object({ kind: z.string() }).passthrough()
    }), payload).trigger.kind;
    if (triggerKind === 'event') {
      const parsed = parseFinancialPayoutEventJobPayload(payload);
      return payoutSpec(parsed, `stripe:financial-payout:event:${parsed.trigger.providerEventId}`);
    }
    if (triggerKind === 'scan') {
      const parsed = parseFinancialPayoutScanJobPayload(payload);
      return payoutSpec(
        parsed,
        `financial:payout:scan:${parsed.providerPayoutId}:${parsed.trigger.scanGenerationHour}`
      );
    }
    if (triggerKind === 'related') {
      const parsed = parseFinancialPayoutRelatedJobPayload(payload);
      return payoutSpec(
        parsed,
        `stripe:financial-payout:link:${parsed.trigger.sourcePayoutId}:${parsed.providerPayoutId}:${parsed.trigger.sourceFingerprintSha256}`
      );
    }
    if (triggerKind === 'continuation') {
      const parsed = parseFinancialPayoutContinuationJobPayload(payload);
      return payoutSpec(
        parsed,
        `financial:payout:import:${parsed.trigger.payoutId}:${parsed.trigger.runId}:${parsed.trigger.payoutGeneration}:${parsed.trigger.cursorDigestSha256}`
      );
    }
    return invalidJobPayload();
  }
  if (type === FINANCIAL_SCAN_JOB) {
    const kind = parseStrict(z.object({ kind: z.string() }).passthrough(), payload).kind;
    if (kind === 'initial') {
      const parsed = parseFinancialInitialScanJobPayload(payload);
      return scanSpec(parsed, 'commerce.financial-scan:initial:v1');
    }
    if (kind === 'hourly') {
      const parsed = parseFinancialHourlyScanJobPayload(payload);
      return scanSpec(parsed, `commerce.financial-scan:${parsed.scanGenerationHour}`);
    }
    if (kind === 'payout_impact') {
      const parsed = parseFinancialPayoutImpactScanJobPayload(payload);
      return scanSpec(parsed, `financial:payout-impact:${parsed.payoutId}:${parsed.payoutGeneration}`);
    }
    if (kind === 'composite_replay') {
      const parsed = parseFinancialCompositeReplayScanJobPayload(payload);
      return scanSpec(
        parsed,
        `commerce.financial-classification:scan:${parsed.classifierVersion}:${parsed.allocationAlgorithmVersion}`
      );
    }
    if (kind === 'continuation') {
      const parsed = parseFinancialScanContinuationJobPayload(payload);
      return scanSpec(
        parsed,
        `commerce.financial-scan:${parsed.scanRunId}:${parsed.phase}:${parsed.cursorDigestSha256}`
      );
    }
    return invalidJobPayload();
  }
  const parsed = parseFinancialClassificationSubjectJobPayload(payload);
  return {
    type: FINANCIAL_CLASSIFICATION_JOB,
    payload: parsed,
    deduplicationKey:
      `financial:classification:${parsed.classifierVersion}:${parsed.allocationAlgorithmVersion}:${parsed.subjectType}:${parsed.subjectId}:${parsed.sourceFingerprintSha256}`,
    maxAttempts: FINANCIAL_CLASSIFICATION_JOB_MAX_ATTEMPTS
  };
}

export function parseFinancialJobIdentity(value: unknown): FinancialJobIdentity {
  const envelope = parseStrict(identityEnvelopeSchema, value);
  const expected = expectedIdentity(envelope.type, envelope.payload);
  if (
    envelope.deduplicationKey !== expected.deduplicationKey ||
    envelope.maxAttempts !== expected.maxAttempts
  ) return invalidJobPayload();
  return expected;
}
