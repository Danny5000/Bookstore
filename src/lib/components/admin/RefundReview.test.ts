import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type {
  FinancialAdminCommandReferenceDto,
  FinancialAdminCommandStatusDto,
  RefundDetailDto
} from '$lib/types/financial-reporting';

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn() }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));

import RefundAllocationEditor from './RefundAllocationEditor.svelte';
import FinancialActionOutcome from './FinancialActionOutcome.svelte';
import FinancialCommandStatus from './FinancialCommandStatus.svelte';
import RefundReviewPage from '../../../routes/admin/sales/refunds/[refundId]/+page.svelte';

const REFUND_ID = '00000000-0000-4000-8000-000000011401';
const FIRST_ITEM_ID = '00000000-0000-4000-8000-000000011402';
const SECOND_ITEM_ID = '00000000-0000-4000-8000-000000011403';
const DRAFT_ID = '00000000-0000-4000-8000-000000011404';
const COMMAND_ID = '00000000-0000-4000-8000-000000011405';
const SAVE_KEY = '00000000-0000-4000-8000-000000011406';
const DISCARD_KEY = '00000000-0000-4000-8000-000000011407';

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
          discardDraftIdempotencyKey: DISCARD_KEY
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
      'We could not confirm whether the refund request was submitted.',
      false
    ]
  ])('renders the safe %s action failure accessibly', (code, message, reloadRequired) => {
    const body = render(RefundReviewPage, {
      props: {
        data: {
          detail: detail(),
          reviewCursor: 'bounded_cursor',
          saveDraftIdempotencyKey: SAVE_KEY,
          discardDraftIdempotencyKey: DISCARD_KEY
        },
        form: { code, fieldErrors: {} }
      } as never
    }).body;

    expect(body).toContain(message);
    expect(body).toMatch(/role="alert"[^>]*aria-live="assertive"/u);
    expect(body.includes('Reload current refund facts')).toBe(reloadRequired);
    expect(body).not.toMatch(/private|repository|stack|correlationId/iu);
  });

  it('pauses editing and preserves one exact canonical retry after an ambiguous submission', () => {
    const retryKey = '00000000-0000-4000-8000-000000011411';
    const body = render(RefundReviewPage, {
      props: {
        data: {
          detail: detail(),
          reviewCursor: 'bounded_cursor',
          saveDraftIdempotencyKey: SAVE_KEY,
          discardDraftIdempotencyKey: DISCARD_KEY
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
});
