import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  SALES_CURRENCY_SUMMARY_DTO_KEYS,
  TITLE_SALES_ROW_DTO_KEYS,
  type SalesCurrencySummaryDto,
  type TitleSalesRowDto
} from '$lib/types/financial-reporting';
import {
  summarizeCurrencyPairs,
  toSalesTitleMetricDto,
  type SalesTitleMetricContributor,
  type SalesTitleMetricDto,
  type SalesTitleMetricInput
} from './metrics';

const SETTLEMENT_KEYS = [
  'grossSettlementMinor',
  'refundImpactMinor',
  'disputeImpactMinor',
  'processingFeeImpactMinor',
  'refundFeeImpactMinor',
  'disputeFeeImpactMinor',
  'otherFeeImpactMinor',
  'estimatedPayoutMinor'
] as const;

function contributor(
  overrides: Partial<SalesTitleMetricContributor> = {}
): SalesTitleMetricContributor {
  return {
    balanceTransactionId: 'bt_sale',
    algorithmVersion: 2,
    basis: 'gross_amount',
    sourceKind: 'payment',
    scope: 'title',
    settlementCurrency: 'USD',
    state: 'payout_reconciled',
    availability: 'complete',
    missingSourceCount: 0,
    effects: [{ component: 'sale_subtotal', effectMinor: 1_000 }],
    ...overrides
  };
}

function input(overrides: Partial<SalesTitleMetricInput> = {}): SalesTitleMetricInput {
  return {
    titleId: '11111111-1111-4111-8111-111111111111',
    currentTitle: 'Pale Orbit',
    format: 'prose',
    archived: false,
    soldAsVariants: [{ title: 'Pale Orbit', creatorName: 'A. Writer', format: 'prose' }],
    presentmentCurrency: 'USD',
    settlementCurrency: 'USD',
    soldCopies: 1,
    fullyRefundedCopies: 0,
    grossPresentmentMinor: 1_080,
    finalizedRefundPresentmentMinor: 0,
    disputeWithdrawalPresentmentMinor: 0,
    disputeReinstatementPresentmentMinor: 0,
    freshnessAt: '2026-08-20T12:00:00.000Z',
    contributors: [contributor()],
    ...overrides
  };
}

function unavailableContributor(
  availability: 'missing' | 'conflicting' | 'unresolved' | 'incompatible',
  missingSourceCount: number,
  overrides: Partial<SalesTitleMetricContributor> = {}
): SalesTitleMetricContributor {
  return contributor({
    balanceTransactionId: `bt_${availability}`,
    sourceKind: 'refund',
    scope: availability === 'unresolved' ? 'unresolved' : 'title',
    state: availability === 'missing' || availability === 'unresolved' ? 'pending' : 'exception',
    availability,
    missingSourceCount,
    effects: [],
    ...overrides
  });
}

function expectUnavailable(
  row: SalesTitleMetricDto,
  expected: { missingSourceCount: number; state: 'pending' | 'exception' }
): void {
  for (const key of SETTLEMENT_KEYS) expect(row[key]).toBeNull();
  expect(row).toMatchObject({
    settlementMetricsComplete: false,
    missingSourceCount: expected.missingSourceCount,
    state: expected.state
  });
}

