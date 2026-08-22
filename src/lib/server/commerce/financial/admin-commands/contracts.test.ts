import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  financialAdminPrivateCommandSchema,
  parseFinancialAdminPrivateCommand,
  type FinancialAdminPrivateCommand
} from './contracts';

const REFUND_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORDER_ITEM_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EFFECT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SET_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const GRANT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const REFERENCE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const FINGERPRINT_A = 'a'.repeat(64);
const FINGERPRINT_B = 'b'.repeat(64);

const validCommands = [
  {
    kind: 'refund_draft_save',
    refundId: REFUND_ID,
    expectedVersion: null,
    items: [{ orderItemId: ORDER_ITEM_ID, totalPresentmentMinor: 0 }]
  },
  {
    kind: 'refund_draft_discard',
    refundId: REFUND_ID,
    expectedActiveDraftVersion: 1
  },
  {
    kind: 'refund_allocation_finalize',
    refundId: REFUND_ID,
    expectedActiveDraftVersion: 2_147_483_647,
    previewFingerprint: FINGERPRINT_A,
    confirmation: 'finalize_refund_allocation'
  },
  {
    kind: 'refund_reporting_correction_create',
    refundId: REFUND_ID,
    reason: 'allocation_attribution_correction',
    expectedNextCorrectionVersion: 2,
    expectedBaseAllocationSetId: SET_ID,
    expectedSourceFingerprint: FINGERPRINT_A,
    items: [{ orderItemId: ORDER_ITEM_ID, totalPresentmentMinor: 99_999_999 }],
    previewFingerprint: FINGERPRINT_B,
    confirmation: 'create_reporting_correction'
  },
  {
    kind: 'administrative_recovery_activate',
    refundId: REFUND_ID,
    finalizationEffectId: EFFECT_ID,
    orderItemId: ORDER_ITEM_ID,
    expectedCorrectionSetId: SET_ID,
    expectedCorrectionVersion: 3,
    expectedSourceFingerprint: FINGERPRINT_A,
    previewFingerprint: FINGERPRINT_B,
    confirmation: 'activate_persistent_recovery'
  },
  {
    kind: 'administrative_recovery_deactivate',
    recoveryGrantId: GRANT_ID,
    recoveryReferenceId: REFERENCE_ID,
    expectedStateChangedAt: '2026-08-21T12:34:56.789Z',
    confirmation: 'deactivate_persistent_recovery'
  }
] as const satisfies readonly FinancialAdminPrivateCommand[];

function itemId(index: number): string {
  return `77777777-7777-4777-8777-${index.toString(16).padStart(12, '0')}`;
}

function expectInvalid(value: unknown): void {
  expect(() => parseFinancialAdminPrivateCommand(value)).toThrow();
}

