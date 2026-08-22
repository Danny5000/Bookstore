import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Actor,
  AdminCapability,
  AdministratorActor,
  CapabilityResolver
} from '$lib/server/auth/admin-policy';
import type {
  RefundDetailDto,
  RefundFinalizationPreviewDto,
  RefundReportingCorrectionPreviewDto,
  RefundReportingCorrectionSeedDto
} from '$lib/types/financial-reporting';
import { encodeFinancialIssueCursor } from '$lib/server/commerce/reporting/review';

const routeMocks = vi.hoisted(() => ({
  database: {},
  denyRead: false,
  denyManage: false,
  getDetail: vi.fn(),
  getCorrectionSeed: vi.fn(),
  preview: vi.fn(),
  previewCorrection: vi.fn(),
  submit: vi.fn()
}));

vi.mock('$lib/server/db/runtime', () => ({
  getDatabaseClient: () => ({ db: routeMocks.database })
}));
vi.mock('$lib/server/config', () => ({
  getApplicationConfig: () => ({ origin: 'https://books.example.test' })
}));
vi.mock('$lib/server/commerce/financial/refund-review/query', () => ({
  getRefundReviewDetail: routeMocks.getDetail
}));
vi.mock('$lib/server/commerce/financial/refund-review/finalize', () => ({
  previewRefundFinalization: routeMocks.preview
}));
vi.mock('$lib/server/commerce/financial/refund-review/corrections', () => ({
  getReportingCorrectionSeed: routeMocks.getCorrectionSeed,
  previewReportingCorrection: routeMocks.previewCorrection
}));
vi.mock('$lib/server/commerce/financial/admin-commands/repository', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('$lib/server/commerce/financial/admin-commands/repository')
  >()),
  submitFinancialAdminCommand: routeMocks.submit
}));
vi.mock('$lib/server/auth/admin-policy', async (importOriginal) => {
  const actual: typeof import('$lib/server/auth/admin-policy') = await importOriginal();
  const original: (
    actor: Actor,
    capability: AdminCapability,
    capabilityResolver?: CapabilityResolver
  ) => void = actual.requireCapability;
  return {
    ...actual,
    requireCapability(
      actor: Actor,
      capability: AdminCapability,
      resolver?: CapabilityResolver
    ): asserts actor is AdministratorActor {
      if (
        actor.type === 'user' &&
        actor.roles.includes('admin') && (
          (routeMocks.denyRead && capability === 'sales.read') ||
          (routeMocks.denyManage && capability === 'reconciliation.manage')
        )
      ) {
        throw new actual.AuthorizationError('forbidden', 403);
      }
      original(actor, capability, resolver);
    }
  };
});

import * as refundRoute from './[refundId]/+page.server';
import { FinancialAdminCommandSubmissionConflictError } from '$lib/server/commerce/financial/admin-commands/repository';
import { FinancialAdminConflictError } from '$lib/server/commerce/financial/admin-commands/handler';

const ADMIN: Actor = {
  type: 'user', id: '00000000-0000-4000-8000-000000011301', roles: ['admin']
};
const REFUND_ID = '00000000-0000-4000-8000-000000011302';
const ITEM_ID = '00000000-0000-4000-8000-000000011303';
const COMMAND_ID = '00000000-0000-4000-8000-000000011304';
const IDEMPOTENCY_KEY = '00000000-0000-4000-8000-000000011305';
const BASE_ALLOCATION_SET_ID = '00000000-0000-4000-8000-000000011309';
const CORRECTION_SET_ID = '00000000-0000-4000-8000-000000011310';
const PREVIEW_FINGERPRINT = 'a'.repeat(64);
const SOURCE_FINGERPRINT = 'b'.repeat(64);
const REVIEW_CURSOR = encodeFinancialIssueCursor({
  actionabilityRank: 0,
  impactRank: 1,
  firstObservedAt: '2026-08-22T12:00:00.000000Z',
  issueId: '00000000-0000-4000-8000-000000011306'
});

const detail: RefundDetailDto = {
  refundId: REFUND_ID,
  orderId: '00000000-0000-4000-8000-000000011307',
  status: 'succeeded',
  allocationStatus: 'needs_review',
  financialState: 'fee_reconciled',
  amountMinor: 500,
  currency: 'USD',
  orderSubtotalMinor: 450,
  orderTaxMinor: 50,
  orderTotalMinor: 500,
  items: [{
    orderItemId: ITEM_ID,
    titleId: '00000000-0000-4000-8000-000000011308',
    soldAsTitle: 'Safe title',
    soldAsCreatorName: 'Safe creator',
    format: 'prose',
    paidSubtotalMinor: 450,
    paidTaxMinor: 50,
    paidTotalMinor: 500,
    currency: 'USD',
    finalizedRefundTotalMinor: 0,
    remainingRefundCapacityMinor: 500
  }],
  finalizedAllocations: [],
  draft: null,
  finalizationPreview: null,
  correctionPreview: null,
  recoveryPreviews: [],
  openIssueCount: 1,
  dataThroughAt: '2026-08-22T12:00:00.000Z',
  createdAt: '2026-08-22T11:00:00.000Z',
  updatedAt: '2026-08-22T12:00:00.000Z'
};

const finalizationPreview: RefundFinalizationPreviewDto = {
  refundId: REFUND_ID,
  expectedActiveDraftVersion: 2,
  previewFingerprint: PREVIEW_FINGERPRINT,
  currency: 'USD',
  proposedTotalMinor: 500,
  remainderMinor: 0,
  items: [{
    orderItemId: ITEM_ID,
    titleId: '00000000-0000-4000-8000-000000011308',
    soldAsTitle: 'Safe title',
    proposedTotalMinor: 500,
    proposedSubtotalMinor: 450,
    proposedTaxMinor: 50,
    wouldBeFullyRefunded: true,
    purchaseGrantWouldBeRevoked: true,
    otherActiveGrantPreservesAccess: false,
    effectiveAccessWouldChange: true,
    emailQueued: true
  }]
};

