import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  FinancialAdminCommandReferenceDto,
  FinancialAdminCommandStatusDto,
  RefundDetailDto,
  RefundFinalizationPreviewDto,
  RefundReportingCorrectionPreviewDto,
  RefundReportingCorrectionSeedDto
} from '$lib/types/financial-reporting';

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn() }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));

import RefundAllocationEditor from './RefundAllocationEditor.svelte';
import FinancialActionOutcome from './FinancialActionOutcome.svelte';
import FinancialCommandStatus from './FinancialCommandStatus.svelte';
import ReportingCorrectionEditor from './ReportingCorrectionEditor.svelte';
import RefundReviewPage from '../../../routes/admin/sales/refunds/[refundId]/+page.svelte';

const REFUND_ID = '00000000-0000-4000-8000-000000011401';
const FIRST_ITEM_ID = '00000000-0000-4000-8000-000000011402';
const SECOND_ITEM_ID = '00000000-0000-4000-8000-000000011403';
const DRAFT_ID = '00000000-0000-4000-8000-000000011404';
const COMMAND_ID = '00000000-0000-4000-8000-000000011405';
const SAVE_KEY = '00000000-0000-4000-8000-000000011406';
const DISCARD_KEY = '00000000-0000-4000-8000-000000011407';
const FINALIZE_KEY = '00000000-0000-4000-8000-000000011412';
const CORRECTION_KEY = '00000000-0000-4000-8000-000000011413';
const BASE_ALLOCATION_SET_ID = '00000000-0000-4000-8000-000000011414';
const RAW_CORRECTION_SET_ID = '00000000-0000-4000-8000-000000011415';
const PREVIEW_FINGERPRINT = 'b'.repeat(64);
const SOURCE_FINGERPRINT = 'c'.repeat(64);

function finalizationPreview(
  overrides: Partial<RefundFinalizationPreviewDto> = {}
): RefundFinalizationPreviewDto {
  return {
    refundId: REFUND_ID,
    expectedActiveDraftVersion: 2,
    previewFingerprint: PREVIEW_FINGERPRINT,
    currency: 'USD',
    proposedTotalMinor: 500,
    remainderMinor: 0,
    items: [
      {
        orderItemId: FIRST_ITEM_ID,
        titleId: '00000000-0000-4000-8000-000000011409',
        soldAsTitle: 'First title',
        proposedTotalMinor: 300,
        proposedSubtotalMinor: 270,
        proposedTaxMinor: 30,
        wouldBeFullyRefunded: true,
        purchaseGrantWouldBeRevoked: true,
        otherActiveGrantPreservesAccess: false,
        effectiveAccessWouldChange: true,
        emailQueued: true
      },
      {
        orderItemId: SECOND_ITEM_ID,
        titleId: '00000000-0000-4000-8000-000000011410',
        soldAsTitle: 'Second title',
        proposedTotalMinor: 200,
        proposedSubtotalMinor: 180,
        proposedTaxMinor: 20,
        wouldBeFullyRefunded: false,
        purchaseGrantWouldBeRevoked: false,
        otherActiveGrantPreservesAccess: true,
        effectiveAccessWouldChange: false,
        emailQueued: false
      }
    ],
    ...overrides
  };
}

function correctionSeed(
  overrides: Partial<RefundReportingCorrectionSeedDto> = {}
): RefundReportingCorrectionSeedDto {
  return {
    refundId: REFUND_ID,
    reason: 'allocation_attribution_correction',
    expectedNextCorrectionVersion: 2,
    expectedBaseAllocationSetId: BASE_ALLOCATION_SET_ID,
    expectedSourceFingerprint: SOURCE_FINGERPRINT,
    rawPredecessorCorrectionSetId: RAW_CORRECTION_SET_ID,
    compatibleCorrectionSetId: RAW_CORRECTION_SET_ID,
    baselineKind: 'compatible_correction',
    currentReportingComplete: true,
    currency: 'USD',
    settlementCurrency: 'USD',
    baselineTotalMinor: 500,
    eligible: true,
    ineligibleReason: null,
    items: [
      {
        orderItemId: FIRST_ITEM_ID,
        titleId: '00000000-0000-4000-8000-000000011409',
        soldAsTitle: 'First title',
        baselineTotalMinor: 300,
        baselineSubtotalMinor: 270,
        baselineTaxMinor: 30,
        baselineSettlementGrossMinor: 285,
        baselineRefundFeeImpactMinor: -15
      },
      {
        orderItemId: SECOND_ITEM_ID,
        titleId: '00000000-0000-4000-8000-000000011410',
        soldAsTitle: 'Second title',
        baselineTotalMinor: 200,
        baselineSubtotalMinor: 180,
        baselineTaxMinor: 20,
        baselineSettlementGrossMinor: 190,
        baselineRefundFeeImpactMinor: -10
      }
    ],
    ...overrides
  };
}

