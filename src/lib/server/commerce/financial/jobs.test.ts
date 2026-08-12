import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PermanentFinancialError } from './errors';
import {
  FINANCIAL_CLASSIFICATION_JOB,
  FINANCIAL_PAYOUT_JOB,
  FINANCIAL_SCAN_JOB,
  FINANCIAL_SOURCE_JOB,
  createFinancialClassificationSubjectJob,
  createFinancialCompositeReplayScanJob,
  createFinancialHourlyScanJob,
  createFinancialInitialScanJob,
  createFinancialPayoutEventJob,
  createFinancialPayoutImpactScanJob,
  createFinancialPayoutRelatedJob,
  createFinancialPayoutScanJob,
  createFinancialScanContinuationJob,
  createFinancialSourceEventJob,
  createFinancialSourcePayoutImpactJob,
  createFinancialSourceScanJob,
  parseFinancialClassificationSubjectJobPayload,
  parseFinancialCompositeReplayScanJobPayload,
  parseFinancialHourlyScanJobPayload,
  parseFinancialInitialScanJobPayload,
  parseFinancialJobIdentity,
  parseFinancialPayoutEventJobPayload,
  parseFinancialPayoutImpactScanJobPayload,
  parseFinancialPayoutRelatedJobPayload,
  parseFinancialPayoutScanJobPayload,
  parseFinancialScanContinuationJobPayload,
  parseFinancialSourceEventJobPayload,
  parseFinancialSourcePayoutImpactJobPayload,
  parseFinancialSourceScanJobPayload
} from './jobs';

const SOURCE_ID = '00000000-0000-4000-8000-000000000701';
const PAYOUT_ID = '00000000-0000-4000-8000-000000000702';
const SCAN_RUN_ID = '00000000-0000-4000-8000-000000000703';
const SUBJECT_ID = '00000000-0000-4000-8000-000000000704';
const HOUR = '2026-08-12T01:00:00.000Z';
const FINGERPRINT = 'a'.repeat(64);
const CURSOR_DIGEST = 'b'.repeat(64);
const CONTINUATION_PHASES = [
  'source_page',
  'payout_discovery_page',
  'incomplete_payout_run_page',
  'payout_impact_page',
  'classification_replay_page'
] as const;

