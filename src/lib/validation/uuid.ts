import { z } from 'zod';

export const canonicalUuidSchema = z.uuid().transform((value) => value.toLowerCase());

export function canonicalizeUuid(value: string): string {
  return canonicalUuidSchema.parse(value);
}