function correctionPreview(
  overrides: Partial<RefundReportingCorrectionPreviewDto> = {}
): RefundReportingCorrectionPreviewDto {
  return {
    refundId: REFUND_ID,
    expectedBaseAllocationSetId: BASE_ALLOCATION_SET_ID,
    rawPredecessorCorrectionSetId: RAW_CORRECTION_SET_ID,
    compatibleCorrectionSetId: RAW_CORRECTION_SET_ID,
    expectedNextCorrectionVersion: 2,
    expectedSourceFingerprint: SOURCE_FINGERPRINT,
    previewFingerprint: PREVIEW_FINGERPRINT,
    baselineKind: 'compatible_correction',
    currentReportingComplete: true,
    proposedReportingComplete: true,
    compatibilityRepair: false,
    currency: 'USD',
    settlementCurrency: 'USD',
    baselineTotalMinor: 500,
    proposedTotalMinor: 500,
    eligible: true,
    ineligibleReason: null,
    items: [
      {
        orderItemId: FIRST_ITEM_ID,
        titleId: '00000000-0000-4000-8000-000000011409',
        soldAsTitle: 'First title',
        baselineTotalMinor: 300,
        baselineSubtotalMinor: 270,
        baselineTaxMinor: 30,
        proposedTotalMinor: 325,
        proposedSubtotalMinor: 290,
        proposedTaxMinor: 35,
        subtotalDisplayDeltaMinor: 20,
        taxDisplayDeltaMinor: 5,
        baselineSettlementGrossMinor: 285,
        proposedSettlementGrossMinor: 305,
        settlementGrossDisplayDeltaMinor: 20,
        baselineRefundFeeImpactMinor: -15,
        proposedRefundFeeImpactMinor: -14,
        refundFeeImpactDisplayDeltaMinor: 1
      },
      {
        orderItemId: SECOND_ITEM_ID,
        titleId: '00000000-0000-4000-8000-000000011410',
        soldAsTitle: 'Second title',
        baselineTotalMinor: 200,
        baselineSubtotalMinor: 180,
        baselineTaxMinor: 20,
        proposedTotalMinor: 175,
        proposedSubtotalMinor: 160,
        proposedTaxMinor: 15,
        subtotalDisplayDeltaMinor: -20,
        taxDisplayDeltaMinor: -5,
        baselineSettlementGrossMinor: 190,
        proposedSettlementGrossMinor: 170,
        settlementGrossDisplayDeltaMinor: -20,
        baselineRefundFeeImpactMinor: -10,
        proposedRefundFeeImpactMinor: -11,
        refundFeeImpactDisplayDeltaMinor: -1
      }
    ],
    ...overrides
  };
}

function detail(overrides: Partial<RefundDetailDto> = {}): RefundDetailDto {
  return {
    refundId: REFUND_ID,
    orderId: '00000000-0000-4000-8000-000000011408',
    status: 'succeeded',
    allocationStatus: 'draft',
    financialState: 'fee_reconciled',
    amountMinor: 500,
    currency: 'USD',
    orderSubtotalMinor: 900,
    orderTaxMinor: 100,
    orderTotalMinor: 1000,
    items: [
      {
        orderItemId: FIRST_ITEM_ID,
        titleId: '00000000-0000-4000-8000-000000011409',
        soldAsTitle: 'First title',
        soldAsCreatorName: 'First creator',
        format: 'prose',
        paidSubtotalMinor: 540,
        paidTaxMinor: 60,
        paidTotalMinor: 600,
        currency: 'USD',
        finalizedRefundTotalMinor: 100,
        remainingRefundCapacityMinor: 500
      },
      {
        orderItemId: SECOND_ITEM_ID,
        titleId: '00000000-0000-4000-8000-000000011410',
        soldAsTitle: 'Second title',
        soldAsCreatorName: 'Second creator',
        format: 'comic',
        paidSubtotalMinor: 360,
        paidTaxMinor: 40,
        paidTotalMinor: 400,
        currency: 'USD',
        finalizedRefundTotalMinor: 0,
        remainingRefundCapacityMinor: 400
      }
    ],
    finalizedAllocations: [],
    draft: {
      draftId: DRAFT_ID,
      version: 2,
      state: 'active',
      lastEditedBy: 'another_administrator',
      updatedAt: '2026-08-22T12:02:00.000Z',
      proposedTotalMinor: 500,
      remainderMinor: 0,
      items: [
        { orderItemId: FIRST_ITEM_ID, proposedTotalMinor: 300 },
        { orderItemId: SECOND_ITEM_ID, proposedTotalMinor: 200 }
      ]
    },
    finalizationPreview: null,
    correctionPreview: null,
    recoveryPreviews: [],
    openIssueCount: 1,
    dataThroughAt: '2026-08-22T12:03:00.000Z',
    createdAt: '2026-08-22T12:00:00.000Z',
    updatedAt: '2026-08-22T12:01:00.000Z',
    ...overrides
  };
}

function command(
  overrides: Partial<FinancialAdminCommandReferenceDto> = {}
): FinancialAdminCommandReferenceDto {
  return {
    commandId: COMMAND_ID,
    kind: 'refund_draft_save',
    status: 'pending',
    createdAt: '2026-08-22T12:04:00.000Z',
    ...overrides
  };
}

