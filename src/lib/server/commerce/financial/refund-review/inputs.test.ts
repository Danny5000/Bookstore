import { describe, expect, it } from 'vitest';
import {
  parseAdministrativeRecoveryActivateConfirmRequest,
  parseAdministrativeRecoveryActivatePrepareRequest,
  parseAdministrativeRecoveryDeactivateConfirmRequest,
  parseAdministrativeRecoveryDeactivatePrepareRequest,
  parseRefundReportingCorrectionConfirmRequest,
  parseRefundReportingCorrectionPrepareRequest,
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

describe('refund reporting-correction form input', () => {
  const BASE_ALLOCATION_SET_ID = '00000000-0000-4000-8000-000000011005';
  const SOURCE_FINGERPRINT = 'b'.repeat(64);
  const PREVIEW_FINGERPRINT = 'c'.repeat(64);
  const prepareEntries = [
    ['reason', 'allocation_attribution_correction'],
    ['expectedNextCorrectionVersion', '4'],
    ['expectedBaseAllocationSetId', BASE_ALLOCATION_SET_ID],
    ['expectedSourceFingerprint', SOURCE_FINGERPRINT],
    ['orderItemId', SECOND_ITEM_ID],
    ['totalPresentmentMinor', '125'],
    ['orderItemId', FIRST_ITEM_ID],
    ['totalPresentmentMinor', '0']
  ] as const;

  it('parses only syntax and sorts the exact complete prepare payload', async () => {
    await expect(parseRefundReportingCorrectionPrepareRequest(
      formRequest(prepareEntries), REFUND_ID
    )).resolves.toEqual({
      refundId: REFUND_ID,
      reason: 'allocation_attribution_correction',
      expectedNextCorrectionVersion: 4,
      expectedBaseAllocationSetId: BASE_ALLOCATION_SET_ID,
      expectedSourceFingerprint: SOURCE_FINGERPRINT,
      items: [
        { orderItemId: FIRST_ITEM_ID, totalPresentmentMinor: 0 },
        { orderItemId: SECOND_ITEM_ID, totalPresentmentMinor: 125 }
      ]
    });
  });

  it('parses the fixed confirm command without accepting either derived tip ID', async () => {
    await expect(parseRefundReportingCorrectionConfirmRequest(formRequest([
      ...prepareEntries,
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['previewFingerprint', PREVIEW_FINGERPRINT],
      ['confirmation', 'create_reporting_correction']
    ]), REFUND_ID)).resolves.toEqual({
      idempotencyKey: IDEMPOTENCY_KEY,
      command: {
        kind: 'refund_reporting_correction_create',
        refundId: REFUND_ID,
        reason: 'allocation_attribution_correction',
        expectedNextCorrectionVersion: 4,
        expectedBaseAllocationSetId: BASE_ALLOCATION_SET_ID,
        expectedSourceFingerprint: SOURCE_FINGERPRINT,
        items: [
          { orderItemId: FIRST_ITEM_ID, totalPresentmentMinor: 0 },
          { orderItemId: SECOND_ITEM_ID, totalPresentmentMinor: 125 }
        ],
        previewFingerprint: PREVIEW_FINGERPRINT,
        confirmation: 'create_reporting_correction'
      }
    });
  });

  it.each([
    ['wrong reason', prepareEntries.map((entry) =>
      entry[0] === 'reason' ? ['reason', 'free-form'] as const : entry)],
    ['noncanonical version', prepareEntries.map((entry) =>
      entry[0] === 'expectedNextCorrectionVersion'
        ? ['expectedNextCorrectionVersion', '04'] as const : entry)],
    ['uppercase source fingerprint', prepareEntries.map((entry) =>
      entry[0] === 'expectedSourceFingerprint'
        ? ['expectedSourceFingerprint', SOURCE_FINGERPRINT.toUpperCase()] as const : entry)],
    ['duplicate scalar', [...prepareEntries, ['reason', 'allocation_attribution_correction']]],
    ['unpaired item arrays', prepareEntries.filter((entry) =>
      !(entry[0] === 'totalPresentmentMinor' && entry[1] === '0'))],
    ['duplicate item ID', prepareEntries.map((entry) =>
      entry[0] === 'orderItemId' && entry[1] === SECOND_ITEM_ID
        ? ['orderItemId', FIRST_ITEM_ID] as const : entry)],
    ['unknown key', [...prepareEntries, ['rawPredecessorCorrectionSetId', FIRST_ITEM_ID]]]
  ] as const)('rejects %s prepare data', async (_label, entries) => {
    await expect(parseRefundReportingCorrectionPrepareRequest(
      formRequest(entries), REFUND_ID
    )).rejects.toMatchObject({ name: 'RefundReviewInputError' });
  });

  it.each([
    ['uppercase preview fingerprint', [
      ...prepareEntries,
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['previewFingerprint', PREVIEW_FINGERPRINT.toUpperCase()],
      ['confirmation', 'create_reporting_correction']
    ]],
    ['wrong confirmation', [
      ...prepareEntries,
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['previewFingerprint', PREVIEW_FINGERPRINT],
      ['confirmation', 'yes']
    ]],
    ['derived tip', [
      ...prepareEntries,
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['previewFingerprint', PREVIEW_FINGERPRINT],
      ['confirmation', 'create_reporting_correction'],
      ['compatibleCorrectionSetId', FIRST_ITEM_ID]
    ]]
  ] as const)('rejects %s confirm data', async (_label, entries) => {
    await expect(parseRefundReportingCorrectionConfirmRequest(
      formRequest(entries), REFUND_ID
    )).rejects.toMatchObject({ name: 'RefundReviewInputError' });
  });

  it('accepts the syntactic 25-item bound and rejects the 26th item', async () => {
    const entries = [
      ['reason', 'allocation_attribution_correction'],
      ['expectedNextCorrectionVersion', '1'],
      ['expectedBaseAllocationSetId', BASE_ALLOCATION_SET_ID],
      ['expectedSourceFingerprint', SOURCE_FINGERPRINT]
    ] as [string, string][];
    for (let index = 1; index <= 25; index += 1) {
      entries.push(
        ['orderItemId', `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`],
        ['totalPresentmentMinor', '0']
      );
    }
    await expect(parseRefundReportingCorrectionPrepareRequest(
      formRequest(entries), REFUND_ID
    )).resolves.toMatchObject({ items: expect.arrayContaining([expect.any(Object)]) });
    entries.push(
      ['orderItemId', '00000000-0000-4000-8000-000000000026'],
      ['totalPresentmentMinor', '0']
    );
    await expect(parseRefundReportingCorrectionPrepareRequest(
      formRequest(entries), REFUND_ID
    )).rejects.toMatchObject({ name: 'RefundReviewInputError' });
  });
});

describe('administrative recovery form input', () => {
  const FINALIZATION_EFFECT_ID = '00000000-0000-4000-8000-000000011006';
  const CORRECTION_SET_ID = '00000000-0000-4000-8000-000000011007';
  const RECOVERY_GRANT_ID = '00000000-0000-4000-8000-000000011008';
  const RECOVERY_REFERENCE_ID = '00000000-0000-4000-8000-000000011009';
  const SOURCE_FINGERPRINT = 'd'.repeat(64);
  const PREVIEW_FINGERPRINT = 'e'.repeat(64);
  const STATE_CHANGED_AT = '2026-08-21T12:34:56.789Z';

  const activationPrepareEntries = [
    ['finalizationEffectId', FINALIZATION_EFFECT_ID],
    ['orderItemId', FIRST_ITEM_ID],
    ['expectedCorrectionSetId', CORRECTION_SET_ID],
    ['expectedCorrectionVersion', '7'],
    ['expectedSourceFingerprint', SOURCE_FINGERPRINT]
  ] as const;

  const deactivationPrepareEntries = [
    ['recoveryGrantId', RECOVERY_GRANT_ID],
    ['recoveryReferenceId', RECOVERY_REFERENCE_ID],
    ['expectedStateChangedAt', STATE_CHANGED_AT]
  ] as const;

  it('parses the exact activation prepare service input with its route-derived refund', async () => {
    await expect(parseAdministrativeRecoveryActivatePrepareRequest(
      formRequest(activationPrepareEntries), REFUND_ID
    )).resolves.toEqual({
      refundId: REFUND_ID,
      finalizationEffectId: FINALIZATION_EFFECT_ID,
      orderItemId: FIRST_ITEM_ID,
      expectedCorrectionSetId: CORRECTION_SET_ID,
      expectedCorrectionVersion: 7,
      expectedSourceFingerprint: SOURCE_FINGERPRINT
    });
  });

  it('parses the exact activation confirmation through the private command contract', async () => {
    await expect(parseAdministrativeRecoveryActivateConfirmRequest(formRequest([
      ...activationPrepareEntries,
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['previewFingerprint', PREVIEW_FINGERPRINT],
      ['confirmation', 'activate_persistent_recovery']
    ]), REFUND_ID)).resolves.toEqual({
      idempotencyKey: IDEMPOTENCY_KEY,
      command: {
        kind: 'administrative_recovery_activate',
        refundId: REFUND_ID,
        finalizationEffectId: FINALIZATION_EFFECT_ID,
        orderItemId: FIRST_ITEM_ID,
        expectedCorrectionSetId: CORRECTION_SET_ID,
        expectedCorrectionVersion: 7,
        expectedSourceFingerprint: SOURCE_FINGERPRINT,
        previewFingerprint: PREVIEW_FINGERPRINT,
        confirmation: 'activate_persistent_recovery'
      }
    });
  });

  it.each([
    ['duplicate scalar', [...activationPrepareEntries, ['orderItemId', FIRST_ITEM_ID]]],
    ['unknown key', [...activationPrepareEntries, ['titleId', SECOND_ITEM_ID]]],
    ['noncanonical version', activationPrepareEntries.map((entry) =>
      entry[0] === 'expectedCorrectionVersion'
        ? ['expectedCorrectionVersion', '07'] as const : entry)],
    ['nonpositive version', activationPrepareEntries.map((entry) =>
      entry[0] === 'expectedCorrectionVersion'
        ? ['expectedCorrectionVersion', '0'] as const : entry)],
    ['out-of-range version', activationPrepareEntries.map((entry) =>
      entry[0] === 'expectedCorrectionVersion'
        ? ['expectedCorrectionVersion', '2147483648'] as const : entry)],
    ['uppercase UUID', activationPrepareEntries.map((entry) =>
      entry[0] === 'finalizationEffectId'
        ? ['finalizationEffectId', 'ABCDEF00-0000-4000-8000-000000011006'] as const : entry)],
    ['uppercase source fingerprint', activationPrepareEntries.map((entry) =>
      entry[0] === 'expectedSourceFingerprint'
        ? ['expectedSourceFingerprint', SOURCE_FINGERPRINT.toUpperCase()] as const : entry)]
  ] as const)('rejects %s activation prepare data', async (_label, entries) => {
    await expect(parseAdministrativeRecoveryActivatePrepareRequest(
      formRequest(entries), REFUND_ID
    )).rejects.toMatchObject({ name: 'RefundReviewInputError' });
  });

  it.each([
    ['uppercase preview fingerprint', [
      ...activationPrepareEntries,
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['previewFingerprint', PREVIEW_FINGERPRINT.toUpperCase()],
      ['confirmation', 'activate_persistent_recovery']
    ]],
    ['wrong confirmation', [
      ...activationPrepareEntries,
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['previewFingerprint', PREVIEW_FINGERPRINT],
      ['confirmation', 'yes']
    ]],
    ['duplicate idempotency key', [
      ...activationPrepareEntries,
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['previewFingerprint', PREVIEW_FINGERPRINT],
      ['confirmation', 'activate_persistent_recovery']
    ]]
  ] as const)('rejects %s activation confirm data', async (_label, entries) => {
    await expect(parseAdministrativeRecoveryActivateConfirmRequest(
      formRequest(entries), REFUND_ID
    )).rejects.toMatchObject({ name: 'RefundReviewInputError' });
  });

  it('parses exact deactivation prepare input with route refundId for service authorization', async () => {
    await expect(parseAdministrativeRecoveryDeactivatePrepareRequest(
      formRequest(deactivationPrepareEntries), REFUND_ID
    )).resolves.toEqual({
      refundId: REFUND_ID,
      recoveryGrantId: RECOVERY_GRANT_ID,
      recoveryReferenceId: RECOVERY_REFERENCE_ID,
      expectedStateChangedAt: STATE_CHANGED_AT
    });
  });

  it('parses deactivation confirmation without adding route state to its command', async () => {
    const submission = await parseAdministrativeRecoveryDeactivateConfirmRequest(formRequest([
      ...deactivationPrepareEntries,
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['confirmation', 'deactivate_persistent_recovery']
    ]));

    expect(submission).toEqual({
      idempotencyKey: IDEMPOTENCY_KEY,
      command: {
        kind: 'administrative_recovery_deactivate',
        recoveryGrantId: RECOVERY_GRANT_ID,
        recoveryReferenceId: RECOVERY_REFERENCE_ID,
        expectedStateChangedAt: STATE_CHANGED_AT,
        confirmation: 'deactivate_persistent_recovery'
      }
    });
    expect(submission.command).not.toHaveProperty('refundId');
  });

  it.each([
    ['missing milliseconds', '2026-08-21T12:34:56Z'],
    ['non-UTC offset', '2026-08-21T12:34:56.789+00:00'],
    ['impossible date', '2026-02-30T12:34:56.789Z'],
    ['year zero', '0000-08-21T12:34:56.789Z'],
    ['lowercase timezone', '2026-08-21T12:34:56.789z']
  ])('rejects a %s deactivation timestamp', async (_label, expectedStateChangedAt) => {
    const entries = deactivationPrepareEntries.map((entry) =>
      entry[0] === 'expectedStateChangedAt'
        ? ['expectedStateChangedAt', expectedStateChangedAt] as const : entry);
    await expect(parseAdministrativeRecoveryDeactivatePrepareRequest(
      formRequest(entries), REFUND_ID
    )).rejects.toMatchObject({ name: 'RefundReviewInputError' });
  });

  it.each([
    ['duplicate scalar', [...deactivationPrepareEntries, ['recoveryGrantId', RECOVERY_GRANT_ID]]],
    ['unknown key', [...deactivationPrepareEntries, ['userId', SECOND_ITEM_ID]]],
    ['uppercase UUID', deactivationPrepareEntries.map((entry) =>
      entry[0] === 'recoveryGrantId'
        ? ['recoveryGrantId', 'ABCDEF00-0000-4000-8000-000000011008'] as const : entry)]
  ] as const)('rejects %s deactivation prepare data', async (_label, entries) => {
    await expect(parseAdministrativeRecoveryDeactivatePrepareRequest(
      formRequest(entries), REFUND_ID
    )).rejects.toMatchObject({ name: 'RefundReviewInputError' });
  });

  it.each([
    ['wrong confirmation', [
      ...deactivationPrepareEntries,
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['confirmation', 'deactivate']
    ]],
    ['duplicate idempotency key', [
      ...deactivationPrepareEntries,
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['confirmation', 'deactivate_persistent_recovery']
    ]],
    ['unknown key', [
      ...deactivationPrepareEntries,
      ['idempotencyKey', IDEMPOTENCY_KEY],
      ['confirmation', 'deactivate_persistent_recovery'],
      ['refundId', REFUND_ID]
    ]]
  ] as const)('rejects %s deactivation confirm data', async (_label, entries) => {
    await expect(parseAdministrativeRecoveryDeactivateConfirmRequest(
      formRequest(entries)
    )).rejects.toMatchObject({ name: 'RefundReviewInputError' });
  });

  it('rejects a deactivation body over 16 KiB', async () => {
    await expect(parseAdministrativeRecoveryDeactivatePrepareRequest(new Request(
      'https://books.example.test/admin/sales/refunds/example', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `recoveryGrantId=${'a'.repeat(17_000)}`
      }
    ), REFUND_ID)).rejects.toMatchObject({ name: 'RefundReviewInputError' });
  });

  it('rejects noncanonical route refund identifiers for both prepare services', async () => {
    const uppercaseRefundId = 'ABCDEF00-0000-4000-8000-000000011001';
    await expect(parseAdministrativeRecoveryActivatePrepareRequest(
      formRequest(activationPrepareEntries), uppercaseRefundId
    )).rejects.toMatchObject({ name: 'RefundReviewInputError' });
    await expect(parseAdministrativeRecoveryDeactivatePrepareRequest(
      formRequest(deactivationPrepareEntries), uppercaseRefundId
    )).rejects.toMatchObject({ name: 'RefundReviewInputError' });
  });
});
