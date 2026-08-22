import { describe, expect, it } from 'vitest';
import {
  parseRefundFinalizationConfirmRequest,
  parseRefundFinalizationPrepareRequest,
  parseRefundDraftDiscardRequest,
  parseRefundDraftSaveRequest,
  parseRefundReviewReturnContext
} from './inputs';

const REFUND_ID = '00000000-0000-4000-8000-000000011001';
const FIRST_ITEM_ID = '00000000-0000-4000-8000-000000011002';
const SECOND_ITEM_ID = '00000000-0000-4000-8000-000000011003';
const IDEMPOTENCY_KEY = '00000000-0000-4000-8000-000000011004';

function formRequest(entries: readonly (readonly [string, string])[]): Request {
  const body = new URLSearchParams();
  for (const [key, value] of entries) body.append(key, value);
  return new Request('https://books.example.test/admin/sales/refunds/example', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });
}

describe('refund review return context', () => {
  it('accepts no return context and only one bounded canonical review cursor', () => {
    expect(parseRefundReviewReturnContext(
      new URL('https://books.example.test/admin/sales/refunds/example')
    )).toEqual({ reviewCursor: null });

    const cursor = 'eyJ2ZXJzaW9uIjoxfQ';
    expect(parseRefundReviewReturnContext(
      new URL(`https://books.example.test/admin/sales/refunds/example?reviewCursor=${cursor}`),
      { validateCursor: (value) => value }
    )).toEqual({ reviewCursor: cursor });
  });

  it.each([
    '?returnTo=https://private.example.test',
    '?reviewCursor=',
    '?reviewCursor=first&reviewCursor=second',
    `?reviewCursor=${'a'.repeat(1025)}`,
    '?reviewCursor=contains%20spaces'
  ])('rejects unknown, duplicate, empty, oversized, or noncanonical context %s', (search) => {
    expect(() => parseRefundReviewReturnContext(
      new URL(`https://books.example.test/admin/sales/refunds/example${search}`),
      { validateCursor: () => { throw new Error('invalid cursor'); } }
    )).toThrow(expect.objectContaining({ name: 'RefundReviewInputError' }));
  });
});

describe('refund shared-draft form input', () => {
  it('parses, sorts, and canonicalizes a bounded complete save command', async () => {
    const request = formRequest([
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['expectedVersion', '2'],
      ['orderItemId', SECOND_ITEM_ID],
      ['totalPresentmentMinor', '125'],
      ['orderItemId', FIRST_ITEM_ID],
      ['totalPresentmentMinor', '0']
    ]);

    await expect(parseRefundDraftSaveRequest(request, REFUND_ID)).resolves.toEqual({
      idempotencyKey: IDEMPOTENCY_KEY,
      command: {
        kind: 'refund_draft_save',
        refundId: REFUND_ID,
        expectedVersion: 2,
        items: [
          { orderItemId: FIRST_ITEM_ID, totalPresentmentMinor: 0 },
          { orderItemId: SECOND_ITEM_ID, totalPresentmentMinor: 125 }
        ]
      }
    });
  });

  it('uses an empty expected version only for first-save creation', async () => {
    const request = formRequest([
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['expectedVersion', ''],
      ['orderItemId', FIRST_ITEM_ID],
      ['totalPresentmentMinor', '1']
    ]);
    await expect(parseRefundDraftSaveRequest(request, REFUND_ID)).resolves.toMatchObject({
      command: { expectedVersion: null }
    });
  });

  it.each([
    { entries: [['idempotencyKey', IDEMPOTENCY_KEY], ['expectedVersion', '01'], ['orderItemId', FIRST_ITEM_ID], ['totalPresentmentMinor', '1']] },
    { entries: [['idempotencyKey', IDEMPOTENCY_KEY], ['expectedVersion', '1'], ['orderItemId', FIRST_ITEM_ID], ['totalPresentmentMinor', '-0']] },
    { entries: [['idempotencyKey', IDEMPOTENCY_KEY], ['expectedVersion', '1'], ['orderItemId', FIRST_ITEM_ID], ['totalPresentmentMinor', '100000000']] },
    { entries: [['idempotencyKey', IDEMPOTENCY_KEY], ['expectedVersion', '1'], ['orderItemId', FIRST_ITEM_ID], ['totalPresentmentMinor', '1'], ['private', 'value']] },
    { entries: [['idempotencyKey', IDEMPOTENCY_KEY], ['expectedVersion', '1'], ['orderItemId', FIRST_ITEM_ID], ['orderItemId', FIRST_ITEM_ID], ['totalPresentmentMinor', '1'], ['totalPresentmentMinor', '2']] }
  ] as const)('rejects noncanonical, unknown, or duplicate save data %#', async ({ entries }) => {
    await expect(parseRefundDraftSaveRequest(formRequest(entries), REFUND_ID))
      .rejects.toMatchObject({ name: 'RefundReviewInputError' });
  });

  it('links an invalid amount only to its canonical item field', async () => {
    const request = formRequest([
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['expectedVersion', '1'],
      ['orderItemId', FIRST_ITEM_ID],
      ['totalPresentmentMinor', '-1']
    ]);

    await expect(parseRefundDraftSaveRequest(request, REFUND_ID)).rejects.toMatchObject({
      name: 'RefundReviewInputError',
      fieldKey: FIRST_ITEM_ID
    });
  });

  it('rejects non-urlencoded and oversized bodies before parsing', async () => {
    await expect(parseRefundDraftSaveRequest(new Request('https://books.example.test/', {
      method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=private' },
      body: 'private'
    }), REFUND_ID)).rejects.toMatchObject({ name: 'RefundReviewInputError' });

    await expect(parseRefundDraftSaveRequest(new Request('https://books.example.test/', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `private=${'x'.repeat(17_000)}`
    }), REFUND_ID)).rejects.toMatchObject({ name: 'RefundReviewInputError' });
  });

  it('parses the exact discard command and rejects extra or nonpositive versions', async () => {
    await expect(parseRefundDraftDiscardRequest(formRequest([
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['expectedActiveDraftVersion', '3']
    ]), REFUND_ID)).resolves.toEqual({
      idempotencyKey: IDEMPOTENCY_KEY,
      command: {
        kind: 'refund_draft_discard',
        refundId: REFUND_ID,
        expectedActiveDraftVersion: 3
      }
    });

    await expect(parseRefundDraftDiscardRequest(formRequest([
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['expectedActiveDraftVersion', '0']
    ]), REFUND_ID)).rejects.toMatchObject({ name: 'RefundReviewInputError' });
  });
});