describe('accessible shared refund draft editor', () => {
  it('renders keyboard-native fields, exact limits, linked help, totals, and separate idempotency keys', () => {
    const body = render(RefundAllocationEditor, {
      props: {
        detail: detail(),
        saveIdempotencyKey: SAVE_KEY,
        discardIdempotencyKey: DISCARD_KEY,
        reviewCursor: 'bounded_cursor',
        fieldErrors: { [FIRST_ITEM_ID]: 'Enter a valid amount.' }
      }
    }).body;

    expect(body).toContain('<form');
    expect(body).toContain('method="POST"');
    expect(body).toContain('?/saveDraft');
    expect(body).toContain('?/discardDraft');
    expect(body).toContain(`name="idempotencyKey" value="${SAVE_KEY}"`);
    expect(body).toContain(`name="idempotencyKey" value="${DISCARD_KEY}"`);
    expect(body).toContain('name="expectedVersion" value="2"');
    expect(body).toContain('name="expectedActiveDraftVersion" value="2"');
    expect(body.match(/name="orderItemId"/gu)).toHaveLength(2);
    expect(body.match(/name="totalPresentmentMinor"/gu)).toHaveLength(2);
    expect(body).toMatch(/type="number"[^>]*min="0"[^>]*max="500"/u);
    expect(body).toContain('aria-describedby=');
    expect(body).toContain('Enter a valid amount.');
    expect(body).toContain('Draft total');
    expect(body).toContain('Remaining to allocate');
    expect(body).toContain('Edited by another administrator');
    expect(body).toContain('2026-08-22T12:02:00.000Z');
    expect(body).not.toContain('window.confirm');

    const prepareForm = body.match(
      /<form[^>]*action="\?\/prepareFinalize&amp;reviewCursor=bounded_cursor"[^>]*>[\s\S]*?<\/form>/u
    )?.[0];
    expect(prepareForm).toContain('name="expectedActiveDraftVersion" value="2"');
    expect(prepareForm).toContain('Review finalization consequences');
    expect(prepareForm).toContain(
      'Save any changes first. The preview uses the last saved shared draft.'
    );
    expect(prepareForm).not.toContain('idempotencyKey');
  });

  it('renders creation with a blank version and no discard control', () => {
    const body = render(RefundAllocationEditor, {
      props: {
        detail: detail({ allocationStatus: 'needs_review', draft: null }),
        saveIdempotencyKey: SAVE_KEY,
        discardIdempotencyKey: DISCARD_KEY,
        reviewCursor: null
      }
    }).body;
    expect(body).toContain('name="expectedVersion" value=""');
    expect(body).toContain('Draft total must equal the refund total');
    expect(body).toContain('refund-allocation-total-error');
    expect(body).not.toContain('Discard shared draft');
    expect(body).not.toContain('Review finalization consequences');
  });
});