describe('toSalesTitleMetricDto', () => {
  it('exports the existing browser DTO shape from an exact minimal input contract', () => {
    expectTypeOf<SalesTitleMetricDto>().toEqualTypeOf<TitleSalesRowDto>();
    expect(Object.keys(input())).toEqual([
      'titleId',
      'currentTitle',
      'format',
      'archived',
      'soldAsVariants',
      'presentmentCurrency',
      'settlementCurrency',
      'soldCopies',
      'fullyRefundedCopies',
      'grossPresentmentMinor',
      'finalizedRefundPresentmentMinor',
      'disputeWithdrawalPresentmentMinor',
      'disputeReinstatementPresentmentMinor',
      'freshnessAt',
      'contributors'
    ]);

    const row = toSalesTitleMetricDto(input());
    expect(Object.keys(row)).toEqual(TITLE_SALES_ROW_DTO_KEYS);
    expect(row satisfies TitleSalesRowDto).toBe(row);
  });

  it('uses signed settlement effects exactly once and excludes customer sales tax', () => {
    const row = toSalesTitleMetricDto(input({
      contributors: [
        contributor({
          effects: [
            { component: 'sale_subtotal', effectMinor: 1_000 },
            { component: 'sale_tax', effectMinor: 80 }
          ]
        }),
        contributor({
          basis: 'fee',
          effects: [
            { component: 'processing_fee', effectMinor: -58 },
            { component: 'provider_fee_tax', effectMinor: -2 }
          ]
        })
      ]
    }));

    expect(row).toMatchObject({
      grossSettlementMinor: 1_000,
      refundImpactMinor: 0,
      disputeImpactMinor: 0,
      processingFeeImpactMinor: -60,
      refundFeeImpactMinor: 0,
      disputeFeeImpactMinor: 0,
      otherFeeImpactMinor: 0,
      estimatedPayoutMinor: 940,
      settlementMetricsComplete: true,
      missingSourceCount: 0,
      state: 'payout_reconciled'
    });
  });

  it.each([
    ['partial', -300, 300, 0, 1, 700],
    ['full', -1_000, 1_000, 1, 0, 0]
  ] as const)(
    'preserves a %s refund as a signed settlement effect',
    (_label, effectMinor, presentmentMinor, fullyRefundedCopies, netCopies, expectedEstimate) => {
      const row = toSalesTitleMetricDto(input({
        soldCopies: 1,
        fullyRefundedCopies,
        finalizedRefundPresentmentMinor: presentmentMinor,
        contributors: [
          contributor(),
          contributor({
            balanceTransactionId: `bt_refund_${presentmentMinor}`,
            sourceKind: 'refund',
            effects: [
              { component: 'refund_subtotal', effectMinor },
              { component: 'refund_tax', effectMinor: -(presentmentMinor * 0.08) }
            ]
          })
        ]
      }));

      expect(row.refundImpactMinor).toBe(effectMinor);
      expect(row.estimatedPayoutMinor).toBe(expectedEstimate);
      expect(row.finalizedRefundPresentmentMinor).toBe(presentmentMinor);
      expect(row.netCopies).toBe(netCopies);
    }
  );

  it('keeps processing, refund, dispute, and other fees in separate signed buckets', () => {
    const row = toSalesTitleMetricDto(input({
      contributors: [
        contributor(),
        contributor({
          basis: 'fee',
          effects: [{ component: 'processing_fee', effectMinor: -40 }]
        }),
        contributor({
          balanceTransactionId: 'bt_refund',
          basis: 'fee',
          sourceKind: 'refund',
          effects: [{ component: 'refund_fee', effectMinor: -10 }]
        }),
        contributor({
          balanceTransactionId: 'bt_dispute',
          basis: 'fee',
          sourceKind: 'dispute',
          effects: [{ component: 'dispute_fee', effectMinor: -15 }]
        }),
        contributor({
          balanceTransactionId: 'bt_other',
          basis: 'fee',
          effects: [{ component: 'other', effectMinor: -3 }]
        })
      ]
    }));

    expect(row).toMatchObject({
      processingFeeImpactMinor: -40,
      refundFeeImpactMinor: -10,
      disputeFeeImpactMinor: -15,
      otherFeeImpactMinor: -3,
      estimatedPayoutMinor: 932
    });
  });

  it('assigns provider fee tax and credits to the source-aware fee bucket', () => {
    const row = toSalesTitleMetricDto(input({
      contributors: [
        contributor(),
        contributor({
          balanceTransactionId: 'bt_payment_fee',
          basis: 'fee',
          effects: [
            { component: 'provider_fee_tax', effectMinor: -4 },
            { component: 'fee_credit', effectMinor: 1 }
          ]
        }),
        contributor({
          balanceTransactionId: 'bt_refund_credit',
          basis: 'fee',
          sourceKind: 'refund',
          effects: [
            { component: 'provider_fee_tax', effectMinor: -3 },
            { component: 'fee_credit', effectMinor: 8 }
          ]
        }),
        contributor({
          balanceTransactionId: 'bt_dispute_credit',
          basis: 'fee',
          sourceKind: 'dispute',
          effects: [
            { component: 'provider_fee_tax', effectMinor: -2 },
            { component: 'fee_credit', effectMinor: 7 }
          ]
        })
      ]
    }));

    expect(row).toMatchObject({
      processingFeeImpactMinor: -3,
      refundFeeImpactMinor: 5,
      disputeFeeImpactMinor: 5,
      otherFeeImpactMinor: 0,
      estimatedPayoutMinor: 1_007
    });
  });

  it('preserves a dispute fee credit carried by a gross provider transaction', () => {
    const row = toSalesTitleMetricDto(input({
      contributors: [
        contributor(),
        contributor({
          balanceTransactionId: 'bt_dispute_fee_credit',
          sourceKind: 'dispute',
          effects: [{ component: 'fee_credit', effectMinor: 15 }]
        })
      ]
    }));

    expect(row).toMatchObject({
      disputeFeeImpactMinor: 15,
      estimatedPayoutMinor: 1_015
    });
  });

  it.each([
    ['partial', 200, -300],
    ['full', 500, 0]
  ] as const)(
    'applies a %s reinstatement against the exact signed withdrawal',
    (_label, reinstatementMinor, expectedDisputeImpact) => {
      const row = toSalesTitleMetricDto(input({
        disputeWithdrawalPresentmentMinor: 500,
        disputeReinstatementPresentmentMinor: reinstatementMinor,
        contributors: [
          contributor(),
          contributor({
            balanceTransactionId: 'bt_withdrawal',
            sourceKind: 'dispute',
            effects: [
              { component: 'dispute_subtotal', effectMinor: -500 },
              { component: 'dispute_tax', effectMinor: -40 }
            ]
          }),
          contributor({
            balanceTransactionId: `bt_reinstatement_${reinstatementMinor}`,
            sourceKind: 'dispute',
            effects: [{ component: 'dispute_reinstatement', effectMinor: reinstatementMinor }]
          })
        ]
      }));

      expect(row.disputeImpactMinor).toBe(expectedDisputeImpact);
      expect(row.estimatedPayoutMinor).toBe(1_000 + expectedDisputeImpact);
    }
  );

  it('excludes restored customer tax from a full dispute reinstatement', () => {
    const row = toSalesTitleMetricDto(input({
      contributors: [
        contributor({ effects: [{ component: 'sale_subtotal', effectMinor: 100 }] }),
        contributor({
          balanceTransactionId: 'bt_taxed_withdrawal',
          sourceKind: 'dispute',
          effects: [
            { component: 'dispute_subtotal', effectMinor: -100 },
            { component: 'dispute_tax', effectMinor: -10 }
          ]
        }),
        contributor({
          balanceTransactionId: 'bt_taxed_reinstatement',
          sourceKind: 'dispute',
          effects: [
            { component: 'dispute_reinstatement', effectMinor: 100 },
            { component: 'dispute_tax', effectMinor: 10 }
          ]
        })
      ]
    }));

    expect(row).toMatchObject({
      grossSettlementMinor: 100,
      disputeImpactMinor: 0,
      estimatedPayoutMinor: 100
    });
  });

  it('preserves a negative payout estimate as a numeric signed value', () => {
    const row = toSalesTitleMetricDto(input({
      contributors: [
        contributor({ effects: [{ component: 'sale_subtotal', effectMinor: 100 }] }),
        contributor({
          balanceTransactionId: 'bt_withdrawal',
          sourceKind: 'dispute',
          effects: [{ component: 'dispute_subtotal', effectMinor: -200 }]
        }),
        contributor({
          balanceTransactionId: 'bt_withdrawal',
          basis: 'fee',
          sourceKind: 'dispute',
          effects: [{ component: 'dispute_fee', effectMinor: -20 }]
        })
      ]
    }));

    expect(row.estimatedPayoutMinor).toBe(-120);
  });

  it('excludes account-scope effects, incompleteness, and state from title metrics', () => {
    const row = toSalesTitleMetricDto(input({
      contributors: [
        contributor(),
        contributor({
          balanceTransactionId: 'bt_account_adjustment',
          sourceKind: 'adjustment',
          scope: 'account',
          state: 'exception',
          availability: 'incompatible',
          missingSourceCount: 99,
          effects: [{ component: 'other', effectMinor: Number.MAX_SAFE_INTEGER }]
        })
      ]
    }));

    expect(row).toMatchObject({
      grossSettlementMinor: 1_000,
      otherFeeImpactMinor: 0,
      estimatedPayoutMinor: 1_000,
      settlementMetricsComplete: true,
      missingSourceCount: 0,
      state: 'payout_reconciled'
    });
  });

  it('fails closed instead of dropping an account-scoped payment contributor', () => {
    const row = toSalesTitleMetricDto(input({
      contributors: [
        contributor(),
        contributor({
          balanceTransactionId: 'bt_charge_account_fee',
          basis: 'fee', scope: 'account', effects: []
        })
      ]
    }));

    expectUnavailable(row, { missingSourceCount: 1, state: 'exception' });
  });

  it('accepts tax-safe v1 evidence and fails closed only for its combined reinstatement', () => {
    const safeLegacy = toSalesTitleMetricDto(input({
      contributors: [contributor({ algorithmVersion: 1 })]
    }));
    expect(safeLegacy).toMatchObject({
      grossSettlementMinor: 1_000,
      settlementMetricsComplete: true,
      missingSourceCount: 0
    });

    const combinedReinstatement = toSalesTitleMetricDto(input({
      contributors: [contributor({
        algorithmVersion: 1,
        balanceTransactionId: 'bt_legacy_reinstatement',
        sourceKind: 'dispute',
        effects: [{ component: 'dispute_reinstatement', effectMinor: 110 }]
      })]
    }));

    expectUnavailable(combinedReinstatement, { missingSourceCount: 1, state: 'exception' });
  });

  it('fails closed for an unsupported allocation algorithm contributor', () => {
    const row = toSalesTitleMetricDto(input({
      contributors: [contributor({ algorithmVersion: 3 })]
    }));

    expectUnavailable(row, { missingSourceCount: 1, state: 'exception' });
  });

  it.each([
    ['missing', 3, 'pending'],
    ['conflicting', 2, 'exception'],
    ['unresolved', 4, 'pending'],
    ['incompatible', 5, 'exception']
  ] as const)(
    'nulls every settlement metric for a %s contributor with its exact count',
    (availability, missingSourceCount, state) => {
      const row = toSalesTitleMetricDto(input({
        contributors: [contributor(), unavailableContributor(availability, missingSourceCount)]
      }));

      expectUnavailable(row, { missingSourceCount, state });
      expect(row.grossPresentmentMinor).toBe(1_080);
      expect(row.soldCopies).toBe(1);
    }
  );

  it('uses exception, pending, fee-reconciled, payout-reconciled severity order', () => {
    const payout = toSalesTitleMetricDto(input());
    const fee = toSalesTitleMetricDto(input({
      contributors: [contributor({ state: 'fee_reconciled' })]
    }));
    const pending = toSalesTitleMetricDto(input({
      contributors: [
        contributor(),
        unavailableContributor('missing', 1)
      ]
    }));
    const exception = toSalesTitleMetricDto(input({
      contributors: [
        unavailableContributor('missing', 1),
        unavailableContributor('conflicting', 1)
      ]
    }));

    expect([exception.state, pending.state, fee.state, payout.state]).toEqual([
      'exception',
      'pending',
      'fee_reconciled',
      'payout_reconciled'
    ]);
  });

  it('requires every complete contributor to have payout membership before payout reconciliation', () => {
    const row = toSalesTitleMetricDto(input({
      contributors: [
        contributor({ state: 'payout_reconciled' }),
        contributor({ basis: 'fee', state: 'fee_reconciled', effects: [] })
      ]
    }));

    expect(row.state).toBe('fee_reconciled');
  });

  it('fails closed when the same balance-transaction basis would contribute twice', () => {
    const row = toSalesTitleMetricDto(input({
      contributors: [
        contributor(),
        contributor({ effects: [{ component: 'sale_subtotal', effectMinor: 500 }] })
      ]
    }));

    expectUnavailable(row, { missingSourceCount: 1, state: 'exception' });
  });

  it.each([
    ['currency mismatch', contributor({ settlementCurrency: 'EUR' })],
    ['source/component mismatch', contributor({
      balanceTransactionId: 'bt_bad_source',
      sourceKind: 'refund',
      effects: [{ component: 'sale_subtotal', effectMinor: 1_000 }]
    })],
    ['fee-basis gross component', contributor({
      balanceTransactionId: 'bt_bad_fee_basis',
      basis: 'fee',
      effects: [{ component: 'sale_subtotal', effectMinor: 1_000 }]
    })],
    ['gross-basis fee component', contributor({
      balanceTransactionId: 'bt_bad_gross_basis',
      effects: [{ component: 'processing_fee', effectMinor: -100 }]
    })],
    ['title-scoped account adjustment', contributor({
      balanceTransactionId: 'bt_bad_adjustment',
      sourceKind: 'adjustment',
      effects: [{ component: 'other', effectMinor: 10 }]
    })]
  ] as const)('nulls rather than using an inferred incompatible %s', (_label, badContributor) => {
    const row = toSalesTitleMetricDto(input({ contributors: [badContributor] }));
    expectUnavailable(row, { missingSourceCount: 1, state: 'exception' });
  });

  it('constructs privacy-safe output without contributor or sold-as extra fields', () => {
    const unsafeInput = input({
      soldAsVariants: [{
        title: 'Pale Orbit',
        creatorName: 'A. Writer',
        format: 'prose',
        customerId: 'customer_secret'
      } as never],
      contributors: [{
        ...contributor(),
        providerCustomerId: 'cus_secret',
        rawEvidence: { card: 'unsafe' }
      } as never]
    });
    const row = toSalesTitleMetricDto(unsafeInput);
    const serialized = JSON.stringify(row);

    expect(Object.keys(row)).toEqual(TITLE_SALES_ROW_DTO_KEYS);
    expect(Object.keys(row.soldAsVariants[0]!)).toEqual(['title', 'creatorName', 'format']);
    expect(serialized).not.toContain('bt_sale');
    expect(serialized).not.toContain('customer_secret');
    expect(serialized).not.toContain('cus_secret');
    expect(serialized).not.toContain('rawEvidence');
  });

  it.each([
    ['unsafe input amount', Number.MAX_SAFE_INTEGER + 1, 0],
    ['positive overflow', Number.MAX_SAFE_INTEGER, 1],
    ['negative overflow', Number.MIN_SAFE_INTEGER, -1]
  ] as const)('fails closed on %s', (_label, first, second) => {
    expect(() => toSalesTitleMetricDto(input({
      contributors: [contributor({
        effects: [
          { component: 'sale_subtotal', effectMinor: first },
          { component: 'sale_subtotal', effectMinor: second }
        ]
      })]
    }))).toThrowError(expect.objectContaining({
      name: 'SalesMetricError',
      message: 'Sales metrics are unavailable.'
    }));
  });

  it('fails closed on invalid copy arithmetic and malformed missing counts', () => {
    expect(() => toSalesTitleMetricDto(input({
      soldCopies: 1,
      fullyRefundedCopies: 2
    }))).toThrowError(/Sales metrics are unavailable\./u);
    expect(() => toSalesTitleMetricDto(input({
      contributors: [unavailableContributor('missing', 0)]
    }))).toThrowError(/Sales metrics are unavailable\./u);
  });
});