const correctionSeed: RefundReportingCorrectionSeedDto = {
  refundId: REFUND_ID,
  reason: 'allocation_attribution_correction',
  expectedNextCorrectionVersion: 2,
  expectedBaseAllocationSetId: BASE_ALLOCATION_SET_ID,
  expectedSourceFingerprint: SOURCE_FINGERPRINT,
  rawPredecessorCorrectionSetId: CORRECTION_SET_ID,
  compatibleCorrectionSetId: CORRECTION_SET_ID,
  baselineKind: 'compatible_correction',
  currentReportingComplete: true,
  currency: 'USD',
  settlementCurrency: 'USD',
  baselineTotalMinor: 500,
  eligible: true,
  ineligibleReason: null,
  items: [{
    orderItemId: ITEM_ID,
    titleId: '00000000-0000-4000-8000-000000011308',
    soldAsTitle: 'Safe title',
    baselineTotalMinor: 500,
    baselineSubtotalMinor: 450,
    baselineTaxMinor: 50,
    baselineSettlementGrossMinor: 475,
    baselineRefundFeeImpactMinor: -25
  }]
};

const correctionPreview: RefundReportingCorrectionPreviewDto = {
  refundId: REFUND_ID,
  expectedBaseAllocationSetId: BASE_ALLOCATION_SET_ID,
  rawPredecessorCorrectionSetId: CORRECTION_SET_ID,
  compatibleCorrectionSetId: CORRECTION_SET_ID,
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
  items: [{
    orderItemId: ITEM_ID,
    titleId: '00000000-0000-4000-8000-000000011308',
    soldAsTitle: 'Safe title',
    baselineTotalMinor: 500,
    baselineSubtotalMinor: 450,
    baselineTaxMinor: 50,
    proposedTotalMinor: 500,
    proposedSubtotalMinor: 440,
    proposedTaxMinor: 60,
    subtotalDisplayDeltaMinor: -10,
    taxDisplayDeltaMinor: 10,
    baselineSettlementGrossMinor: 475,
    proposedSettlementGrossMinor: 470,
    settlementGrossDisplayDeltaMinor: -5,
    baselineRefundFeeImpactMinor: -25,
    proposedRefundFeeImpactMinor: -20,
    refundFeeImpactDisplayDeltaMinor: 5
  }]
};

function urlencoded(entries: readonly (readonly [string, string])[]): Request {
  const body = new URLSearchParams();
  for (const [key, value] of entries) body.append(key, value);
  return new Request(`https://books.example.test/admin/sales/refunds/${REFUND_ID}`, {
    method: 'POST',
    headers: {
      origin: 'https://books.example.test',
      'content-type': 'application/x-www-form-urlencoded',
      'x-request-id': 'refund-route-action'
    },
    body
  });
}

function actionEvent(actor: Actor, request: Request, action = 'saveDraft') {
  return {
    locals: { actor },
    params: { refundId: REFUND_ID },
    url: new URL(`${request.url}?reviewCursor=${REVIEW_CURSOR}&/${action}`),
    request,
    route: { id: '/admin/sales/refunds/[refundId]' }
  };
}