describe('financial administrator private command contracts', () => {
  it('exports one six-variant discriminated union and accepts every exact payload', () => {
    expect(financialAdminPrivateCommandSchema).toBeInstanceOf(z.ZodDiscriminatedUnion);
    expect(financialAdminPrivateCommandSchema.options).toHaveLength(6);

    for (const command of validCommands) {
      expect(parseFinancialAdminPrivateCommand(command)).toEqual(command);
    }
  });

  it('requires every field and rejects every unknown or forbidden field', () => {
    for (const command of validCommands) {
      for (const key of Object.keys(command)) {
        const missing = { ...command } as Record<string, unknown>;
        delete missing[key];
        expectInvalid(missing);
      }
      expectInvalid({ ...command, unknown: true });
    }

    const draft = validCommands[0];
    for (const key of [
      'customerId', 'userId', 'titleId', 'providerId', 'providerEventId',
      'capability', 'capabilities', 'auditAction', 'result', 'resultCode',
      'jobId', 'jobType', 'actorRoles', 'grantSource', 'evidence', 'reason'
    ]) {
      expectInvalid({ ...draft, [key]: 'forbidden-private-value' });
    }
  });

  it('rejects noncanonical UUIDs and fingerprints instead of normalizing them', () => {
    for (const refundId of [
      REFUND_ID.toUpperCase(),
      `{${REFUND_ID}}`,
      REFUND_ID.replaceAll('-', ''),
      ` ${REFUND_ID}`,
      'not-a-uuid'
    ]) {
      expectInvalid({ ...validCommands[1], refundId });
    }

    for (const previewFingerprint of [
      FINGERPRINT_A.toUpperCase(),
      FINGERPRINT_A.slice(1),
      `${FINGERPRINT_A}0`,
      'g'.repeat(64)
    ]) {
      expectInvalid({ ...validCommands[2], previewFingerprint });
    }

    expectInvalid({ ...validCommands[3], expectedBaseAllocationSetId: SET_ID.toUpperCase() });
    expectInvalid({ ...validCommands[3], expectedSourceFingerprint: FINGERPRINT_A.toUpperCase() });
    expectInvalid({ ...validCommands[4], finalizationEffectId: EFFECT_ID.toUpperCase() });
    expectInvalid({ ...validCommands[4], orderItemId: ORDER_ITEM_ID.toUpperCase() });
    expectInvalid({ ...validCommands[4], expectedCorrectionSetId: SET_ID.toUpperCase() });
    expectInvalid({ ...validCommands[5], recoveryGrantId: GRANT_ID.toUpperCase() });
    expectInvalid({ ...validCommands[5], recoveryReferenceId: REFERENCE_ID.toUpperCase() });
  });

  it('bounds every version to a positive PostgreSQL integer', () => {
    for (const expectedActiveDraftVersion of [
      0, -1, 1.5, 2_147_483_648, Number.MAX_SAFE_INTEGER, Number.NaN, Number.POSITIVE_INFINITY
    ]) {
      expectInvalid({ ...validCommands[1], expectedActiveDraftVersion });
    }

    expect(parseFinancialAdminPrivateCommand({
      ...validCommands[0], expectedVersion: 2_147_483_647
    })).toMatchObject({ expectedVersion: 2_147_483_647 });
    expectInvalid({ ...validCommands[0], expectedVersion: 0 });
    expectInvalid({ ...validCommands[3], expectedNextCorrectionVersion: null });
    expectInvalid({ ...validCommands[4], expectedCorrectionVersion: 2_147_483_648 });
  });

  it('accepts 1-25 unique bounded item totals and rejects malformed item collections', () => {
    const twentyFiveItems = Array.from({ length: 25 }, (_, index) => ({
      orderItemId: itemId(index + 1),
      totalPresentmentMinor: index === 0 ? 0 : 99_999_999
    }));
    expect(parseFinancialAdminPrivateCommand({
      ...validCommands[0], items: twentyFiveItems
    })).toMatchObject({ items: twentyFiveItems });

    const invalidTotals = [
      -1, -0, 0.5, 100_000_000, Number.MAX_SAFE_INTEGER,
      Number.NaN, Number.POSITIVE_INFINITY
    ];
    for (const totalPresentmentMinor of invalidTotals) {
      expectInvalid({
        ...validCommands[0],
        items: [{ orderItemId: ORDER_ITEM_ID, totalPresentmentMinor }]
      });
    }

    expectInvalid({ ...validCommands[0], items: [] });
    expectInvalid({
      ...validCommands[0],
      items: [...twentyFiveItems, { orderItemId: itemId(26), totalPresentmentMinor: 1 }]
    });
    expectInvalid({
      ...validCommands[0],
      items: [twentyFiveItems[0], { ...twentyFiveItems[0] }]
    });
    expectInvalid({
      ...validCommands[0],
      items: [{ ...twentyFiveItems[0], userId: GRANT_ID }]
    });
    expectInvalid({
      ...validCommands[3],
      items: [{ orderItemId: ORDER_ITEM_ID.toUpperCase(), totalPresentmentMinor: 1 }]
    });
  });

  it('requires fixed reason and confirmation literals', () => {
    expectInvalid({ ...validCommands[2], confirmation: 'yes' });
    expectInvalid({ ...validCommands[3], reason: 'customer_requested' });
    expectInvalid({ ...validCommands[3], reason: '' });
    expectInvalid({ ...validCommands[3], confirmation: 'finalize_refund_allocation' });
    expectInvalid({ ...validCommands[4], confirmation: 'create_reporting_correction' });
    expectInvalid({ ...validCommands[5], confirmation: 'activate_persistent_recovery' });
  });

  it('accepts only real canonical UTC millisecond timestamps', () => {
    for (const expectedStateChangedAt of [
      '2026-08-21T12:34:56Z',
      '2026-08-21T12:34:56.78Z',
      '2026-08-21T12:34:56.789+00:00',
      '2026-08-21t12:34:56.789z',
      '2026-08-21T24:00:00.000Z',
      '2026-02-29T12:34:56.789Z',
      '0000-01-01T00:00:00.000Z',
      'not-a-timestamp'
    ]) {
      expectInvalid({ ...validCommands[5], expectedStateChangedAt });
    }
  });

  it('rejects sparse arrays, accessors, and proxies before reading private values', () => {
    const sparseItems = new Array(2) as Array<unknown>;
    sparseItems[0] = { orderItemId: ORDER_ITEM_ID, totalPresentmentMinor: 1 };
    expectInvalid({ ...validCommands[0], items: sparseItems });

    let accessorRead = false;
    const accessor = { ...validCommands[1] } as Record<string, unknown>;
    Object.defineProperty(accessor, 'refundId', {
      enumerable: true,
      get() {
        accessorRead = true;
        return REFUND_ID;
      }
    });
    expectInvalid(accessor);
    expect(accessorRead).toBe(false);

    let proxyTrapRead = false;
    const proxy = new Proxy({ ...validCommands[1] }, {
      getPrototypeOf() {
        proxyTrapRead = true;
        throw new Error('private-proxy-canary');
      }
    });
    expectInvalid(proxy);
    expect(proxyTrapRead).toBe(false);

    const itemProxy = new Proxy(
      { orderItemId: ORDER_ITEM_ID, totalPresentmentMinor: 1 },
      {}
    );
    expectInvalid({ ...validCommands[0], items: [itemProxy] });
  });

  it('rejects noncanonical JSON containers and values', () => {
    class CommandContainer {
      kind = 'refund_draft_discard';
      refundId = REFUND_ID;
      expectedActiveDraftVersion = 1;
    }

    expectInvalid(new CommandContainer());
    expectInvalid(Object.assign(Object.create(validCommands[1]), {}));
    expectInvalid({ ...validCommands[1], [Symbol('private')]: true });

    const hidden = { ...validCommands[1] } as Record<string, unknown>;
    Object.defineProperty(hidden, 'customerId', { value: GRANT_ID, enumerable: false });
    expectInvalid(hidden);

    const extendedItems = [{ orderItemId: ORDER_ITEM_ID, totalPresentmentMinor: 1 }];
    Object.assign(extendedItems, { privateValue: 'hidden-from-json' });
    expectInvalid({ ...validCommands[0], items: extendedItems });

    const cyclic = { ...validCommands[0], items: [] as unknown[] };
    cyclic.items.push(cyclic);
    expectInvalid(cyclic);
    expectInvalid({ ...validCommands[0], items: [{
      orderItemId: ORDER_ITEM_ID,
      totalPresentmentMinor: BigInt(1)
    }] });
    expectInvalid(null);
    expectInvalid([]);
    expectInvalid('refund_draft_save');
  });
});
