import { z } from 'zod';
import { parsePanelRegion, parsePresentationInput } from './content';

const optionalTrimmedText = z
  .string()
  .trim()
  .transform((value) => (value.length === 0 ? null : value))
  .nullable()
  .optional()
  .transform((value) => value ?? null);

const titleMetadataShape = {
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().trim().min(1).max(300),
  subtitle: optionalTrimmedText,
  description: z.string().trim().min(1).max(20_000),
  creatorName: z.string().trim().min(1).max(300),
  priceMinor: z.number().int().nonnegative().max(2_147_483_647),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/)
} as const;

const createTitleInputSchema = z.strictObject({
  ...titleMetadataShape,
  format: z.enum(['prose', 'comic'])
});

const createRevisionInputSchema = z.strictObject({
  titleId: z.uuid(),
  parentRevisionId: z.uuid().nullable().optional().transform((value) => value ?? null),
  changeSummary: z.string().trim().min(1).max(2_000)
});

const updateTitleMetadataInputSchema = z.strictObject({
  titleId: z.uuid(),
  ...titleMetadataShape
});

const confirmCoverSuggestionInputSchema = z.strictObject({
  titleId: z.uuid(),
  revisionId: z.uuid(),
  suggestionId: z.uuid()
});

const optimisticTimestampSchema = z.union([
  z.date(),
  z.iso.datetime({ offset: true }).transform((value) => new Date(value))
]);

const draftPanelSchema = z
  .strictObject({
    pageId: z.uuid(),
    ordinal: z.number().int().positive().max(1_000_000),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number()
  })
  .superRefine((panel, context) => {
    const result = (() => {
      try {
        return parsePanelRegion({
          id: panel.pageId,
          ordinal: panel.ordinal,
          x: panel.x,
          y: panel.y,
          width: panel.width,
          height: panel.height
        });
      } catch {
        return null;
      }
    })();
    if (!result) context.addIssue({ code: 'custom', message: 'Panel rectangle is invalid' });
  });

const presentationCommandShape = {
  titleId: z.uuid(),
  revisionId: z.uuid(),
  presentationId: z.uuid(),
  expectedUpdatedAt: optimisticTimestampSchema
} as const;

const saveProseDraftSchema = z.strictObject({
  ...presentationCommandShape,
  format: z.literal('prose'),
  readingDirection: z.enum(['ltr', 'rtl']),
  guidedViewEnabled: z.literal(false),
  previewSectionId: z.uuid(),
  previewBlockId: z.uuid(),
  previewPageId: z.null(),
  panels: z.array(draftPanelSchema).max(0)
});

const saveComicDraftSchema = z.strictObject({
  ...presentationCommandShape,
  format: z.literal('comic'),
  readingDirection: z.enum(['ltr', 'rtl']),
  guidedViewEnabled: z.boolean(),
  previewSectionId: z.null(),
  previewBlockId: z.null(),
  previewPageId: z.uuid(),
  panels: z.array(draftPanelSchema).max(100_000)
});

const saveDraftPresentationInputSchema = z
  .discriminatedUnion('format', [saveProseDraftSchema, saveComicDraftSchema])
  .superRefine((value, context) => {
    try {
      parsePresentationInput({
        format: value.format,
        readingDirection: value.readingDirection,
        guidedViewEnabled: value.guidedViewEnabled,
        previewSectionId: value.previewSectionId,
        previewBlockId: value.previewBlockId,
        previewPageId: value.previewPageId
      });
    } catch {
      context.addIssue({ code: 'custom', message: 'Presentation boundary is invalid' });
    }
    const panelKeys = new Set<string>();
    for (const [index, panel] of value.panels.entries()) {
      const key = `${panel.pageId}:${panel.ordinal}`;
      if (panelKeys.has(key)) {
        context.addIssue({
          code: 'custom',
          path: ['panels', index, 'ordinal'],
          message: 'Panel ordinal is duplicated for the page'
        });
      }
      panelKeys.add(key);
    }
  });

const publishReaderSettingsInputSchema = z.strictObject(presentationCommandShape);
const revisionPublicationActionInputSchema = z.strictObject({
  titleId: z.uuid(),
  revisionId: z.uuid()
});
const titlePublicationActionInputSchema = z.strictObject({ titleId: z.uuid() });

export type CreateTitleInput = z.output<typeof createTitleInputSchema>;
export type CreateRevisionInput = z.output<typeof createRevisionInputSchema>;
export type UpdateTitleMetadataInput = z.output<typeof updateTitleMetadataInputSchema>;
export type ConfirmCoverSuggestionInput = z.output<typeof confirmCoverSuggestionInputSchema>;
export type SaveDraftPresentationInput = z.output<typeof saveDraftPresentationInputSchema>;
export type PublishReaderSettingsInput = z.output<typeof publishReaderSettingsInputSchema>;
export type RevisionPublicationActionInput = z.output<typeof revisionPublicationActionInputSchema>;
export type TitlePublicationActionInput = z.output<typeof titlePublicationActionInputSchema>;

export function parseCreateTitleInput(value: unknown): CreateTitleInput {
  return createTitleInputSchema.parse(value);
}

export function parseCreateRevisionInput(value: unknown): CreateRevisionInput {
  return createRevisionInputSchema.parse(value);
}

export function parseUpdateTitleMetadataInput(value: unknown): UpdateTitleMetadataInput {
  return updateTitleMetadataInputSchema.parse(value);
}

export function parseConfirmCoverSuggestionInput(value: unknown): ConfirmCoverSuggestionInput {
  return confirmCoverSuggestionInputSchema.parse(value);
}

export function parseSaveDraftPresentationInput(value: unknown): SaveDraftPresentationInput {
  return saveDraftPresentationInputSchema.parse(value);
}

export function parsePublishReaderSettingsInput(value: unknown): PublishReaderSettingsInput {
  return publishReaderSettingsInputSchema.parse(value);
}

export function parseRevisionPublicationActionInput(value: unknown): RevisionPublicationActionInput {
  return revisionPublicationActionInputSchema.parse(value);
}

export function parseTitlePublicationActionInput(value: unknown): TitlePublicationActionInput {
  return titlePublicationActionInputSchema.parse(value);
}