describe('refund review loader and async command routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeMocks.getDetail.mockReset();
    routeMocks.getCorrectionSeed.mockReset();
    routeMocks.preview.mockReset();
    routeMocks.previewCorrection.mockReset();
    routeMocks.submit.mockReset();
    routeMocks.denyRead = false;
    routeMocks.denyManage = false;
    routeMocks.getDetail.mockResolvedValue(detail);
    routeMocks.getCorrectionSeed.mockResolvedValue(correctionSeed);
    routeMocks.preview.mockResolvedValue(finalizationPreview);
    routeMocks.previewCorrection.mockResolvedValue(correctionPreview);
    routeMocks.submit.mockResolvedValue({
      commandId: COMMAND_ID,
      kind: 'refund_draft_save',
      status: 'pending',
      createdAt: '2026-08-22T12:01:00.000Z'
    });
  });

  it('requires both capabilities before touching path, URL, request, or domain services', async () => {
    for (const actor of [{ type: 'anonymous' } as const, ADMIN]) {
      routeMocks.denyManage = actor === ADMIN;
      const accesses = {
        params: vi.fn(), url: vi.fn(), request: vi.fn(), route: vi.fn()
      };
      const event: Record<string, unknown> = { locals: { actor } };
      for (const key of Object.keys(accesses) as Array<keyof typeof accesses>) {
        Object.defineProperty(event, key, { enumerable: true, get: accesses[key] });
      }

      await expect(refundRoute.load(event as never)).rejects.toMatchObject({
        status: actor === ADMIN ? 403 : 401
      });
      for (const access of Object.values(accesses)) expect(access).not.toHaveBeenCalled();
    }
    expect(routeMocks.getDetail).not.toHaveBeenCalled();
  });

  it.each([
    ['sales.read', 'denyRead'],
    ['reconciliation.manage', 'denyManage']
  ] as const)(
    'requires %s before the loader reads an identifier or invokes either service',
    async (_capability, deniedFlag) => {
      routeMocks[deniedFlag] = true;
      const accesses = {
        params: vi.fn(), url: vi.fn(), request: vi.fn(), route: vi.fn()
      };
      const event: Record<string, unknown> = { locals: { actor: ADMIN } };
      for (const key of Object.keys(accesses) as Array<keyof typeof accesses>) {
        Object.defineProperty(event, key, { enumerable: true, get: accesses[key] });
      }

      await expect(refundRoute.load(event as never)).rejects.toMatchObject({ status: 403 });
      for (const access of Object.values(accesses)) expect(access).not.toHaveBeenCalled();
      expect(routeMocks.getDetail).not.toHaveBeenCalled();
      expect(routeMocks.getCorrectionSeed).not.toHaveBeenCalled();
    }
  );

  it('requires both action capabilities before origin, path, return context, or body parsing', async () => {
    for (const actor of [{ type: 'anonymous' } as const, ADMIN]) {
      routeMocks.denyManage = actor === ADMIN;
      const accesses = {
        params: vi.fn(), url: vi.fn(), request: vi.fn(), route: vi.fn()
      };
      const event: Record<string, unknown> = { locals: { actor } };
      for (const key of Object.keys(accesses) as Array<keyof typeof accesses>) {
        Object.defineProperty(event, key, { enumerable: true, get: accesses[key] });
      }

      const result = await refundRoute.actions.saveDraft!(event as never);

      expect(result).toMatchObject({
        status: actor === ADMIN ? 403 : 401,
        data: { code: actor === ADMIN ? 'forbidden' : 'unauthenticated' }
      });
      for (const access of Object.values(accesses)) expect(access).not.toHaveBeenCalled();
    }
    expect(routeMocks.submit).not.toHaveBeenCalled();
  });

  it('loads audited detail with only a strict review cursor and separate form UUIDs', async () => {
    const request = new Request(
      `https://books.example.test/admin/sales/refunds/${REFUND_ID}?reviewCursor=${REVIEW_CURSOR}`,
      { headers: { 'x-request-id': 'refund-route-load' } }
    );
    const result = await refundRoute.load({
      locals: { actor: ADMIN },
      params: { refundId: REFUND_ID },
      url: new URL(request.url),
      request,
      route: { id: '/admin/sales/refunds/[refundId]' }
    } as never);

    expect(routeMocks.getDetail).toHaveBeenCalledWith(
      routeMocks.database,
      ADMIN,
      REFUND_ID,
      {
        correlationId: 'refund-route-load',
        requestMetadata: { method: 'GET', routeId: '/admin/sales/refunds/[refundId]' }
      }
    );
    expect(routeMocks.getCorrectionSeed).toHaveBeenCalledWith(
      routeMocks.database,
      ADMIN,
      REFUND_ID,
      {
        correlationId: 'refund-route-load',
        requestMetadata: { method: 'GET', routeId: '/admin/sales/refunds/[refundId]' }
      }
    );
    expect(result).toMatchObject({
      detail,
      reportingCorrectionSeed: correctionSeed,
      reviewCursor: REVIEW_CURSOR
    });
    if (!result) throw new Error('refund loader returned no data');
    expect(result.saveDraftIdempotencyKey).toMatch(/^[0-9a-f-]{36}$/u);
    expect(result.discardDraftIdempotencyKey).toMatch(/^[0-9a-f-]{36}$/u);
    expect(result.finalizeIdempotencyKey).toMatch(/^[0-9a-f-]{36}$/u);
    expect(result.correctionIdempotencyKey).toMatch(/^[0-9a-f-]{36}$/u);
    expect(result.saveDraftIdempotencyKey).not.toBe(result.discardDraftIdempotencyKey);
    expect(new Set([
      result.saveDraftIdempotencyKey,
      result.discardDraftIdempotencyKey,
      result.finalizeIdempotencyKey,
      result.correctionIdempotencyKey
    ]).size).toBe(4);
  });

  it.each(['prepareFinalize', 'confirmFinalize'] as const)(
    'requires both capabilities before touching %s origin, path, return context, or body',
    async (action) => {
      for (const actor of [{ type: 'anonymous' } as const, ADMIN]) {
        routeMocks.denyManage = actor === ADMIN;
        const accesses = {
          params: vi.fn(), url: vi.fn(), request: vi.fn(), route: vi.fn()
        };
        const event: Record<string, unknown> = { locals: { actor } };
        for (const key of Object.keys(accesses) as Array<keyof typeof accesses>) {
          Object.defineProperty(event, key, { enumerable: true, get: accesses[key] });
        }

        const result = await refundRoute.actions[action]!(event as never);

        expect(result).toMatchObject({
          status: actor === ADMIN ? 403 : 401,
          data: { code: actor === ADMIN ? 'forbidden' : 'unauthenticated' }
        });
        for (const access of Object.values(accesses)) expect(access).not.toHaveBeenCalled();
      }
      expect(routeMocks.preview).not.toHaveBeenCalled();
      expect(routeMocks.submit).not.toHaveBeenCalled();
    }
  );

  it.each(['prepareCorrection', 'confirmCorrection'] as const)(
    'checks same-origin before consuming the %s body',
    async (action) => {
      let pulled = false;
      const request = new Request(
        `https://books.example.test/admin/sales/refunds/${REFUND_ID}`,
        {
          method: 'POST',
          headers: {
            origin: 'https://evil.example.test',
            'content-type': 'application/x-www-form-urlencoded'
          },
          body: 'unused'
        }
      );
      Object.defineProperty(request, 'body', {
        configurable: true,
        get() {
          pulled = true;
          throw new Error('private body read');
        }
      });
      const protectedAccesses = { params: vi.fn(), url: vi.fn(), route: vi.fn() };
      const event: Record<string, unknown> = { locals: { actor: ADMIN }, request };
      for (const key of Object.keys(protectedAccesses) as Array<keyof typeof protectedAccesses>) {
        Object.defineProperty(event, key, { enumerable: true, get: protectedAccesses[key] });
      }

      const result = await refundRoute.actions[action]!(event as never);

      expect(result).toMatchObject({ status: 403, data: { code: 'forbidden' } });
      expect(pulled).toBe(false);
      for (const access of Object.values(protectedAccesses)) expect(access).not.toHaveBeenCalled();
      expect(routeMocks.previewCorrection).not.toHaveBeenCalled();
      expect(routeMocks.submit).not.toHaveBeenCalled();
    }
  );

  it.each(['prepareCorrection', 'confirmCorrection'] as const)(
    'accepts only the exact empty %s action marker before parsing the body',
    async (action) => {
      const request = urlencoded([
        ['reason', 'allocation_attribution_correction']
      ]);
      const event = actionEvent(ADMIN, request, action);
      event.url = new URL(`${request.url}?/${action}=private&reviewCursor=${REVIEW_CURSOR}`);

      const result = await refundRoute.actions[action]!(event as never);

      expect(result).toMatchObject({ status: 400, data: { code: 'invalid_request' } });
      expect(routeMocks.previewCorrection).not.toHaveBeenCalled();
      expect(routeMocks.submit).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['prepareCorrection', [
      ['reason', 'allocation_attribution_correction'],
      ['expectedNextCorrectionVersion', '2'],
      ['expectedBaseAllocationSetId', BASE_ALLOCATION_SET_ID],
      ['expectedSourceFingerprint', SOURCE_FINGERPRINT],
      ['orderItemId', ITEM_ID],
      ['totalPresentmentMinor', '500'],
      ['privateExtra', 'must-not-pass']
    ]],
    ['confirmCorrection', [
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['reason', 'allocation_attribution_correction'],
      ['expectedNextCorrectionVersion', '2'],
      ['expectedBaseAllocationSetId', BASE_ALLOCATION_SET_ID],
      ['expectedSourceFingerprint', SOURCE_FINGERPRINT],
      ['orderItemId', ITEM_ID],
      ['totalPresentmentMinor', '500'],
      ['previewFingerprint', PREVIEW_FINGERPRINT],
      ['confirmation', 'create_reporting_correction'],
      ['privateExtra', 'must-not-pass']
    ]]
  ] as const)('rejects unknown %s fields before a correction service call', async (
    action,
    entries
  ) => {
    const result = await refundRoute.actions[action]!(
      actionEvent(ADMIN, urlencoded(entries), action) as never
    );

    expect(result).toMatchObject({
      status: 400,
      data: { code: 'invalid_request', retrySubmission: null }
    });
    expect(routeMocks.previewCorrection).not.toHaveBeenCalled();
    expect(routeMocks.submit).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('must-not-pass');
  });

  it.each([
    ['prepareCorrection', 'denyRead'],
    ['prepareCorrection', 'denyManage'],
    ['confirmCorrection', 'denyRead'],
    ['confirmCorrection', 'denyManage']
  ] as const)(
    'requires the independently denied capability before touching %s input (%s)',
    async (action, deniedFlag) => {
      routeMocks[deniedFlag] = true;
      const accesses = {
        params: vi.fn(), url: vi.fn(), request: vi.fn(), route: vi.fn()
      };
      const event: Record<string, unknown> = { locals: { actor: ADMIN } };
      for (const key of Object.keys(accesses) as Array<keyof typeof accesses>) {
        Object.defineProperty(event, key, { enumerable: true, get: accesses[key] });
      }

      const actionHandler = refundRoute.actions[action];
      expect(actionHandler).toBeTypeOf('function');
      const result = await actionHandler!(event as never);

      expect(result).toMatchObject({ status: 403, data: { code: 'forbidden' } });
      for (const access of Object.values(accesses)) expect(access).not.toHaveBeenCalled();
      expect(routeMocks.previewCorrection).not.toHaveBeenCalled();
      expect(routeMocks.submit).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['malformed refund', 'PRIVATE', '', 404],
    ['unknown return context', REFUND_ID, '?returnTo=https://private.test', 400],
    ['missing refund', REFUND_ID, '', 404]
  ])('maps %s to safe %i', async (_label, refundId, search, status) => {
    if (_label === 'missing refund') routeMocks.getDetail.mockResolvedValueOnce(null);
    const request = new Request(`https://books.example.test/admin/sales/refunds/${refundId}${search}`);
    await expect(refundRoute.load({
      locals: { actor: ADMIN }, params: { refundId }, url: new URL(request.url), request,
      route: { id: '/admin/sales/refunds/[refundId]' }
    } as never)).rejects.toMatchObject({ status });
  });

  it('submits a canonical save command only through the command repository', async () => {
    const request = urlencoded([
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['expectedVersion', ''],
      ['orderItemId', ITEM_ID],
      ['totalPresentmentMinor', '500']
    ]);
    const result = await refundRoute.actions.saveDraft!(
      actionEvent(ADMIN, request) as never
    );

    expect(routeMocks.submit).toHaveBeenCalledWith(routeMocks.database, {
      actor: ADMIN,
      idempotencyKey: IDEMPOTENCY_KEY,
      command: {
        kind: 'refund_draft_save',
        refundId: REFUND_ID,
        expectedVersion: null,
        items: [{ orderItemId: ITEM_ID, totalPresentmentMinor: 500 }]
      },
      context: {
        correlationId: 'refund-route-action',
        requestMetadata: { method: 'POST', routeId: '/admin/sales/refunds/[refundId]' }
      }
    });
    expect(result).toEqual({ command: {
      commandId: COMMAND_ID,
      kind: 'refund_draft_save',
      status: 'pending',
      createdAt: '2026-08-22T12:01:00.000Z'
    }, reviewCursor: REVIEW_CURSOR });
  });

  it('submits discard through the same repository with its independent idempotency key', async () => {
    routeMocks.submit.mockResolvedValueOnce({
      commandId: COMMAND_ID,
      kind: 'refund_draft_discard',
      status: 'succeeded',
      createdAt: '2026-08-22T12:01:00.000Z'
    });
    const request = urlencoded([
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['expectedActiveDraftVersion', '2']
    ]);
    const result = await refundRoute.actions.discardDraft!(
      actionEvent(ADMIN, request, 'discardDraft') as never
    );
    expect(routeMocks.submit).toHaveBeenCalledWith(
      routeMocks.database,
      expect.objectContaining({
        idempotencyKey: IDEMPOTENCY_KEY,
        command: {
          kind: 'refund_draft_discard', refundId: REFUND_ID,
          expectedActiveDraftVersion: 2
        }
      })
    );
    expect(result).toMatchObject({ command: { status: 'succeeded' } });
  });

  it('prepares a safe finalization preview without submitting a command', async () => {
    const request = urlencoded([
      ['expectedActiveDraftVersion', '2']
    ]);

    const result = await refundRoute.actions.prepareFinalize!(
      actionEvent(ADMIN, request, 'prepareFinalize') as never
    );

    expect(routeMocks.preview).toHaveBeenCalledWith(
      routeMocks.database,
      ADMIN,
      { refundId: REFUND_ID, expectedActiveDraftVersion: 2 },
      {
        correlationId: 'refund-route-action',
        requestMetadata: { method: 'POST', routeId: '/admin/sales/refunds/[refundId]' }
      }
    );
    expect(routeMocks.submit).not.toHaveBeenCalled();
    expect(result).toEqual({
      finalizationPreview,
      reviewCursor: REVIEW_CURSOR
    });
    expect(result).not.toHaveProperty('command');
    expect(result).not.toHaveProperty('retrySubmission');
  });

  it('confirms the exact preview fingerprint through the command repository', async () => {
    routeMocks.submit.mockResolvedValueOnce({
      commandId: COMMAND_ID,
      kind: 'refund_allocation_finalize',
      status: 'pending',
      createdAt: '2026-08-22T12:01:00.000Z'
    });
    const request = urlencoded([
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['expectedActiveDraftVersion', '2'],
      ['previewFingerprint', PREVIEW_FINGERPRINT],
      ['confirmation', 'finalize_refund_allocation']
    ]);

    const result = await refundRoute.actions.confirmFinalize!(
      actionEvent(ADMIN, request, 'confirmFinalize') as never
    );

    expect(routeMocks.preview).not.toHaveBeenCalled();
    expect(routeMocks.submit).toHaveBeenCalledWith(routeMocks.database, {
      actor: ADMIN,
      idempotencyKey: IDEMPOTENCY_KEY,
      command: {
        kind: 'refund_allocation_finalize',
        refundId: REFUND_ID,
        expectedActiveDraftVersion: 2,
        previewFingerprint: PREVIEW_FINGERPRINT,
        confirmation: 'finalize_refund_allocation'
      },
      context: {
        correlationId: 'refund-route-action',
        requestMetadata: { method: 'POST', routeId: '/admin/sales/refunds/[refundId]' }
      }
    });
    expect(result).toMatchObject({
      command: { kind: 'refund_allocation_finalize', status: 'pending' },
      reviewCursor: REVIEW_CURSOR
    });
  });

  it('prepares a reporting correction from the exact full item set without submitting', async () => {
    const request = urlencoded([
      ['reason', 'allocation_attribution_correction'],
      ['expectedNextCorrectionVersion', '2'],
      ['expectedBaseAllocationSetId', BASE_ALLOCATION_SET_ID],
      ['expectedSourceFingerprint', SOURCE_FINGERPRINT],
      ['orderItemId', ITEM_ID],
      ['totalPresentmentMinor', '500']
    ]);

    const result = await refundRoute.actions.prepareCorrection!(
      actionEvent(ADMIN, request, 'prepareCorrection') as never
    );

    expect(routeMocks.previewCorrection).toHaveBeenCalledWith(
      routeMocks.database,
      ADMIN,
      {
        refundId: REFUND_ID,
        reason: 'allocation_attribution_correction',
        expectedNextCorrectionVersion: 2,
        expectedBaseAllocationSetId: BASE_ALLOCATION_SET_ID,
        expectedSourceFingerprint: SOURCE_FINGERPRINT,
        items: [{ orderItemId: ITEM_ID, totalPresentmentMinor: 500 }]
      },
      {
        correlationId: 'refund-route-action',
        requestMetadata: { method: 'POST', routeId: '/admin/sales/refunds/[refundId]' }
      }
    );
    expect(routeMocks.submit).not.toHaveBeenCalled();
    expect(result).toEqual({
      reportingCorrectionPreview: correctionPreview,
      reviewCursor: REVIEW_CURSOR
    });
  });

  it('confirms a reporting correction with only route-derived identity and approved values', async () => {
    routeMocks.submit.mockResolvedValueOnce({
      commandId: COMMAND_ID,
      kind: 'refund_reporting_correction_create',
      status: 'pending',
      createdAt: '2026-08-22T12:01:00.000Z'
    });
    const request = urlencoded([
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['reason', 'allocation_attribution_correction'],
      ['expectedNextCorrectionVersion', '2'],
      ['expectedBaseAllocationSetId', BASE_ALLOCATION_SET_ID],
      ['expectedSourceFingerprint', SOURCE_FINGERPRINT],
      ['orderItemId', ITEM_ID],
      ['totalPresentmentMinor', '500'],
      ['previewFingerprint', PREVIEW_FINGERPRINT],
      ['confirmation', 'create_reporting_correction']
    ]);

    const result = await refundRoute.actions.confirmCorrection!(
      actionEvent(ADMIN, request, 'confirmCorrection') as never
    );

    expect(routeMocks.previewCorrection).not.toHaveBeenCalled();
    expect(routeMocks.submit).toHaveBeenCalledWith(routeMocks.database, {
      actor: ADMIN,
      idempotencyKey: IDEMPOTENCY_KEY,
      command: {
        kind: 'refund_reporting_correction_create',
        refundId: REFUND_ID,
        reason: 'allocation_attribution_correction',
        expectedNextCorrectionVersion: 2,
        expectedBaseAllocationSetId: BASE_ALLOCATION_SET_ID,
        expectedSourceFingerprint: SOURCE_FINGERPRINT,
        items: [{ orderItemId: ITEM_ID, totalPresentmentMinor: 500 }],
        previewFingerprint: PREVIEW_FINGERPRINT,
        confirmation: 'create_reporting_correction'
      },
      context: {
        correlationId: 'refund-route-action',
        requestMetadata: { method: 'POST', routeId: '/admin/sales/refunds/[refundId]' }
      }
    });
    expect(result).toMatchObject({
      command: { kind: 'refund_reporting_correction_create', status: 'pending' },
      reviewCursor: REVIEW_CURSOR
    });
  });

  it('returns an already-terminal identical correction replay without another route-side mutation', async () => {
    routeMocks.submit.mockResolvedValueOnce({
      commandId: COMMAND_ID,
      kind: 'refund_reporting_correction_create',
      status: 'succeeded',
      createdAt: '2026-08-22T12:01:00.000Z'
    });
    const request = urlencoded([
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['reason', 'allocation_attribution_correction'],
      ['expectedNextCorrectionVersion', '2'],
      ['expectedBaseAllocationSetId', BASE_ALLOCATION_SET_ID],
      ['expectedSourceFingerprint', SOURCE_FINGERPRINT],
      ['orderItemId', ITEM_ID],
      ['totalPresentmentMinor', '500'],
      ['previewFingerprint', PREVIEW_FINGERPRINT],
      ['confirmation', 'create_reporting_correction']
    ]);

    const result = await refundRoute.actions.confirmCorrection!(
      actionEvent(ADMIN, request, 'confirmCorrection') as never
    );

    expect(result).toMatchObject({
      command: {
        commandId: COMMAND_ID,
        kind: 'refund_reporting_correction_create',
        status: 'succeeded'
      },
      reviewCursor: REVIEW_CURSOR
    });
    expect(routeMocks.submit).toHaveBeenCalledTimes(1);
    expect(routeMocks.previewCorrection).not.toHaveBeenCalled();
  });

  it('freezes every canonical correction confirmation field after an ambiguous submit', async () => {
    routeMocks.submit.mockRejectedValueOnce(new Error('ambiguous correction outcome'));
    const request = urlencoded([
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['reason', 'allocation_attribution_correction'],
      ['expectedNextCorrectionVersion', '2'],
      ['expectedBaseAllocationSetId', BASE_ALLOCATION_SET_ID],
      ['expectedSourceFingerprint', SOURCE_FINGERPRINT],
      ['orderItemId', ITEM_ID],
      ['totalPresentmentMinor', '500'],
      ['previewFingerprint', PREVIEW_FINGERPRINT],
      ['confirmation', 'create_reporting_correction']
    ]);

    const result = await refundRoute.actions.confirmCorrection!(
      actionEvent(ADMIN, request, 'confirmCorrection') as never
    );

    expect(result).toMatchObject({
      status: 503,
      data: {
        code: 'temporarily_unavailable',
        retrySubmission: {
          action: 'confirmCorrection',
          idempotencyKey: IDEMPOTENCY_KEY,
          reason: 'allocation_attribution_correction',
          expectedNextCorrectionVersion: 2,
          expectedBaseAllocationSetId: BASE_ALLOCATION_SET_ID,
          expectedSourceFingerprint: SOURCE_FINGERPRINT,
          items: [{ orderItemId: ITEM_ID, totalPresentmentMinor: 500 }],
          previewFingerprint: PREVIEW_FINGERPRINT,
          confirmation: 'create_reporting_correction'
        }
      }
    });
    expect(JSON.stringify(result)).not.toContain('ambiguous correction outcome');
  });

  it.each(['pending', 'succeeded'] as const)(
    'replays the exact frozen correction payload and recovers its %s command',
    async (status) => {
      const entries = [
        ['idempotencyKey', IDEMPOTENCY_KEY],
        ['reason', 'allocation_attribution_correction'],
        ['expectedNextCorrectionVersion', '2'],
        ['expectedBaseAllocationSetId', BASE_ALLOCATION_SET_ID],
        ['expectedSourceFingerprint', SOURCE_FINGERPRINT],
        ['orderItemId', ITEM_ID],
        ['totalPresentmentMinor', '500'],
        ['previewFingerprint', PREVIEW_FINGERPRINT],
        ['confirmation', 'create_reporting_correction']
      ] as const;
      routeMocks.submit
        .mockRejectedValueOnce(new Error('ambiguous correction outcome'))
        .mockResolvedValueOnce({
          commandId: COMMAND_ID,
          kind: 'refund_reporting_correction_create',
          status,
          createdAt: '2026-08-22T12:01:00.000Z'
        });

      const ambiguous = await refundRoute.actions.confirmCorrection!(
        actionEvent(ADMIN, urlencoded(entries), 'confirmCorrection') as never
      );
      expect(ambiguous).toMatchObject({
        status: 503,
        data: { retrySubmission: { action: 'confirmCorrection' } }
      });
      const firstSubmission = routeMocks.submit.mock.calls[0];

      const recovered = await refundRoute.actions.confirmCorrection!(
        actionEvent(ADMIN, urlencoded(entries), 'confirmCorrection') as never
      );

      expect(routeMocks.submit).toHaveBeenCalledTimes(2);
      expect(routeMocks.submit.mock.calls[1]).toEqual(firstSubmission);
      expect(recovered).toMatchObject({
        command: {
          commandId: COMMAND_ID,
          kind: 'refund_reporting_correction_create',
          status
        },
        reviewCursor: REVIEW_CURSOR
      });
    }
  );

  it('does not freeze a correction retry for stale preparation or same-key payload drift', async () => {
    routeMocks.previewCorrection.mockRejectedValueOnce(
      new FinancialAdminConflictError('stale_state')
    );
    const prepared = await refundRoute.actions.prepareCorrection!(actionEvent(
      ADMIN,
      urlencoded([
        ['reason', 'allocation_attribution_correction'],
        ['expectedNextCorrectionVersion', '2'],
        ['expectedBaseAllocationSetId', BASE_ALLOCATION_SET_ID],
        ['expectedSourceFingerprint', SOURCE_FINGERPRINT],
        ['orderItemId', ITEM_ID],
        ['totalPresentmentMinor', '500']
      ]),
      'prepareCorrection'
    ) as never);
    expect(prepared).toMatchObject({
      status: 409,
      data: { code: 'stale_state', retrySubmission: null }
    });

    routeMocks.submit.mockRejectedValueOnce(
      new FinancialAdminCommandSubmissionConflictError()
    );
    const confirmed = await refundRoute.actions.confirmCorrection!(actionEvent(
      ADMIN,
      urlencoded([
        ['idempotencyKey', IDEMPOTENCY_KEY],
        ['reason', 'allocation_attribution_correction'],
        ['expectedNextCorrectionVersion', '2'],
        ['expectedBaseAllocationSetId', BASE_ALLOCATION_SET_ID],
        ['expectedSourceFingerprint', SOURCE_FINGERPRINT],
        ['orderItemId', ITEM_ID],
        ['totalPresentmentMinor', '500'],
        ['previewFingerprint', PREVIEW_FINGERPRINT],
        ['confirmation', 'create_reporting_correction']
      ]),
      'confirmCorrection'
    ) as never);
    expect(confirmed).toMatchObject({
      status: 409,
      data: { code: 'stale_state', retrySubmission: null }
    });
    expect(routeMocks.submit).toHaveBeenCalledTimes(1);
  });

  it.each(['prepareFinalize', 'confirmFinalize'] as const)(
    'checks same-origin before consuming the %s body',
    async (action) => {
      let pulled = false;
      const request = new Request(
        `https://books.example.test/admin/sales/refunds/${REFUND_ID}`,
        {
          method: 'POST',
          headers: {
            origin: 'https://evil.example.test',
            'content-type': 'application/x-www-form-urlencoded'
          },
          body: 'unused'
        }
      );
      Object.defineProperty(request, 'body', {
        configurable: true,
        get() {
          pulled = true;
          throw new Error('private body read');
        }
      });
      const protectedAccesses = {
        params: vi.fn(),
        url: vi.fn(),
        route: vi.fn()
      };
      const event: Record<string, unknown> = {
        locals: { actor: ADMIN },
        request
      };
      for (const key of Object.keys(protectedAccesses) as Array<keyof typeof protectedAccesses>) {
        Object.defineProperty(event, key, {
          enumerable: true,
          get: protectedAccesses[key]
        });
      }

      const result = await refundRoute.actions[action]!(
        event as never
      );

      expect(result).toMatchObject({ status: 403, data: { code: 'forbidden' } });
      expect(pulled).toBe(false);
      for (const access of Object.values(protectedAccesses)) {
        expect(access).not.toHaveBeenCalled();
      }
      expect(routeMocks.preview).not.toHaveBeenCalled();
      expect(routeMocks.submit).not.toHaveBeenCalled();
    }
  );

  it.each(['prepareFinalize', 'confirmFinalize'] as const)(
    'accepts only the exact empty %s action marker before parsing the body',
    async (action) => {
      const request = urlencoded([
        ['expectedActiveDraftVersion', '2']
      ]);
      const event = actionEvent(ADMIN, request, action);
      event.url = new URL(`${request.url}?/${action}=private&reviewCursor=${REVIEW_CURSOR}`);

      const result = await refundRoute.actions[action]!(event as never);

      expect(result).toMatchObject({ status: 400, data: { code: 'invalid_request' } });
      expect(routeMocks.preview).not.toHaveBeenCalled();
      expect(routeMocks.submit).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['prepareFinalize', [
      ['expectedActiveDraftVersion', '2'],
      ['privateExtra', 'must-not-pass']
    ]],
    ['confirmFinalize', [
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['expectedActiveDraftVersion', '2'],
      ['previewFingerprint', PREVIEW_FINGERPRINT],
      ['confirmation', 'finalize_refund_allocation'],
      ['privateExtra', 'must-not-pass']
    ]]
  ] as const)('rejects unknown %s form fields before calling a domain service', async (
    action,
    entries
  ) => {
    const result = await refundRoute.actions[action]!(
      actionEvent(ADMIN, urlencoded(entries), action) as never
    );

    expect(result).toMatchObject({
      status: 400,
      data: { code: 'invalid_request', retrySubmission: null }
    });
    expect(routeMocks.preview).not.toHaveBeenCalled();
    expect(routeMocks.submit).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('must-not-pass');
  });

  it.each(['stale_state', 'not_eligible'] as const)(
    'maps %s prepare drift to reload guidance without a command retry',
    async (safeCode) => {
      routeMocks.preview.mockRejectedValueOnce(new FinancialAdminConflictError(safeCode));
      const result = await refundRoute.actions.prepareFinalize!(actionEvent(
        ADMIN,
        urlencoded([['expectedActiveDraftVersion', '2']]),
        'prepareFinalize'
      ) as never);

      expect(result).toMatchObject({
        status: 409,
        data: { code: 'stale_state', retrySubmission: null }
      });
      expect(routeMocks.submit).not.toHaveBeenCalled();
    }
  );

  it('keeps preparation rerunnable after a private availability failure', async () => {
    routeMocks.preview.mockRejectedValueOnce(new Error('private preview detail'));
    const result = await refundRoute.actions.prepareFinalize!(actionEvent(
      ADMIN,
      urlencoded([['expectedActiveDraftVersion', '2']]),
      'prepareFinalize'
    ) as never);

    expect(result).toMatchObject({
      status: 503,
      data: { code: 'temporarily_unavailable', retrySubmission: null }
    });
    expect(result).not.toHaveProperty('data.command');
    expect(JSON.stringify(result)).not.toContain('private preview detail');
  });

  it('preserves only the exact canonical confirm payload after an ambiguous submit', async () => {
    routeMocks.submit.mockRejectedValueOnce(new Error('ambiguous command outcome'));
    const request = urlencoded([
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['expectedActiveDraftVersion', '2'],
      ['previewFingerprint', PREVIEW_FINGERPRINT],
      ['confirmation', 'finalize_refund_allocation']
    ]);

    const result = await refundRoute.actions.confirmFinalize!(
      actionEvent(ADMIN, request, 'confirmFinalize') as never
    );

    expect(result).toMatchObject({
      status: 503,
      data: {
        code: 'temporarily_unavailable',
        retrySubmission: {
          action: 'confirmFinalize',
          idempotencyKey: IDEMPOTENCY_KEY,
          expectedActiveDraftVersion: 2,
          previewFingerprint: PREVIEW_FINGERPRINT,
          confirmation: 'finalize_refund_allocation'
        }
      }
    });
    expect(JSON.stringify(result)).not.toContain('ambiguous command outcome');
  });

  it('does not offer an exact retry when confirm conflicts or fails before canonical parsing', async () => {
    routeMocks.submit.mockRejectedValueOnce(
      new FinancialAdminCommandSubmissionConflictError()
    );
    const conflict = await refundRoute.actions.confirmFinalize!(
      actionEvent(ADMIN, urlencoded([
        ['idempotencyKey', IDEMPOTENCY_KEY],
        ['expectedActiveDraftVersion', '2'],
        ['previewFingerprint', PREVIEW_FINGERPRINT],
        ['confirmation', 'finalize_refund_allocation']
      ]), 'confirmFinalize') as never
    );
    expect(conflict).toMatchObject({
      status: 409,
      data: { code: 'stale_state', retrySubmission: null }
    });

    const malformed = await refundRoute.actions.confirmFinalize!(
      actionEvent(ADMIN, urlencoded([
        ['idempotencyKey', IDEMPOTENCY_KEY],
        ['expectedActiveDraftVersion', '2'],
        ['previewFingerprint', PREVIEW_FINGERPRINT],
        ['confirmation', 'private-wrong-value']
      ]), 'confirmFinalize') as never
    );
    expect(malformed).toMatchObject({
      status: 400,
      data: { code: 'invalid_request', retrySubmission: null }
    });
    expect(routeMocks.submit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['foreign origin', 'https://evil.example.test', null, 403, 'forbidden'],
    ['malformed body', 'https://books.example.test', null, 400, 'invalid_request'],
    ['conflicting replay', 'https://books.example.test', new FinancialAdminCommandSubmissionConflictError(), 409, 'stale_state'],
    ['private repository failure', 'https://books.example.test', new Error('private'), 503, 'temporarily_unavailable']
  ])('returns safe action failure for %s', async (_label, origin, rejection, status, code) => {
    if (rejection !== null) routeMocks.submit.mockRejectedValueOnce(rejection);
    const body = rejection === null
      ? 'private=value'
      : new URLSearchParams([
          ['idempotencyKey', IDEMPOTENCY_KEY],
          ['expectedVersion', ''],
          ['orderItemId', ITEM_ID],
          ['totalPresentmentMinor', '500']
        ]).toString();
    const request = new Request(`https://books.example.test/admin/sales/refunds/${REFUND_ID}`, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body
    });
    const result = await refundRoute.actions.saveDraft!(actionEvent(ADMIN, request) as never);
    expect(result).toMatchObject({ status, data: { code } });
    expect(JSON.stringify(result)).not.toContain('private repository failure');
    if (status === 403 || status === 400) expect(routeMocks.submit).not.toHaveBeenCalled();
  });

  it('returns a visible item-linked error for a malformed canonical item amount', async () => {
    const request = urlencoded([
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['expectedVersion', '1'],
      ['orderItemId', ITEM_ID],
      ['totalPresentmentMinor', '-1']
    ]);

    const result = await refundRoute.actions.saveDraft!(
      actionEvent(ADMIN, request) as never
    );

    expect(result).toMatchObject({
      status: 400,
      data: {
        code: 'invalid_request',
        fieldErrors: {
          form: 'Check the highlighted refund amount and try again.',
          [ITEM_ID]: 'Enter a whole amount from 0 through 99,999,999.'
        }
      }
    });
    expect(routeMocks.submit).not.toHaveBeenCalled();
  });

  it('preserves the exact canonical save submission for an ambiguous retry', async () => {
    routeMocks.submit.mockRejectedValueOnce(new Error('ambiguous database outcome'));
    const request = urlencoded([
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['expectedVersion', ''],
      ['orderItemId', ITEM_ID],
      ['totalPresentmentMinor', '500']
    ]);

    const result = await refundRoute.actions.saveDraft!(
      actionEvent(ADMIN, request) as never
    );

    expect(result).toMatchObject({
      status: 503,
      data: {
        code: 'temporarily_unavailable',
        retrySubmission: {
          action: 'saveDraft',
          idempotencyKey: IDEMPOTENCY_KEY,
          expectedVersion: null,
          items: [{ orderItemId: ITEM_ID, totalPresentmentMinor: 500 }]
        }
      }
    });
    expect(JSON.stringify(result)).not.toContain('ambiguous database outcome');
  });

  it('preserves the exact canonical discard submission for an ambiguous retry', async () => {
    routeMocks.submit.mockRejectedValueOnce(new Error('ambiguous database outcome'));
    const request = urlencoded([
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['expectedActiveDraftVersion', '2']
    ]);

    const result = await refundRoute.actions.discardDraft!(
      actionEvent(ADMIN, request, 'discardDraft') as never
    );

    expect(result).toMatchObject({
      status: 503,
      data: {
        code: 'temporarily_unavailable',
        retrySubmission: {
          action: 'discardDraft',
          idempotencyKey: IDEMPOTENCY_KEY,
          expectedActiveDraftVersion: 2
        }
      }
    });
  });

  it('checks same-origin before consuming the body', async () => {
    let pulled = false;
    const request = new Request(`https://books.example.test/admin/sales/refunds/${REFUND_ID}`, {
      method: 'POST',
      headers: {
        origin: 'https://evil.example.test',
        'content-type': 'application/x-www-form-urlencoded'
      }, body: 'unused'
    });
    Object.defineProperty(request, 'body', {
      configurable: true,
      get() {
        pulled = true;
        throw new Error('private body read');
      }
    });
    await refundRoute.actions.saveDraft!(actionEvent(ADMIN, request) as never);
    expect(pulled).toBe(false);
  });
});
