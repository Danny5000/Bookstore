import { isProxy } from 'node:util/types';
import { z } from 'zod';

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const SAFE_MONEY_MAX = 99_999_999;
const MAX_COMMAND_ITEMS = 25;

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const UTC_MILLISECOND_TIMESTAMP =
  /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9][.][0-9]{3}Z$/u;

const canonicalUuidSchema = z.string().regex(CANONICAL_UUID);
const sha256Schema = z.string().regex(SHA256);
const positiveInt32Schema = z.number().refine((value) =>
  Number.isSafeInteger(value) && value >= 1 && value <= POSTGRES_INTEGER_MAX
);
const safeTotalSchema = z.number().refine((value) =>
  Number.isSafeInteger(value) && !Object.is(value, -0) && value >= 0 && value <= SAFE_MONEY_MAX
);
const utcTimestampSchema = z.string().regex(UTC_MILLISECOND_TIMESTAMP).refine((value) => {
  if (value.startsWith('0000-')) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
});

const commandItemSchema = z.strictObject({
  orderItemId: canonicalUuidSchema,
  totalPresentmentMinor: safeTotalSchema
});

const commandItemsSchema = z.array(commandItemSchema).min(1).max(MAX_COMMAND_ITEMS)
  .superRefine((items, context) => {
    const seen = new Set<string>();
    for (let index = 0; index < items.length; index += 1) {
      const orderItemId = items[index]!.orderItemId;
      if (seen.has(orderItemId)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'orderItemId'],
          message: 'order item identifiers must be unique'
        });
      }
      seen.add(orderItemId);
    }
  });

export type FinancialAdminPrivateCommand =
  | {
      readonly kind: 'refund_draft_save';
      readonly refundId: string;
      readonly expectedVersion: number | null;
      readonly items: readonly {
        readonly orderItemId: string;
        readonly totalPresentmentMinor: number;
      }[];
    }
  | {
      readonly kind: 'refund_draft_discard';
      readonly refundId: string;
      readonly expectedActiveDraftVersion: number;
    }
  | {
      readonly kind: 'refund_allocation_finalize';
      readonly refundId: string;
      readonly expectedActiveDraftVersion: number;
      readonly previewFingerprint: string;
      readonly confirmation: 'finalize_refund_allocation';
    }
  | {
      readonly kind: 'refund_reporting_correction_create';
      readonly refundId: string;
      readonly reason: 'allocation_attribution_correction';
      readonly expectedNextCorrectionVersion: number;
      readonly expectedBaseAllocationSetId: string;
      readonly expectedSourceFingerprint: string;
      readonly items: readonly {
        readonly orderItemId: string;
        readonly totalPresentmentMinor: number;
      }[];
      readonly previewFingerprint: string;
      readonly confirmation: 'create_reporting_correction';
    }
  | {
      readonly kind: 'administrative_recovery_activate';
      readonly refundId: string;
      readonly finalizationEffectId: string;
      readonly orderItemId: string;
      readonly expectedCorrectionSetId: string;
      readonly expectedCorrectionVersion: number;
      readonly expectedSourceFingerprint: string;
      readonly previewFingerprint: string;
      readonly confirmation: 'activate_persistent_recovery';
    }
  | {
      readonly kind: 'administrative_recovery_deactivate';
      readonly recoveryGrantId: string;
      readonly recoveryReferenceId: string;
      readonly expectedStateChangedAt: string;
      readonly confirmation: 'deactivate_persistent_recovery';
    };

export const financialAdminPrivateCommandSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('refund_draft_save'),
    refundId: canonicalUuidSchema,
    expectedVersion: positiveInt32Schema.nullable(),
    items: commandItemsSchema
  }),
  z.strictObject({
    kind: z.literal('refund_draft_discard'),
    refundId: canonicalUuidSchema,
    expectedActiveDraftVersion: positiveInt32Schema
  }),
  z.strictObject({
    kind: z.literal('refund_allocation_finalize'),
    refundId: canonicalUuidSchema,
    expectedActiveDraftVersion: positiveInt32Schema,
    previewFingerprint: sha256Schema,
    confirmation: z.literal('finalize_refund_allocation')
  }),
  z.strictObject({
    kind: z.literal('refund_reporting_correction_create'),
    refundId: canonicalUuidSchema,
    reason: z.literal('allocation_attribution_correction'),
    expectedNextCorrectionVersion: positiveInt32Schema,
    expectedBaseAllocationSetId: canonicalUuidSchema,
    expectedSourceFingerprint: sha256Schema,
    items: commandItemsSchema,
    previewFingerprint: sha256Schema,
    confirmation: z.literal('create_reporting_correction')
  }),
  z.strictObject({
    kind: z.literal('administrative_recovery_activate'),
    refundId: canonicalUuidSchema,
    finalizationEffectId: canonicalUuidSchema,
    orderItemId: canonicalUuidSchema,
    expectedCorrectionSetId: canonicalUuidSchema,
    expectedCorrectionVersion: positiveInt32Schema,
    expectedSourceFingerprint: sha256Schema,
    previewFingerprint: sha256Schema,
    confirmation: z.literal('activate_persistent_recovery')
  }),
  z.strictObject({
    kind: z.literal('administrative_recovery_deactivate'),
    recoveryGrantId: canonicalUuidSchema,
    recoveryReferenceId: canonicalUuidSchema,
    expectedStateChangedAt: utcTimestampSchema,
    confirmation: z.literal('deactivate_persistent_recovery')
  })
]);

function canonicalJsonValue(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== 'object' || isProxy(value)) return false;

  if (ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return false;
      const keys = Reflect.ownKeys(value);
      if (keys.length !== value.length + 1 || !keys.includes('length')) return false;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !descriptor.enumerable ||
          !Object.hasOwn(descriptor, 'value') ||
          !canonicalJsonValue(descriptor.value, ancestors)) return false;
      }
      return true;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    if (!keys.every((key) => typeof key === 'string')) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of keys) {
      const descriptor = descriptors[key as string];
      if (descriptor === undefined || !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value') ||
        !canonicalJsonValue(descriptor.value, ancestors)) return false;
    }
    return true;
  } finally {
    ancestors.delete(value);
  }
}

function invalidPrivateCommand(): never {
  return z.never().parse(undefined);
}

export function parseFinancialAdminPrivateCommand(
  value: unknown
): FinancialAdminPrivateCommand {
  let structurallyValid = false;
  try {
    structurallyValid = canonicalJsonValue(value, new Set<object>());
  } catch {
    // Exotic values are invalid input; do not expose their traps or errors.
  }
  if (!structurallyValid) return invalidPrivateCommand();
  return financialAdminPrivateCommandSchema.parse(value) as FinancialAdminPrivateCommand;
}
