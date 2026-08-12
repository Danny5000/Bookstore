import { PermanentFinancialError } from './errors';
import type { PublicFinancialState, PublicFinancialStateInput } from './types';

const MAX_INT32 = 2_147_483_647;

const PUBLIC_STATE_INPUT_KEYS = ['financialEvidenceStatus', 'payoutEvidence'] as const;
const PAYOUT_EVIDENCE_KEYS = [
	'relevantBalanceTransactionCount',
	'authoritativeMembershipCount',
	'paidAutomaticStandardCompletedCount',
	'conflictingMembershipCount',
	'hasOpenExceptionIssue',
	'hasMissingPayoutReversal'
] as const;

function hasExactOwnKeys<const Key extends string>(
	value: unknown,
	expectedKeys: readonly Key[]
): value is Record<Key, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}

	return (
		Reflect.ownKeys(value).length === expectedKeys.length &&
		expectedKeys.every((key) => Object.hasOwn(value, key))
	);
}

function isNonnegativeInt32(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_INT32;
}

function rejectUnsupportedEvidence(): never {
	throw new PermanentFinancialError('unsupported_provider_evidence');
}

export function derivePublicFinancialState(
	input: PublicFinancialStateInput
): PublicFinancialState {
	if (!hasExactOwnKeys(input, PUBLIC_STATE_INPUT_KEYS)) {
		rejectUnsupportedEvidence();
	}

	const { financialEvidenceStatus, payoutEvidence } = input;
	if (
		financialEvidenceStatus !== 'pending' &&
		financialEvidenceStatus !== 'fee_reconciled' &&
		financialEvidenceStatus !== 'exception'
	) {
		rejectUnsupportedEvidence();
	}
	if (!hasExactOwnKeys(payoutEvidence, PAYOUT_EVIDENCE_KEYS)) {
		rejectUnsupportedEvidence();
	}

	const {
		relevantBalanceTransactionCount,
		authoritativeMembershipCount,
		paidAutomaticStandardCompletedCount,
		conflictingMembershipCount,
		hasOpenExceptionIssue,
		hasMissingPayoutReversal
	} = payoutEvidence;
	if (
		!isNonnegativeInt32(relevantBalanceTransactionCount) ||
		!isNonnegativeInt32(authoritativeMembershipCount) ||
		!isNonnegativeInt32(paidAutomaticStandardCompletedCount) ||
		!isNonnegativeInt32(conflictingMembershipCount) ||
		typeof hasOpenExceptionIssue !== 'boolean' ||
		typeof hasMissingPayoutReversal !== 'boolean' ||
		authoritativeMembershipCount > relevantBalanceTransactionCount ||
		paidAutomaticStandardCompletedCount > authoritativeMembershipCount ||
		conflictingMembershipCount > relevantBalanceTransactionCount
	) {
		rejectUnsupportedEvidence();
	}

	if (financialEvidenceStatus === 'exception') {
		return 'exception';
	}
	if (hasOpenExceptionIssue || hasMissingPayoutReversal || conflictingMembershipCount > 0) {
		return 'exception';
	}
	if (financialEvidenceStatus === 'pending') {
		return 'pending';
	}
	if (
		relevantBalanceTransactionCount > 0 &&
		authoritativeMembershipCount === relevantBalanceTransactionCount &&
		paidAutomaticStandardCompletedCount === relevantBalanceTransactionCount
	) {
		return 'payout_reconciled';
	}

	return 'fee_reconciled';
}
