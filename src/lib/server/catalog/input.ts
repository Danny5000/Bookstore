import { z } from 'zod';

const optionalTrimmedText = z
  .string()
  .trim()
  .transform((value) => (value.length === 0 ? null : value))
  .nullable()
  .optional()
  .transform((value) => value ?? null);

const createTitleInputSchema = z.object({
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().trim().min(1).max(300),
  subtitle: optionalTrimmedText,
  description: z.string().trim().min(1).max(20_000),
  creatorName: z.string().trim().min(1).max(300),
  format: z.enum(['prose', 'comic']),
  priceMinor: z.number().int().nonnegative().max(2_147_483_647),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/)
});

const createRevisionInputSchema = z.object({
  titleId: z.uuid(),
  parentRevisionId: z.uuid().nullable().optional().transform((value) => value ?? null),
  changeSummary: z.string().trim().min(1).max(2_000)
});

export type CreateTitleInput = z.output<typeof createTitleInputSchema>;
export type CreateRevisionInput = z.output<typeof createRevisionInputSchema>;

export function parseCreateTitleInput(value: unknown): CreateTitleInput {
  return createTitleInputSchema.parse(value);
}

export function parseCreateRevisionInput(value: unknown): CreateRevisionInput {
  return createRevisionInputSchema.parse(value);
}
