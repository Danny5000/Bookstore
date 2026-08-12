import { describe, expect, it } from 'vitest';

import { PermanentFinancialError } from './errors';
import { derivePublicFinancialState } from './state';
import type {
	CurrentPayoutEvidence,
	FinancialEvidenceStatus,
	PublicFinancialStateInput
} from './types';

const qualifyingEvidence: CurrentPayoutEvidence = {
	relevantBalanceTransactionCount: 1,
	authoritativeMembershipCount: 1,
	paidAutomaticStandardCompletedCount: 1,
	conflictingMembershipCount: 0,
	hasOpenExceptionIssue: false,
	hasMissingPayoutReversal: false
};

function stateInput(
	financialEvidenceStatus: FinancialEvidenceStatus = 'fee_reconciled',
	overrides: Partial<CurrentPayoutEvidence> = {}
): PublicFinancialStateInput {
	return {
		financialEvidenceStatus,
		payoutEvidence: { ...qualifyingEvidence, ...overrides }
	};
}

function expectUnsupportedProviderEvidence(input: unknown): void {
	try {
		derivePublicFinancialState(input as PublicFinancialStateInput);
		expect.unreachable('expected malformed public financial state input to be rejected');
	} catch (error) {
		expect(error).toBeInstanceOf(PermanentFinancialError);
		expect(error).toMatchObject({ safeCode: 'unsupported_provider_evidence' });
		expect(Object.hasOwn(error as object, 'cause')).toBe(false);
	}
}

describe('derivePublicFinancialState', () => {
	it.each([
		{
			name: 'preserves a persisted exception',
			input: stateInput('exception'),
			expected: 'exception'
		},
		{
			name: 'turns an open exception issue into an exception',
			input: stateInput('fee_reconciled', { hasOpenExceptionIssue: true }),
			expected: 'exception'
		},
		{
			name: 'turns a missing payout reversal into an exception',
			input: stateInput('fee_reconciled', { hasMissingPayoutReversal: true }),
			expected: 'exception'
		},
		{
			name: 'turns conflicting membership into an exception',
			input: stateInput('fee_reconciled', { conflictingMembershipCount: 1 }),
			expected: 'exception'
		},
		{
			name: 'lets an evidence exception outrank a persisted pending state',
			input: stateInput('pending', { hasOpenExceptionIssue: true }),
			expected: 'exception'
		},
		{
			name: 'preserves pending when otherwise eligible for promotion',
			input: stateInput('pending'),
			expected: 'pending'
		},
		{
			name: 'promotes complete qualifying payout evidence',
			input: stateInput(),
			expected: 'payout_reconciled'
		},
		{
			name: 'keeps zero relevant transactions fee reconciled',
			input: stateInput('fee_reconciled', {
				relevantBalanceTransactionCount: 0,
				authoritativeMembershipCount: 0,
				paidAutomaticStandardCompletedCount: 0
			}),
			expected: 'fee_reconciled'
		},
		{
			name: 'does not promote incomplete authoritative membership',
			input: stateInput('fee_reconciled', {
				relevantBalanceTransactionCount: 2,
				authoritativeMembershipCount: 1,
				paidAutomaticStandardCompletedCount: 1
			}),
			expected: 'fee_reconciled'
		},
		{
			name: 'does not promote manual, instant, or nonpaid membership',
			input: stateInput('fee_reconciled', {
				relevantBalanceTransactionCount: 2,
				authoritativeMembershipCount: 2,
				paidAutomaticStandardCompletedCount: 1
			}),
			expected: 'fee_reconciled'
		},
		{
			name: 'promotes only when every relevant membership qualifies',
			input: stateInput('fee_reconciled', {
				relevantBalanceTransactionCount: 2,
				authoritativeMembershipCount: 2,
				paidAutomaticStandardCompletedCount: 2
			}),
			expected: 'payout_reconciled'
		}
	])('$name', ({ input, expected }) => {
		expect(derivePublicFinancialState(input)).toBe(expected);
	});

	it.each([
		['a missing outer key', { payoutEvidence: qualifyingEvidence }],
		[
			'an extra outer key',
			{ ...stateInput(), unexpected: true }
		],
		[
			'an inherited outer key',
			Object.assign(Object.create({ financialEvidenceStatus: 'fee_reconciled' }), {
				payoutEvidence: qualifyingEvidence
			})
		],
		[
			'an unsupported persisted status',
			{ ...stateInput(), financialEvidenceStatus: 'payout_reconciled' }
		],
		[
			'a missing evidence key',
			{
				financialEvidenceStatus: 'fee_reconciled',
				payoutEvidence: {
					relevantBalanceTransactionCount: 1,
					authoritativeMembershipCount: 1,
					paidAutomaticStandardCompletedCount: 1,
					conflictingMembershipCount: 0,
					hasOpenExceptionIssue: false
				}
			}
		],
		[
			'an extra evidence key',
			stateInput('fee_reconciled', { unexpected: true } as Partial<CurrentPayoutEvidence>)
		],
		[
			'an inherited evidence key',
			{
				financialEvidenceStatus: 'fee_reconciled',
				payoutEvidence: Object.assign(
					Object.create({ relevantBalanceTransactionCount: 1 }),
					{
						authoritativeMembershipCount: 1,
						paidAutomaticStandardCompletedCount: 1,
						conflictingMembershipCount: 0,
						hasOpenExceptionIssue: false,
						hasMissingPayoutReversal: false
					}
				)
			}
		],
		['a null evidence object', { ...stateInput(), payoutEvidence: null }],
		[
			'a negative count',
			stateInput('fee_reconciled', { relevantBalanceTransactionCount: -1 })
		],
		[
			'a fractional count',
			stateInput('fee_reconciled', { relevantBalanceTransactionCount: 0.5 })
		],
		[
			'a count above int32',
			stateInput('fee_reconciled', {
				relevantBalanceTransactionCount: 2_147_483_648
			})
		],
		[
			'a non-finite count',
			stateInput('fee_reconciled', { relevantBalanceTransactionCount: Number.NaN })
		],
		[
			'a non-boolean exception flag',
			stateInput('fee_reconciled', {
				hasOpenExceptionIssue: 0 as unknown as boolean
			})
		],
		[
			'more authoritative memberships than relevant transactions',
			stateInput('fee_reconciled', {
				relevantBalanceTransactionCount: 1,
				authoritativeMembershipCount: 2,
				paidAutomaticStandardCompletedCount: 1
			})
		],
		[
			'more qualifying memberships than authoritative memberships',
			stateInput('fee_reconciled', {
				relevantBalanceTransactionCount: 2,
				authoritativeMembershipCount: 1,
				paidAutomaticStandardCompletedCount: 2
			})
		],
		[
			'more conflicts than relevant transactions',
			stateInput('fee_reconciled', {
				relevantBalanceTransactionCount: 1,
				conflictingMembershipCount: 2
			})
		]
	])('rejects %s with a cause-free bounded error', (_name, input) => {
		expectUnsupportedProviderEvidence(input);
	});

	it('does not mutate its input', () => {
		const input = stateInput();
		const before = structuredClone(input);

		derivePublicFinancialState(input);

		expect(input).toEqual(before);
	});
});