describe('refund finalization form input', () => {
  const PREVIEW_FINGERPRINT = 'a'.repeat(64);

  it('parses the exact prepare request without accepting command-only fields', async () => {
    await expect(parseRefundFinalizationPrepareRequest(formRequest([
      ['expectedActiveDraftVersion', '3']
    ]), REFUND_ID)).resolves.toEqual({
      refundId: REFUND_ID,
      expectedActiveDraftVersion: 3
    });

    await expect(parseRefundFinalizationPrepareRequest(formRequest([
      ['expectedActiveDraftVersion', '3'],
      ['idempotencyKey', IDEMPOTENCY_KEY]
    ]), REFUND_ID)).rejects.toMatchObject({ name: 'RefundReviewInputError' });
  });

  it('parses only the exact fixed confirmation command', async () => {
    await expect(parseRefundFinalizationConfirmRequest(formRequest([
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['expectedActiveDraftVersion', '3'],
      ['previewFingerprint', PREVIEW_FINGERPRINT],
      ['confirmation', 'finalize_refund_allocation']
    ]), REFUND_ID)).resolves.toEqual({
      idempotencyKey: IDEMPOTENCY_KEY,
      command: {
        kind: 'refund_allocation_finalize',
        refundId: REFUND_ID,
        expectedActiveDraftVersion: 3,
        previewFingerprint: PREVIEW_FINGERPRINT,
        confirmation: 'finalize_refund_allocation'
      }
    });
  });

  it.each([
    ['noncanonical version', [
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['expectedActiveDraftVersion', '03'],
      ['previewFingerprint', PREVIEW_FINGERPRINT],
      ['confirmation', 'finalize_refund_allocation']
    ]],
    ['uppercase fingerprint', [
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['expectedActiveDraftVersion', '3'],
      ['previewFingerprint', PREVIEW_FINGERPRINT.toUpperCase()],
      ['confirmation', 'finalize_refund_allocation']
    ]],
    ['wrong confirmation', [
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['expectedActiveDraftVersion', '3'],
      ['previewFingerprint', PREVIEW_FINGERPRINT],
      ['confirmation', 'yes']
    ]],
    ['unknown key', [
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['expectedActiveDraftVersion', '3'],
      ['previewFingerprint', PREVIEW_FINGERPRINT],
      ['confirmation', 'finalize_refund_allocation'],
      ['private', 'value']
    ]]
  ] as const)('rejects %s', async (_label, entries) => {
    await expect(parseRefundFinalizationConfirmRequest(
      formRequest(entries), REFUND_ID
    )).rejects.toMatchObject({ name: 'RefundReviewInputError' });
  });
});