describe('append-only reporting correction editor', () => {
  it('renders the eligible seed as a keyboard-native, field-linked full-item prepare form', () => {
    const body = render(ReportingCorrectionEditor, {
      props: {
        seed: correctionSeed(),
        preview: undefined,
        confirmIdempotencyKey: CORRECTION_KEY,
        reviewCursor: 'bounded_cursor',
        fieldErrors: { [FIRST_ITEM_ID]: 'Enter a valid attribution amount.' }
      }
    }).body;

    expect(body).toContain('Reporting attribution correction');
    expect(body).toContain('Reporting only — this does not restore or revoke access.');
    expect(body).toMatch(/Current reporting:<\/strong>\s*Complete/u);
    expect(body).toMatch(/Baseline:<\/strong>\s*Compatible correction/u);
    expect(body).toContain('?/prepareCorrection&amp;reviewCursor=bounded_cursor');
    expect(body).toContain('name="reason" value="allocation_attribution_correction"');
    expect(body).toContain('name="expectedNextCorrectionVersion" value="2"');
    expect(body).toContain(
      `name="expectedBaseAllocationSetId" value="${BASE_ALLOCATION_SET_ID}"`
    );
    expect(body).toContain(
      `name="expectedSourceFingerprint" value="${SOURCE_FINGERPRINT}"`
    );
    expect(body.match(/name="orderItemId"/gu)).toHaveLength(2);
    expect(body.match(/name="totalPresentmentMinor"/gu)).toHaveLength(2);
    expect(body).toContain(`name="orderItemId" value="${FIRST_ITEM_ID}"`);
    expect(body).toMatch(/type="number"[^>]*min="0"[^>]*max="99999999"[^>]*step="1"/u);
    expect(body).toContain('aria-describedby=');
    expect(body).toContain('Enter a valid attribution amount.');
    expect(body).toMatch(new RegExp(
      `id="reporting-correction-${FIRST_ITEM_ID}"[^>]*autofocus`,
      'u'
    ));
    expect(body.match(/autofocus/gu)).toHaveLength(1);
    expect(body).toContain('Review reporting correction');
    expect(body).not.toContain('idempotencyKey');
    expect(body).not.toContain('window.confirm');
  });

  it.each([
    ['provider_evidence_pending', 'Provider evidence is still pending.'],
    ['immutable_conflict', 'The immutable reporting evidence is inconsistent.'],
    ['not_finalized', 'Finalize this refund allocation before correcting reporting.']
  ] as const)('shows safe %s guidance without a mutation form', (ineligibleReason, copy) => {
    const body = render(ReportingCorrectionEditor, {
      props: {
        seed: correctionSeed({
          eligible: false,
          ineligibleReason,
          expectedNextCorrectionVersion: null,
          expectedBaseAllocationSetId: null,
          expectedSourceFingerprint: null,
          rawPredecessorCorrectionSetId: null,
          compatibleCorrectionSetId: null,
          baselineKind: null,
          currency: null,
          settlementCurrency: null,
          baselineTotalMinor: null,
          items: []
        }),
        preview: undefined,
        confirmIdempotencyKey: CORRECTION_KEY,
        reviewCursor: null
      }
    }).body;

    expect(body).toContain(copy);
    expect(body).toContain('Reporting only — this does not restore or revoke access.');
    expect(body).not.toContain('<form');
    expect(body).not.toContain(CORRECTION_KEY);
  });

  it('renders old, proposed, and display deltas with one explicit native confirmation', () => {
    const body = render(ReportingCorrectionEditor, {
      props: {
        seed: correctionSeed(),
        preview: correctionPreview(),
        confirmIdempotencyKey: CORRECTION_KEY,
        reviewCursor: 'bounded_cursor'
      }
    }).body;

    expect(body).toContain('Review reporting correction');
    expect(body).toMatch(/Current reporting:<\/strong>\s*Complete/u);
    expect(body).toMatch(/Proposed reporting:<\/strong>\s*Complete/u);
    expect(body).toContain('Baseline subtotal');
    expect(body).toContain('Proposed subtotal');
    expect(body).toContain('Subtotal change');
    expect(body).toContain('Tax change');
    expect(body).toContain('Settlement gross change');
    expect(body).toContain('Refund fee impact change');
    expect(body).toContain('Append this reporting correction');
    expect(body).toContain('?/confirmCorrection&amp;reviewCursor=bounded_cursor');
    expect(body).toContain(`name="idempotencyKey" value="${CORRECTION_KEY}"`);
    expect(body).toContain('name="reason" value="allocation_attribution_correction"');
    expect(body).toContain('name="expectedNextCorrectionVersion" value="2"');
    expect(body).toContain(
      `name="expectedBaseAllocationSetId" value="${BASE_ALLOCATION_SET_ID}"`
    );
    expect(body).toContain(
      `name="expectedSourceFingerprint" value="${SOURCE_FINGERPRINT}"`
    );
    expect(body.match(/name="orderItemId"/gu)).toHaveLength(2);
    expect(body).toContain('name="totalPresentmentMinor" value="325"');
    expect(body).toContain('name="totalPresentmentMinor" value="175"');
    expect(body).toContain(`name="previewFingerprint" value="${PREVIEW_FINGERPRINT}"`);
    expect(body).toContain('name="confirmation" value="create_reporting_correction"');
    expect(body.match(/<form\b/gu)).toHaveLength(1);
    expect(body.match(/<button[^>]*type="submit"/gu)).toHaveLength(1);
    expect(body).not.toContain('?/prepareCorrection');
    expect(body).not.toContain('window.confirm');

    const source = readFileSync(
      new URL('./ReportingCorrectionEditor.svelte', import.meta.url),
      'utf8'
    );
    expect(source).toContain('overflow-x: auto');
    expect(source).toContain('role="region"');
    expect(source).not.toMatch(/window\.confirm|fetch\(|use:enhance/iu);
  });

  it('keeps a numeric-zero raw-history repair confirmable and explains append-only history', () => {
    const repairedItems = correctionPreview().items.map((item) => ({
      ...item,
      proposedTotalMinor: item.baselineTotalMinor,
      proposedSubtotalMinor: item.baselineSubtotalMinor,
      proposedTaxMinor: item.baselineTaxMinor,
      subtotalDisplayDeltaMinor: 0,
      taxDisplayDeltaMinor: 0,
      proposedSettlementGrossMinor: item.baselineSettlementGrossMinor,
      settlementGrossDisplayDeltaMinor: 0,
      proposedRefundFeeImpactMinor: item.baselineRefundFeeImpactMinor,
      refundFeeImpactDisplayDeltaMinor: 0
    }));
    const body = render(ReportingCorrectionEditor, {
      props: {
        seed: correctionSeed({
          rawPredecessorCorrectionSetId: RAW_CORRECTION_SET_ID,
          compatibleCorrectionSetId: null,
          baselineKind: 'immutable_base',
          currentReportingComplete: false
        }),
        preview: correctionPreview({
          compatibleCorrectionSetId: null,
          baselineKind: 'immutable_base',
          currentReportingComplete: false,
          proposedReportingComplete: true,
          compatibilityRepair: true,
          items: repairedItems
        }),
        confirmIdempotencyKey: CORRECTION_KEY,
        reviewCursor: null
      }
    }).body;

    expect(body).toContain('Raw-history compatibility repair');
    expect(body).toContain('This appends a compatible successor; it does not rewrite correction history.');
    expect(body).toMatch(/Current reporting:<\/strong>\s*Incomplete/u);
    expect(body).toMatch(/Proposed reporting:<\/strong>\s*Complete/u);
    expect(body).toContain('Append this reporting correction');
    expect(body).toContain('name="totalPresentmentMinor" value="300"');
    expect(body).toContain('name="totalPresentmentMinor" value="200"');
  });

  it('renders already-complete no-change guidance without a confirmation form', () => {
    const body = render(ReportingCorrectionEditor, {
      props: {
        seed: correctionSeed(),
        preview: correctionPreview({
          previewFingerprint: null,
          eligible: false,
          ineligibleReason: 'no_change',
          compatibilityRepair: false
        }),
        confirmIdempotencyKey: CORRECTION_KEY,
        reviewCursor: null
      }
    }).body;

    expect(body).toContain('The proposed attribution already matches complete reporting.');
    expect(body).not.toContain('<form');
    expect(body).not.toContain(CORRECTION_KEY);
  });
});

describe('safe financial command outcome and polling', () => {
  it('renders a non-JavaScript-safe command reference, status, reload link, and live region', () => {
    const body = render(FinancialActionOutcome, {
      props: { command: command(), reloadHref: `/admin/sales/refunds/${REFUND_ID}` }
    }).body;
    expect(body).toContain(COMMAND_ID);
    expect(body).toContain('Pending');
    expect(body).toMatch(/role="status"[^>]*aria-live="polite"/u);
    expect(body).toContain('Reload current refund facts');
    expect(body).not.toMatch(/jobId|privateInput|correlationId|providerId/iu);
  });

  it('labels a terminal replay without adding any resubmission control', () => {
    const body = render(FinancialCommandStatus, {
      props: { command: command({ status: 'succeeded' }) }
    }).body;
    expect(body).toContain('Succeeded');
    expect(body).not.toMatch(/<form|submit|Try again/iu);
  });

  it.each([
    ['draft_saved', 'refund_draft_save', {
      refundId: REFUND_ID, draftVersion: 2, changed: true
    }, 'Shared refund draft saved at version 2.'],
    ['draft_discarded', 'refund_draft_discard', {
      refundId: REFUND_ID, draftVersion: 3, changed: true
    }, 'Shared refund draft version 3 discarded.'],
    ['allocation_finalized', 'refund_allocation_finalize', {
      refundId: REFUND_ID, finalizedDraftVersion: 4, accessChanged: true, emailQueued: true
    }, 'Refund allocation version 4 finalized. Access changed. Customer email queued.'],
    ['correction_created', 'refund_reporting_correction_create', {
      refundId: REFUND_ID, correctionSetId: DRAFT_ID, correctionVersion: 5
    }, 'Reporting correction version 5 created.'],
    ['recovery_activated', 'administrative_recovery_activate', {
      recoveryGrantId: DRAFT_ID, accessChanged: true, emailQueued: false
    }, 'Administrative recovery activated. Access changed. No customer email was queued.'],
    ['recovery_deactivated', 'administrative_recovery_deactivate', {
      recoveryGrantId: DRAFT_ID, accessChanged: false, emailQueued: true
    }, 'Administrative recovery deactivated. Access was unchanged. Customer email queued.'],
    ['capability_revoked', 'refund_draft_save', null,
      'Your financial administrator permission changed before this command ran.'],
    ['stale_state', 'refund_draft_save', null,
      'The financial facts changed before this command ran.'],
    ['not_eligible', 'refund_allocation_finalize', null,
      'The requested action is no longer eligible.'],
    ['invalid_command', 'refund_draft_save', null,
      'The command could not be accepted.'],
    ['command_failed', 'refund_draft_save', null,
      'The command could not be completed.']
  ] as const)('renders bounded guidance for %s without raw result identifiers or resubmission', (
    resultCode,
    kind,
    result,
    expected
  ) => {
    const status = resultCode === 'capability_revoked'
      ? 'denied'
      : resultCode === 'stale_state' || resultCode === 'not_eligible'
        ? 'conflict'
        : resultCode === 'invalid_command' || resultCode === 'command_failed'
          ? 'failed'
          : 'succeeded';
    const body = render(FinancialCommandStatus, {
      props: {
        command: {
          ...command({ kind, status }),
          updatedAt: '2026-08-22T12:05:00.000Z',
          resultCode,
          result,
          completedAt: '2026-08-22T12:05:00.000Z',
          privateInput: 'must-not-render'
        } as FinancialAdminCommandStatusDto
      }
    }).body;

    expect(body).toContain(expected);
    expect(body).not.toContain(REFUND_ID);
    expect(body).not.toContain(DRAFT_ID);
    expect(body).not.toContain('must-not-render');
    expect(body).not.toMatch(/<form|<button|resubmit|Try again/iu);
  });

  it('keeps abort-on-unmount and resolves the protected status endpoint', () => {
    const source = readFileSync(
      new URL('./FinancialCommandStatus.svelte', import.meta.url), 'utf8'
    );
    expect(source).toContain('onMount');
    expect(source).toContain('new AbortController()');
    expect(source).toContain('controller.abort()');
    expect(source).toContain("resolve('/admin/sales/commands/[commandId]'");
    expect(source).toContain('pollFinancialCommandStatus');
    expect(source).toContain('invalidateAll');
    expect(source).not.toContain('window.confirm');
    expect(source).not.toMatch(/submitFinancialAdminCommand|executeRefundDraft/iu);
  });
});

describe('refund review page', () => {
  it('renders safe facts, shared editor, back context, and action outcome without private data', () => {
    const body = render(RefundReviewPage, {
      props: {
        data: {
          detail: detail(),
          reviewCursor: 'bounded_cursor',
          saveDraftIdempotencyKey: SAVE_KEY,
          discardDraftIdempotencyKey: DISCARD_KEY,
          finalizeIdempotencyKey: FINALIZE_KEY,
          reportingCorrectionSeed: correctionSeed(),
          correctionIdempotencyKey: CORRECTION_KEY
        },
        form: { command: command(), reviewCursor: 'bounded_cursor' }
      } as never
    }).body;
    expect(body.match(/<h1(?:\s|>)/gu)).toHaveLength(1);
    expect(body).toContain('Refund allocation review');
    expect(body).toContain('First title');
    expect(body).toContain('Second title');
    expect(body).toContain('Open issues');
    expect(body).toContain('/admin/sales/review?cursor=bounded_cursor');
    expect(body).toContain(COMMAND_ID);
    expect(body).not.toContain('Shared allocation draft');
    expect(body).not.toContain('Reporting attribution correction');
    expect(body).not.toMatch(/<form\b/gu);
    expect(body).not.toMatch(/customer@example|stripe_|provider_private|adminId|correlationId/iu);

    const source = readFileSync(
      new URL('../../../routes/admin/sales/refunds/[refundId]/+page.svelte', import.meta.url),
      'utf8'
    );
    expect(source).toContain('{#key data.detail}');
  });

  it.each([
    [
      'stale_state',
      'The refund facts changed before this request could be submitted.',
      true
    ],
    [
      'forbidden',
      'Your permissions no longer allow this refund action.',
      false
    ],
    [
      'temporarily_unavailable',
      'The refund action could not be completed.',
      false
    ]
  ])('renders the safe %s action failure accessibly', (code, message, reloadRequired) => {
    const body = render(RefundReviewPage, {
      props: {
        data: {
          detail: detail(),
          reviewCursor: 'bounded_cursor',
          saveDraftIdempotencyKey: SAVE_KEY,
          discardDraftIdempotencyKey: DISCARD_KEY,
          finalizeIdempotencyKey: FINALIZE_KEY,
          reportingCorrectionSeed: correctionSeed(),
          correctionIdempotencyKey: CORRECTION_KEY
        },
        form: { code, fieldErrors: {} }
      } as never
    }).body;

    expect(body).toContain(message);
    expect(body).toMatch(/role="alert"[^>]*aria-live="assertive"/u);
    expect(body.includes('Reload current refund facts')).toBe(reloadRequired);
    expect(body).not.toMatch(/private|repository|stack|correlationId/iu);
  });

  it('renders a native, privacy-safe finalization confirmation from the prepared preview', () => {
    const preview = {
      ...finalizationPreview(),
      customerEmail: 'private-customer@example.test',
      providerRefundId: 're_private_provider'
    } as RefundFinalizationPreviewDto;
    const body = render(RefundReviewPage, {
      props: {
        data: {
          detail: detail(),
          reviewCursor: 'bounded_cursor',
          saveDraftIdempotencyKey: SAVE_KEY,
          discardDraftIdempotencyKey: DISCARD_KEY,
          finalizeIdempotencyKey: FINALIZE_KEY,
          reportingCorrectionSeed: correctionSeed(),
          correctionIdempotencyKey: CORRECTION_KEY
        },
        form: { finalizationPreview: preview, reviewCursor: 'bounded_cursor' }
      } as never
    }).body;

    expect(body).toContain('Review finalization consequences');
    expect(body).toContain('Finalizing makes this allocation immutable.');
    expect(body).toContain('Finalization may revoke purchase access.');
    expect(body).toContain(
      'A later reporting correction does not automatically restore access.'
    );
    expect(body).toContain('Proposed subtotal');
    expect(body).toContain('Proposed tax');
    expect(body).toContain('Proposed total');
    for (const amount of ['2.70', '0.30', '3.00', '1.80', '0.20', '2.00']) {
      expect(body).toContain(`+USD\u00a0${amount}`);
    }
    expect(body).toContain('Purchase access grant will be revoked.');
    expect(body).toContain('Effective access will change.');
    expect(body).toContain('An access-change email will be queued.');
    expect(body).toContain('Purchase access grant will remain unchanged.');
    expect(body).toContain('Another active grant preserves access.');
    expect(body).toContain('Effective access will remain unchanged.');
    expect(body).toContain('No access-change email will be queued.');
    expect(body).toContain('method="POST"');
    expect(body).toContain('?/confirmFinalize&amp;reviewCursor=bounded_cursor');
    expect(body).toContain(`name="idempotencyKey" value="${FINALIZE_KEY}"`);
    expect(body).toContain('name="expectedActiveDraftVersion" value="2"');
    expect(body).toContain(
      `name="previewFingerprint" value="${PREVIEW_FINGERPRINT}"`
    );
    expect(body).toContain(
      'name="confirmation" value="finalize_refund_allocation"'
    );
    expect(body.match(/<form\b/gu)).toHaveLength(1);
    expect(body.match(/<button[^>]*type="submit"/gu)).toHaveLength(1);
    expect(body).not.toContain('?/saveDraft');
    expect(body).not.toContain('?/discardDraft');
    expect(body).not.toContain('?/prepareFinalize');
    expect(body).not.toContain('window.confirm');
    expect(body).not.toContain('private-customer@example.test');
    expect(body).not.toContain('re_private_provider');

    const source = readFileSync(
      new URL('../../../routes/admin/sales/refunds/[refundId]/+page.svelte', import.meta.url),
      'utf8'
    );
    expect(source).not.toContain('window.confirm');
  });

  it('renders only the prepared reporting-correction confirmation and its safe seed context', () => {
    const body = render(RefundReviewPage, {
      props: {
        data: {
          detail: detail({ allocationStatus: 'finalized', draft: null }),
          reportingCorrectionSeed: correctionSeed(),
          reviewCursor: 'bounded_cursor',
          saveDraftIdempotencyKey: SAVE_KEY,
          discardDraftIdempotencyKey: DISCARD_KEY,
          finalizeIdempotencyKey: FINALIZE_KEY,
          correctionIdempotencyKey: CORRECTION_KEY
        },
        form: {
          reportingCorrectionPreview: correctionPreview(),
          reviewCursor: 'bounded_cursor'
        }
      } as never
    }).body;

    expect(body).toContain('Review reporting correction');
    expect(body).toContain('Reporting only — this does not restore or revoke access.');
    expect(body).toContain('?/confirmCorrection&amp;reviewCursor=bounded_cursor');
    expect(body).toContain(`name="idempotencyKey" value="${CORRECTION_KEY}"`);
    expect(body).not.toContain('Shared allocation draft');
    expect(body).not.toContain('?/prepareFinalize');
    expect(body).not.toContain('?/prepareCorrection');
    expect(body.match(/<form\b/gu)).toHaveLength(1);
  });

  it('treats preparation availability failure as rerunnable, not as a submitted command', () => {
    const body = render(RefundReviewPage, {
      props: {
        data: {
          detail: detail(),
          reviewCursor: null,
          saveDraftIdempotencyKey: SAVE_KEY,
          discardDraftIdempotencyKey: DISCARD_KEY,
          finalizeIdempotencyKey: FINALIZE_KEY,
          reportingCorrectionSeed: correctionSeed(),
          correctionIdempotencyKey: CORRECTION_KEY
        },
        form: {
          code: 'temporarily_unavailable',
          fieldErrors: {},
          retrySubmission: null
        }
      } as never
    }).body;

    expect(body).toContain('The refund action could not be completed.');
    expect(body).toContain('Review finalization consequences');
    expect(body).not.toContain('Retry this exact request');
    expect(body).not.toContain('could not confirm whether the refund request was submitted');
    expect(body).not.toContain(COMMAND_ID);
  });

  it('pauses editing and preserves one exact canonical retry after an ambiguous submission', () => {
    const retryKey = '00000000-0000-4000-8000-000000011411';
    const body = render(RefundReviewPage, {
      props: {
        data: {
          detail: detail(),
          reviewCursor: 'bounded_cursor',
          saveDraftIdempotencyKey: SAVE_KEY,
          discardDraftIdempotencyKey: DISCARD_KEY,
          finalizeIdempotencyKey: FINALIZE_KEY,
          reportingCorrectionSeed: correctionSeed(),
          correctionIdempotencyKey: CORRECTION_KEY
        },
        form: {
          code: 'temporarily_unavailable',
          fieldErrors: {},
          retrySubmission: {
            action: 'saveDraft',
            idempotencyKey: retryKey,
            expectedVersion: 2,
            items: [
              { orderItemId: FIRST_ITEM_ID, totalPresentmentMinor: 325 },
              { orderItemId: SECOND_ITEM_ID, totalPresentmentMinor: 175 }
            ]
          }
        }
      } as never
    }).body;

    expect(body).toContain('Retry this exact request');
    expect(body).toContain(`name="idempotencyKey" value="${retryKey}"`);
    expect(body).toContain('name="expectedVersion" value="2"');
    expect(body).toContain(`name="orderItemId" value="${FIRST_ITEM_ID}"`);
    expect(body).toContain('name="totalPresentmentMinor" value="325"');
    expect(body).toContain('?/saveDraft&amp;reviewCursor=bounded_cursor');
    expect(body).not.toContain(`value="${SAVE_KEY}"`);
    expect(body).not.toContain(`value="${DISCARD_KEY}"`);
    expect(body).not.toContain('Shared allocation draft');
  });

  it('renders exactly one canonical confirm retry and suppresses every new form key', () => {
    const retryKey = '00000000-0000-4000-8000-000000011413';
    const body = render(RefundReviewPage, {
      props: {
        data: {
          detail: detail(),
          reviewCursor: 'bounded_cursor',
          saveDraftIdempotencyKey: SAVE_KEY,
          discardDraftIdempotencyKey: DISCARD_KEY,
          finalizeIdempotencyKey: FINALIZE_KEY,
          reportingCorrectionSeed: correctionSeed(),
          correctionIdempotencyKey: CORRECTION_KEY
        },
        form: {
          code: 'temporarily_unavailable',
          fieldErrors: {},
          retrySubmission: {
            action: 'confirmFinalize',
            idempotencyKey: retryKey,
            expectedActiveDraftVersion: 2,
            previewFingerprint: PREVIEW_FINGERPRINT,
            confirmation: 'finalize_refund_allocation'
          }
        }
      } as never
    }).body;

    expect(body.match(/<form/gu)).toHaveLength(1);
    expect(body).toContain('?/confirmFinalize&amp;reviewCursor=bounded_cursor');
    expect(body).toContain(`name="idempotencyKey" value="${retryKey}"`);
    expect(body).toContain('name="expectedActiveDraftVersion" value="2"');
    expect(body).toContain(
      `name="previewFingerprint" value="${PREVIEW_FINGERPRINT}"`
    );
    expect(body).toContain(
      'name="confirmation" value="finalize_refund_allocation"'
    );
    expect(body).not.toContain(`value="${SAVE_KEY}"`);
    expect(body).not.toContain(`value="${DISCARD_KEY}"`);
    expect(body).not.toContain(`value="${FINALIZE_KEY}"`);
    expect(body).not.toContain('Shared allocation draft');
    expect(body).not.toContain('Review finalization consequences');
  });

  it('renders one explicit exact correction retry with all sorted values and no automatic submit path', () => {
    const retryKey = '00000000-0000-4000-8000-000000011416';
    const body = render(RefundReviewPage, {
      props: {
        data: {
          detail: detail({ allocationStatus: 'finalized', draft: null }),
          reportingCorrectionSeed: correctionSeed(),
          reviewCursor: 'bounded_cursor',
          saveDraftIdempotencyKey: SAVE_KEY,
          discardDraftIdempotencyKey: DISCARD_KEY,
          finalizeIdempotencyKey: FINALIZE_KEY,
          correctionIdempotencyKey: CORRECTION_KEY
        },
        form: {
          code: 'temporarily_unavailable',
          fieldErrors: {},
          retrySubmission: {
            action: 'confirmCorrection',
            idempotencyKey: retryKey,
            reason: 'allocation_attribution_correction',
            expectedNextCorrectionVersion: 2,
            expectedBaseAllocationSetId: BASE_ALLOCATION_SET_ID,
            expectedSourceFingerprint: SOURCE_FINGERPRINT,
            items: [
              { orderItemId: FIRST_ITEM_ID, totalPresentmentMinor: 0 },
              { orderItemId: SECOND_ITEM_ID, totalPresentmentMinor: 500 }
            ],
            previewFingerprint: PREVIEW_FINGERPRINT,
            confirmation: 'create_reporting_correction'
          }
        }
      } as never
    }).body;

    expect(body.match(/<form\b/gu)).toHaveLength(1);
    expect(body).toContain('?/confirmCorrection&amp;reviewCursor=bounded_cursor');
    expect(body).toContain(`name="idempotencyKey" value="${retryKey}"`);
    expect(body).toContain('name="reason" value="allocation_attribution_correction"');
    expect(body).toContain('name="expectedNextCorrectionVersion" value="2"');
    expect(body).toContain(
      `name="expectedBaseAllocationSetId" value="${BASE_ALLOCATION_SET_ID}"`
    );
    expect(body).toContain(
      `name="expectedSourceFingerprint" value="${SOURCE_FINGERPRINT}"`
    );
    expect(body.match(/name="orderItemId"/gu)).toHaveLength(2);
    expect(body).toContain(`name="orderItemId" value="${FIRST_ITEM_ID}"`);
    expect(body).toContain('name="totalPresentmentMinor" value="0"');
    expect(body).toContain(`name="orderItemId" value="${SECOND_ITEM_ID}"`);
    expect(body).toContain('name="totalPresentmentMinor" value="500"');
    expect(body).toContain(`name="previewFingerprint" value="${PREVIEW_FINGERPRINT}"`);
    expect(body).toContain('name="confirmation" value="create_reporting_correction"');
    expect(body).not.toContain(CORRECTION_KEY);
    expect(body).not.toContain('Reporting attribution correction');
    expect(body).not.toContain('Shared allocation draft');

    const pageSource = readFileSync(
      new URL('../../../routes/admin/sales/refunds/[refundId]/+page.svelte', import.meta.url),
      'utf8'
    );
    const editorSource = readFileSync(
      new URL('./ReportingCorrectionEditor.svelte', import.meta.url),
      'utf8'
    );
    expect(`${pageSource}\n${editorSource}`).not.toMatch(
      /requestSubmit|\.submit\(|fetch\(|use:enhance|onMount/iu
    );
  });
});