function expectInvalid(work: () => unknown): void {
  let failure: unknown;
  try {
    work();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(PermanentFinancialError);
  expect((failure as PermanentFinancialError).safeCode).toBe('invalid_job_payload');
  expect(failure).not.toHaveProperty('cause');
}

describe('financial job identities', () => {
  it('pins exactly four durable financial job families', () => {
    expect([
      FINANCIAL_SOURCE_JOB,
      FINANCIAL_PAYOUT_JOB,
      FINANCIAL_SCAN_JOB,
      FINANCIAL_CLASSIFICATION_JOB
    ]).toEqual([
      'commerce.financial-source',
      'commerce.financial-payout',
      'commerce.financial-scan',
      'commerce.financial-classification'
    ]);
  });

  it('creates strict event, scan, and payout-impact source identities from local source IDs', () => {
    const event = createFinancialSourceEventJob({
      sourceKind: 'refund',
      sourceId: SOURCE_ID,
      providerEventId: 'evt_financial_701'
    });
    expect(event).toEqual({
      type: FINANCIAL_SOURCE_JOB,
      payload: {
        sourceKind: 'refund',
        sourceId: SOURCE_ID,
        trigger: { kind: 'event', providerEventId: 'evt_financial_701' }
      },
      deduplicationKey: 'stripe:financial-source:event:evt_financial_701',
      maxAttempts: 12
    });
    expect(parseFinancialSourceEventJobPayload(event.payload)).toEqual(event.payload);

    const scan = createFinancialSourceScanJob({
      sourceKind: 'payment',
      sourceId: SOURCE_ID,
      scanRunId: SCAN_RUN_ID,
      scanGenerationHour: HOUR
    });
    expect(scan).toEqual({
      type: FINANCIAL_SOURCE_JOB,
      payload: {
        sourceKind: 'payment',
        sourceId: SOURCE_ID,
        trigger: { kind: 'scan', scanRunId: SCAN_RUN_ID, scanGenerationHour: HOUR }
      },
      deduplicationKey: `financial:source:scan:payment:${SOURCE_ID}:${HOUR}`,
      maxAttempts: 12
    });
    expect(parseFinancialSourceScanJobPayload(scan.payload)).toEqual(scan.payload);

    const impact = createFinancialSourcePayoutImpactJob({
      sourceKind: 'dispute',
      sourceId: SOURCE_ID,
      payoutId: PAYOUT_ID,
      payoutGeneration: 9
    });
    expect(impact).toEqual({
      type: FINANCIAL_SOURCE_JOB,
      payload: {
        sourceKind: 'dispute',
        sourceId: SOURCE_ID,
        trigger: { kind: 'payout_impact', payoutId: PAYOUT_ID, payoutGeneration: 9 }
      },
      deduplicationKey:
        `financial:source:payout-impact:${PAYOUT_ID}:9:dispute:${SOURCE_ID}`,
      maxAttempts: 12
    });
    expect(parseFinancialSourcePayoutImpactJobPayload(impact.payload)).toEqual(impact.payload);
  });

  it('creates event, hourly scan, and canonical related-payout identities', () => {
    const event = createFinancialPayoutEventJob({
      providerPayoutId: 'po_financial_701',
      providerEventId: 'evt_financial_702'
    });
    expect(event).toEqual({
      type: FINANCIAL_PAYOUT_JOB,
      payload: {
        providerPayoutId: 'po_financial_701',
        trigger: { kind: 'event', providerEventId: 'evt_financial_702' }
      },
      deduplicationKey: 'stripe:financial-payout:event:evt_financial_702',
      maxAttempts: 12
    });
    expect(parseFinancialPayoutEventJobPayload(event.payload)).toEqual(event.payload);

    const scan = createFinancialPayoutScanJob({
      providerPayoutId: 'po_financial_701',
      scanRunId: SCAN_RUN_ID,
      scanGenerationHour: HOUR
    });
    expect(scan.deduplicationKey).toBe(`financial:payout:scan:po_financial_701:${HOUR}`);
    expect(parseFinancialPayoutScanJobPayload(scan.payload)).toEqual(scan.payload);

    const related = createFinancialPayoutRelatedJob({
      providerPayoutId: 'po_related_702',
      sourcePayoutId: 'po_financial_701',
      sourceFingerprintSha256: FINGERPRINT
    });
    expect(related).toEqual({
      type: FINANCIAL_PAYOUT_JOB,
      payload: {
        providerPayoutId: 'po_related_702',
        trigger: {
          kind: 'related',
          sourcePayoutId: 'po_financial_701',
          sourceFingerprintSha256: FINGERPRINT
        }
      },
      deduplicationKey:
        `stripe:financial-payout:link:po_financial_701:po_related_702:${FINGERPRINT}`,
      maxAttempts: 12
    });
    expect(parseFinancialPayoutRelatedJobPayload(related.payload)).toEqual(related.payload);
  });

  it('creates initial, hourly, payout-impact, and composite replay scan roots', () => {
    const initial = createFinancialInitialScanJob();
    expect(initial).toEqual({
      type: FINANCIAL_SCAN_JOB,
      payload: { kind: 'initial', version: 1 },
      deduplicationKey: 'commerce.financial-scan:initial:v1',
      maxAttempts: 8
    });
    expect(parseFinancialInitialScanJobPayload(initial.payload)).toEqual(initial.payload);

    const hourly = createFinancialHourlyScanJob({ scanGenerationHour: HOUR });
    expect(hourly.deduplicationKey).toBe(`commerce.financial-scan:${HOUR}`);
    expect(parseFinancialHourlyScanJobPayload(hourly.payload)).toEqual(hourly.payload);

    const impact = createFinancialPayoutImpactScanJob({
      payoutId: PAYOUT_ID,
      payoutGeneration: 7
    });
    expect(impact).toEqual({
      type: FINANCIAL_SCAN_JOB,
      payload: { kind: 'payout_impact', payoutId: PAYOUT_ID, payoutGeneration: 7 },
      deduplicationKey: `financial:payout-impact:${PAYOUT_ID}:7`,
      maxAttempts: 8
    });
    expect(parseFinancialPayoutImpactScanJobPayload(impact.payload)).toEqual(impact.payload);

    const replay = createFinancialCompositeReplayScanJob({
      classifierVersion: 2,
      allocationAlgorithmVersion: 3
    });
    expect(replay).toEqual({
      type: FINANCIAL_SCAN_JOB,
      payload: {
        kind: 'composite_replay',
        classifierVersion: 2,
        allocationAlgorithmVersion: 3,
        replayId: 'c2-a3'
      },
      deduplicationKey: 'commerce.financial-classification:scan:2:3',
      maxAttempts: 8
    });
    expect(parseFinancialCompositeReplayScanJobPayload(replay.payload)).toEqual(replay.payload);
  });

  it.each(CONTINUATION_PHASES)('creates a bounded %s continuation identity', (phase) => {
    const continuation = createFinancialScanContinuationJob({
      scanRunId: SCAN_RUN_ID,
      phase,
      cursorDigestSha256: CURSOR_DIGEST,
      limit: phase === 'source_page' ? 1 : 100
    });
    expect(continuation).toEqual({
      type: FINANCIAL_SCAN_JOB,
      payload: {
        kind: 'continuation',
        scanRunId: SCAN_RUN_ID,
        phase,
        cursorDigestSha256: CURSOR_DIGEST,
        limit: phase === 'source_page' ? 1 : 100
      },
      deduplicationKey:
        `commerce.financial-scan:${SCAN_RUN_ID}:${phase}:${CURSOR_DIGEST}`,
      maxAttempts: 8
    });
    expect(parseFinancialScanContinuationJobPayload(continuation.payload))
      .toEqual(continuation.payload);
  });

  it('derives the composite replay identity for one classification subject', () => {
    const classification = createFinancialClassificationSubjectJob({
      subjectType: 'fee_detail',
      subjectId: SUBJECT_ID,
      sourceFingerprintSha256: FINGERPRINT,
      classifierVersion: 4,
      allocationAlgorithmVersion: 5
    });
    expect(classification).toEqual({
      type: FINANCIAL_CLASSIFICATION_JOB,
      payload: {
        subjectType: 'fee_detail',
        subjectId: SUBJECT_ID,
        sourceFingerprintSha256: FINGERPRINT,
        classifierVersion: 4,
        allocationAlgorithmVersion: 5,
        replayId: 'c4-a5'
      },
      deduplicationKey:
        `financial:classification:4:5:fee_detail:${SUBJECT_ID}:${FINGERPRINT}`,
      maxAttempts: 5
    });
    expect(parseFinancialClassificationSubjectJobPayload(classification.payload))
      .toEqual(classification.payload);
  });

  it('canonicalizes UUID aliases before deriving payloads and permanent keys', () => {
    const upperSourceId = '00000000-0000-4000-8000-000000000A01';
    const upperPayoutId = '00000000-0000-4000-8000-000000000A02';
    const source = createFinancialSourceScanJob({
      sourceKind: 'payment',
      sourceId: upperSourceId,
      scanRunId: SCAN_RUN_ID.toUpperCase(),
      scanGenerationHour: HOUR
    });
    expect(source.payload.sourceId).toBe(upperSourceId.toLowerCase());
    expect(source.payload.trigger.scanRunId).toBe(SCAN_RUN_ID);
    expect(source.deduplicationKey)
      .toBe(`financial:source:scan:payment:${upperSourceId.toLowerCase()}:${HOUR}`);

    const impact = createFinancialPayoutImpactScanJob({
      payoutId: upperPayoutId,
      payoutGeneration: 1
    });
    expect(impact.payload.payoutId).toBe(upperPayoutId.toLowerCase());
    expect(impact.deduplicationKey)
      .toBe(`financial:payout-impact:${upperPayoutId.toLowerCase()}:1`);

    expect(parseFinancialJobIdentity({
      ...source,
      payload: {
        ...source.payload,
        sourceId: upperSourceId,
        trigger: { ...source.payload.trigger, scanRunId: SCAN_RUN_ID.toUpperCase() }
      }
    })).toEqual(source);
  });

  it('round-trips and rejects key tampering for every variant and continuation phase', () => {
    const identities = [
      createFinancialSourceEventJob({
        sourceKind: 'payment', sourceId: SOURCE_ID, providerEventId: 'evt_roundtrip_701'
      }),
      createFinancialSourceScanJob({
        sourceKind: 'refund',
        sourceId: SOURCE_ID,
        scanRunId: SCAN_RUN_ID,
        scanGenerationHour: HOUR
      }),
      createFinancialSourcePayoutImpactJob({
        sourceKind: 'dispute', sourceId: SOURCE_ID, payoutId: PAYOUT_ID, payoutGeneration: 1
      }),
      createFinancialPayoutEventJob({
        providerPayoutId: 'po_roundtrip_701', providerEventId: 'evt_roundtrip_702'
      }),
      createFinancialPayoutScanJob({
        providerPayoutId: 'po_roundtrip_701', scanRunId: SCAN_RUN_ID, scanGenerationHour: HOUR
      }),
      createFinancialPayoutRelatedJob({
        providerPayoutId: 'po_roundtrip_702',
        sourcePayoutId: 'po_roundtrip_701',
        sourceFingerprintSha256: FINGERPRINT
      }),
      createFinancialInitialScanJob(),
      createFinancialHourlyScanJob({ scanGenerationHour: HOUR }),
      createFinancialPayoutImpactScanJob({ payoutId: PAYOUT_ID, payoutGeneration: 1 }),
      createFinancialCompositeReplayScanJob({
        classifierVersion: 1, allocationAlgorithmVersion: 1
      }),
      ...CONTINUATION_PHASES.map((phase) => createFinancialScanContinuationJob({
        scanRunId: SCAN_RUN_ID,
        phase,
        cursorDigestSha256: CURSOR_DIGEST,
        limit: 100
      })),
      createFinancialClassificationSubjectJob({
        subjectType: 'balance_transaction',
        subjectId: SUBJECT_ID,
        sourceFingerprintSha256: FINGERPRINT,
        classifierVersion: 1,
        allocationAlgorithmVersion: 1
      })
    ];

    for (const identity of identities) {
      const jsonValue: unknown = JSON.parse(JSON.stringify(identity));
      expect(parseFinancialJobIdentity(jsonValue)).toEqual(identity);
      expectInvalid(() => parseFinancialJobIdentity({
        ...identity,
        deduplicationKey: `${identity.deduplicationKey}:tampered`
      }));
    }
  });

  it('keeps every approved recurrence generation dimension distinct', () => {
    const nextHour = '2026-08-12T02:00:00.000Z';
    const alternateId = '00000000-0000-4000-8000-000000000799';
    const classification = (overrides: Partial<Parameters<
      typeof createFinancialClassificationSubjectJob
    >[0]> = {}) => createFinancialClassificationSubjectJob({
      subjectType: 'fee_detail',
      subjectId: SUBJECT_ID,
      sourceFingerprintSha256: FINGERPRINT,
      classifierVersion: 1,
      allocationAlgorithmVersion: 1,
      ...overrides
    });
    const continuation = (overrides: Partial<Parameters<
      typeof createFinancialScanContinuationJob
    >[0]> = {}) => createFinancialScanContinuationJob({
      scanRunId: SCAN_RUN_ID,
      phase: 'source_page',
      cursorDigestSha256: CURSOR_DIGEST,
      limit: 100,
      ...overrides
    });
    const distinctPairs = [
      [
        createFinancialSourceEventJob({
          sourceKind: 'payment', sourceId: SOURCE_ID, providerEventId: 'evt_generation_701'
        }),
        createFinancialSourceEventJob({
          sourceKind: 'payment', sourceId: SOURCE_ID, providerEventId: 'evt_generation_702'
        })
      ],
      [
        createFinancialSourceScanJob({
          sourceKind: 'payment',
          sourceId: SOURCE_ID,
          scanRunId: SCAN_RUN_ID,
          scanGenerationHour: HOUR
        }),
        createFinancialSourceScanJob({
          sourceKind: 'payment',
          sourceId: SOURCE_ID,
          scanRunId: randomUUID(),
          scanGenerationHour: nextHour
        })
      ],
      [
        createFinancialSourcePayoutImpactJob({
          sourceKind: 'refund', sourceId: SOURCE_ID, payoutId: PAYOUT_ID, payoutGeneration: 1
        }),
        createFinancialSourcePayoutImpactJob({
          sourceKind: 'refund', sourceId: SOURCE_ID, payoutId: PAYOUT_ID, payoutGeneration: 2
        })
      ],
      [
        createFinancialPayoutEventJob({
          providerPayoutId: 'po_generation_701', providerEventId: 'evt_generation_703'
        }),
        createFinancialPayoutEventJob({
          providerPayoutId: 'po_generation_701', providerEventId: 'evt_generation_704'
        })
      ],
      [
        createFinancialPayoutScanJob({
          providerPayoutId: 'po_generation_701', scanRunId: SCAN_RUN_ID, scanGenerationHour: HOUR
        }),
        createFinancialPayoutScanJob({
          providerPayoutId: 'po_generation_701',
          scanRunId: randomUUID(),
          scanGenerationHour: nextHour
        })
      ],
      [
        createFinancialPayoutRelatedJob({
          providerPayoutId: 'po_generation_702',
          sourcePayoutId: 'po_generation_701',
          sourceFingerprintSha256: FINGERPRINT
        }),
        createFinancialPayoutRelatedJob({
          providerPayoutId: 'po_generation_702',
          sourcePayoutId: 'po_generation_701',
          sourceFingerprintSha256: 'c'.repeat(64)
        })
      ],
      [
        createFinancialHourlyScanJob({ scanGenerationHour: HOUR }),
        createFinancialHourlyScanJob({ scanGenerationHour: nextHour })
      ],
      [
        createFinancialPayoutImpactScanJob({ payoutId: PAYOUT_ID, payoutGeneration: 1 }),
        createFinancialPayoutImpactScanJob({ payoutId: PAYOUT_ID, payoutGeneration: 2 })
      ],
      [
        createFinancialCompositeReplayScanJob({
          classifierVersion: 1, allocationAlgorithmVersion: 1
        }),
        createFinancialCompositeReplayScanJob({
          classifierVersion: 2, allocationAlgorithmVersion: 1
        })
      ],
      [
        createFinancialCompositeReplayScanJob({
          classifierVersion: 1, allocationAlgorithmVersion: 1
        }),
        createFinancialCompositeReplayScanJob({
          classifierVersion: 1, allocationAlgorithmVersion: 2
        })
      ],
      [continuation(), continuation({ scanRunId: alternateId })],
      [continuation(), continuation({ phase: 'payout_impact_page' })],
      [continuation(), continuation({ cursorDigestSha256: 'c'.repeat(64) })],
      [classification(), classification({ classifierVersion: 2 })],
      [classification(), classification({ allocationAlgorithmVersion: 2 })],
      [classification(), classification({ subjectId: alternateId })],
      [classification(), classification({ sourceFingerprintSha256: 'c'.repeat(64) })]
    ] as const;

    for (const [earlier, later] of distinctPairs) {
      expect(earlier.deduplicationKey).not.toBe(later.deduplicationKey);
    }

    expect(continuation({ limit: 1 }).deduplicationKey)
      .toBe(continuation({ limit: 100 }).deduplicationKey);
  });

  it('structurally accepts prior positive version pairs without requiring deployed constants', () => {
    const oldReplay = {
      type: FINANCIAL_SCAN_JOB,
      payload: {
        kind: 'composite_replay',
        classifierVersion: 17,
        allocationAlgorithmVersion: 9,
        replayId: 'c17-a9'
      },
      deduplicationKey: 'commerce.financial-classification:scan:17:9',
      maxAttempts: 8
    };
    expect(parseFinancialJobIdentity(oldReplay)).toEqual(oldReplay);
  });

  it('rejects unknown fields and noncanonical source triggers cause-free', () => {
    expectInvalid(() => parseFinancialSourceEventJobPayload({
      sourceKind: 'payment',
      sourceId: SOURCE_ID,
      trigger: { kind: 'event', providerEventId: 'evt_valid_701', extra: true }
    }));
    expectInvalid(() => parseFinancialSourceScanJobPayload({
      sourceKind: 'payment',
      sourceId: SOURCE_ID,
      trigger: { kind: 'scan', scanRunId: SCAN_RUN_ID, scanGenerationHour: HOUR },
      email: 'private@example.com'
    }));
    expectInvalid(() => parseFinancialSourcePayoutImpactJobPayload({
      sourceKind: 'payment',
      sourceId: 'ch_provider_not_internal',
      trigger: { kind: 'payout_impact', payoutId: PAYOUT_ID, payoutGeneration: 1 }
    }));
  });

  it.each([
    '2026-08-12T01:30:00.000Z',
    '2026-08-12T01:00:00Z',
    '2026-08-11T21:00:00.000-04:00',
    '2026-08-12T01:00:00.001Z'
  ])('rejects noncanonical UTC-hour %s', (scanGenerationHour) => {
    expectInvalid(() => createFinancialHourlyScanJob({ scanGenerationHour }));
  });

  it('rejects malformed provider IDs, hashes, generations, and versions', () => {
    expectInvalid(() => createFinancialSourceEventJob({
      sourceKind: 'payment', sourceId: SOURCE_ID, providerEventId: 'pi_not_an_event'
    }));
    expectInvalid(() => createFinancialPayoutEventJob({
      providerPayoutId: 'tr_not_a_payout', providerEventId: 'evt_valid_702'
    }));
    expectInvalid(() => createFinancialPayoutRelatedJob({
      providerPayoutId: 'po_related_702',
      sourcePayoutId: 'po_source_701',
      sourceFingerprintSha256: 'A'.repeat(64)
    }));
    expectInvalid(() => createFinancialPayoutRelatedJob({
      providerPayoutId: 'po_same_payout',
      sourcePayoutId: 'po_same_payout',
      sourceFingerprintSha256: FINGERPRINT
    }));
    for (const payoutGeneration of [0, 2_147_483_648, 1.5]) {
      expectInvalid(() => createFinancialPayoutImpactScanJob({
        payoutId: PAYOUT_ID, payoutGeneration
      }));
    }
    for (const classifierVersion of [0, 2_147_483_648, 1.5]) {
      expectInvalid(() => createFinancialCompositeReplayScanJob({
        classifierVersion, allocationAlgorithmVersion: 1
      }));
    }
    for (const limit of [0, 101, 1.5]) {
      expectInvalid(() => createFinancialScanContinuationJob({
        scanRunId: SCAN_RUN_ID,
        phase: 'source_page',
        cursorDigestSha256: CURSOR_DIGEST,
        limit
      }));
    }
  });

  it('rejects replay and deduplication identity mismatches cause-free', () => {
    expectInvalid(() => parseFinancialCompositeReplayScanJobPayload({
      kind: 'composite_replay',
      classifierVersion: 2,
      allocationAlgorithmVersion: 3,
      replayId: 'c2-a4'
    }));
    expectInvalid(() => parseFinancialClassificationSubjectJobPayload({
      subjectType: 'fee_detail',
      subjectId: SUBJECT_ID,
      sourceFingerprintSha256: FINGERPRINT,
      classifierVersion: 2,
      allocationAlgorithmVersion: 3,
      replayId: 'c2-a4'
    }));

    const identity = createFinancialSourceScanJob({
      sourceKind: 'refund',
      sourceId: SOURCE_ID,
      scanRunId: randomUUID(),
      scanGenerationHour: HOUR
    });
    expectInvalid(() => parseFinancialJobIdentity({
      ...identity,
      deduplicationKey: `${identity.deduplicationKey}:tampered`
    }));
    expectInvalid(() => parseFinancialJobIdentity({ ...identity, maxAttempts: 11 }));
    expectInvalid(() => parseFinancialJobIdentity({ ...identity, rawProviderMessage: 'private' }));
  });
});
