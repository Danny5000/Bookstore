import { z } from 'zod';
import type {
  PanelRegionDto,
  PresentationInput,
  ProseBlockData
} from '$lib/types/publication';

const inlineMarkSchema = z.enum([
  'strong',
  'emphasis',
  'code',
  'subscript',
  'superscript'
]);

const safeHrefSchema = z
  .string()
  .max(2_048)
  .refine((value) => {
    try {
      return ['http:', 'https:', 'mailto:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, 'must use http, https, or mailto');

const inlineFragmentSchema = z
  .object({
    text: z.string().max(20_000).refine((value) => value.trim().length > 0, 'must not be empty'),
    marks: z
      .array(inlineMarkSchema)
      .max(5)
      .transform((marks) => [...new Set(marks)]),
    href: safeHrefSchema.optional()
  })
  .strict();

const fragmentsSchema = z.array(inlineFragmentSchema).min(1).max(10_000);

const proseBlockSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('heading'),
      level: z.union([
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(4),
        z.literal(5),
        z.literal(6)
      ]),
      fragments: fragmentsSchema
    })
    .strict(),
  z.object({ kind: z.literal('paragraph'), fragments: fragmentsSchema }).strict(),
  z.object({ kind: z.literal('quote'), fragments: fragmentsSchema }).strict(),
  z
    .object({
      kind: z.literal('list'),
      ordered: z.boolean(),
      items: z.array(fragmentsSchema).min(1).max(10_000)
    })
    .strict(),
  z
    .object({
      kind: z.literal('image'),
      imageId: z.uuid(),
      alt: z.string().trim().max(2_000)
    })
    .strict(),
  z.object({ kind: z.literal('break') }).strict()
]);

const panelRegionSchema = z
  .object({
    id: z.uuid(),
    ordinal: z.number().int().nonnegative().max(1_000_000),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1)
  })
  .strict()
  .refine((value) => value.x + value.width <= 1, {
    path: ['width'],
    message: 'panel must remain within the horizontal bounds'
  })
  .refine((value) => value.y + value.height <= 1, {
    path: ['height'],
    message: 'panel must remain within the vertical bounds'
  });

const prosePresentationSchema = z
  .object({
    format: z.literal('prose'),
    readingDirection: z.enum(['ltr', 'rtl']),
    guidedViewEnabled: z.literal(false),
    previewSectionId: z.uuid(),
    previewBlockId: z.uuid(),
    previewPageId: z.null()
  })
  .strict();

const comicPresentationSchema = z
  .object({
    format: z.literal('comic'),
    readingDirection: z.enum(['ltr', 'rtl']),
    guidedViewEnabled: z.boolean(),
    previewSectionId: z.null(),
    previewBlockId: z.null(),
    previewPageId: z.uuid()
  })
  .strict();

const presentationInputSchema = z.discriminatedUnion('format', [
  prosePresentationSchema,
  comicPresentationSchema
]);

export function parseProseBlock(value: unknown): ProseBlockData {
  return proseBlockSchema.parse(value) as ProseBlockData;
}

export function parsePanelRegion(value: unknown): PanelRegionDto {
  return panelRegionSchema.parse(value);
}

export function parsePresentationInput(value: unknown): PresentationInput {
  return presentationInputSchema.parse(value);
}