describe('summarizeCurrencyPairs', () => {
  it('sums a complete currency pair with the exact summary DTO keys', () => {
    const rows = [
      toSalesTitleMetricDto(input()),
      toSalesTitleMetricDto(input({
        titleId: '22222222-2222-4222-8222-222222222222',
        currentTitle: 'Blue Noon',
        soldCopies: 2,
        fullyRefundedCopies: 1,
        grossPresentmentMinor: 2_160,
        finalizedRefundPresentmentMinor: 1_080,
        contributors: [
          contributor({
            balanceTransactionId: 'bt_second',
            state: 'fee_reconciled',
            effects: [{ component: 'sale_subtotal', effectMinor: 2_000 }]
          }),
          contributor({
            balanceTransactionId: 'bt_second',
            basis: 'fee',
            state: 'fee_reconciled',
            effects: [{ component: 'processing_fee', effectMinor: -100 }]
          }),
          contributor({
            balanceTransactionId: 'bt_second_refund',
            sourceKind: 'refund',
            state: 'fee_reconciled',
            effects: [{ component: 'refund_subtotal', effectMinor: -1_000 }]
          })
        ]
      }))
    ];

    const summaries = summarizeCurrencyPairs(rows);
    expect(summaries).toHaveLength(1);
    const summary: SalesCurrencySummaryDto = summaries[0]!;
    expect(Object.keys(summary)).toEqual(SALES_CURRENCY_SUMMARY_DTO_KEYS);
    expect(summary).toMatchObject({
      presentmentCurrency: 'USD',
      settlementCurrency: 'USD',
      titleCount: 2,
      soldCopies: 3,
      fullyRefundedCopies: 1,
      netCopies: 2,
      grossPresentmentMinor: 3_240,
      finalizedRefundPresentmentMinor: 1_080,
      grossSettlementMinor: 3_000,
      refundImpactMinor: -1_000,
      processingFeeImpactMinor: -100,
      estimatedPayoutMinor: 1_900,
      settlementMetricsComplete: true,
      missingSourceCount: 0,
      state: 'fee_reconciled'
    });
  });

  it('nulls a whole currency-pair settlement summary when one row is incomplete', () => {
    const complete = toSalesTitleMetricDto(input());
    const incomplete = toSalesTitleMetricDto(input({
      titleId: '22222222-2222-4222-8222-222222222222',
      soldCopies: 2,
      fullyRefundedCopies: 1,
      grossPresentmentMinor: 2_160,
      finalizedRefundPresentmentMinor: 1_080,
      contributors: [unavailableContributor('missing', 2)]
    }));

    const summary = summarizeCurrencyPairs([complete, incomplete])[0]!;
    for (const key of SETTLEMENT_KEYS) expect(summary[key]).toBeNull();
    expect(summary).toMatchObject({
      titleCount: 2,
      soldCopies: 3,
      fullyRefundedCopies: 1,
      netCopies: 2,
      grossPresentmentMinor: 3_240,
      finalizedRefundPresentmentMinor: 1_080,
      settlementMetricsComplete: false,
      missingSourceCount: 2,
      state: 'pending'
    });
  });

  it('retains exception severity over pending for an incomplete pair', () => {
    const pending = toSalesTitleMetricDto(input({
      contributors: [unavailableContributor('missing', 2)]
    }));
    const exception = toSalesTitleMetricDto(input({
      titleId: '22222222-2222-4222-8222-222222222222',
      contributors: [unavailableContributor('conflicting', 3)]
    }));

    expect(summarizeCurrencyPairs([pending, exception])[0]).toMatchObject({
      settlementMetricsComplete: false,
      missingSourceCount: 5,
      state: 'exception'
    });
  });

  it('returns currency pairs in deterministic code-point order with null settlement first', () => {
    const rows = [
      toSalesTitleMetricDto(input({
        titleId: '44444444-4444-4444-8444-444444444444',
        settlementCurrency: 'EUR',
        contributors: [contributor({ settlementCurrency: 'EUR' })]
      })),
      toSalesTitleMetricDto(input({
        titleId: '33333333-3333-4333-8333-333333333333',
        presentmentCurrency: 'EUR',
        settlementCurrency: 'USD',
        contributors: [contributor({ settlementCurrency: 'USD' })]
      })),
      toSalesTitleMetricDto(input({
        titleId: '22222222-2222-4222-8222-222222222222',
        settlementCurrency: null,
        contributors: [unavailableContributor('missing', 1, {
          settlementCurrency: null
        })]
      })),
      toSalesTitleMetricDto(input())
    ];

    const pairs = summarizeCurrencyPairs(rows).map((row) => [
      row.presentmentCurrency,
      row.settlementCurrency
    ]);
    expect(pairs).toEqual([
      ['EUR', 'USD'],
      ['USD', null],
      ['USD', 'EUR'],
      ['USD', 'USD']
    ]);
  });

  it('keeps null and named settlement pairs as distinct exact keys', () => {
    const pending = toSalesTitleMetricDto(input({
      settlementCurrency: null,
      contributors: [unavailableContributor('missing', 1, { settlementCurrency: null })]
    }));
    const usd = toSalesTitleMetricDto(input());

    const summaries = summarizeCurrencyPairs([usd, pending]);
    expect(summaries).toHaveLength(2);
    expect(summaries.map((row) => Object.keys(row))).toEqual([
      [...SALES_CURRENCY_SUMMARY_DTO_KEYS],
      [...SALES_CURRENCY_SUMMARY_DTO_KEYS]
    ]);
  });

  it('fails closed when presentment, settlement, or missing-count aggregation overflows', () => {
    const maxPresentment = toSalesTitleMetricDto(input({
      grossPresentmentMinor: Number.MAX_SAFE_INTEGER
    }));
    const onePresentment = toSalesTitleMetricDto(input({
      titleId: '22222222-2222-4222-8222-222222222222',
      grossPresentmentMinor: 1,
      contributors: [contributor({ balanceTransactionId: 'bt_second' })]
    }));
    expect(() => summarizeCurrencyPairs([maxPresentment, onePresentment]))
      .toThrowError(/Sales metrics are unavailable\./u);

    const maxSettlement = toSalesTitleMetricDto(input({
      contributors: [contributor({
        effects: [{ component: 'sale_subtotal', effectMinor: Number.MAX_SAFE_INTEGER }]
      })]
    }));
    const oneSettlement = toSalesTitleMetricDto(input({
      titleId: '22222222-2222-4222-8222-222222222222',
      contributors: [contributor({
        balanceTransactionId: 'bt_second',
        effects: [{ component: 'sale_subtotal', effectMinor: 1 }]
      })]
    }));
    expect(() => summarizeCurrencyPairs([maxSettlement, oneSettlement]))
      .toThrowError(/Sales metrics are unavailable\./u);

    const maxMissing = toSalesTitleMetricDto(input({
      contributors: [unavailableContributor('missing', Number.MAX_SAFE_INTEGER)]
    }));
    const oneMissing = toSalesTitleMetricDto(input({
      titleId: '22222222-2222-4222-8222-222222222222',
      contributors: [unavailableContributor('missing', 1, {
        balanceTransactionId: 'bt_second_missing'
      })]
    }));
    expect(() => summarizeCurrencyPairs([maxMissing, oneMissing]))
      .toThrowError(/Sales metrics are unavailable\./u);
  });
});
