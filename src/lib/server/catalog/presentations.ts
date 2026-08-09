import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { requireCapability, type Actor } from '$lib/server/auth/admin-policy';
import { appendAuditEvent } from '$lib/server/audit/service';
import type { Database } from '$lib/server/db/client';
import {
  comicPages,
  comicPanelRegions,
  proseBlocks,
  proseSections,
  revisionPresentations,
  titleRevisions,
  titles,
  type RevisionPresentationRow
} from '$lib/server/db/schema';
import type { DatabaseTransaction } from '$lib/server/db/transaction';
import { withTransaction } from '$lib/server/db/transaction';
import { CatalogDomainError } from './errors';
import {
  parsePublishReaderSettingsInput,
  parseSaveDraftPresentationInput,
  type PublishReaderSettingsInput,
  type SaveDraftPresentationInput
} from './input';
import { withLockedAdminTitle } from './lock';

interface PresentationCommand<T> {
  actor: Actor;
  correlationId: string;
  input: T;
}

const editableRevisionStates = ['ready_for_review', 'active', 'retired'] as const;

function nextUpdatedAt(previous: Date): Date {
  return new Date(Math.max(Date.now(), previous.getTime() + 1));
}

async function requireEditableRevision(
  transaction: DatabaseTransaction,
  titleId: string,
  revisionId: string
): Promise<void> {
  const [revision] = await transaction
    .select({ state: titleRevisions.state })
    .from(titleRevisions)
    .where(and(eq(titleRevisions.id, revisionId), eq(titleRevisions.titleId, titleId)))
    .for('update')
    .limit(1);
  if (!revision || !editableRevisionStates.includes(revision.state as typeof editableRevisionStates[number])) {
    throw new CatalogDomainError('revision_not_editable');
  }
}

async function validateProseBoundary(
  transaction: DatabaseTransaction,
  revisionId: string,
  sectionId: string,
  blockId: string
): Promise<void> {
  const [boundary] = await transaction
    .select({ sectionId: proseSections.id, blockId: proseBlocks.id })
    .from(proseBlocks)
    .innerJoin(
      proseSections,
      and(
        eq(proseSections.id, proseBlocks.sectionId),
        eq(proseSections.revisionId, proseBlocks.revisionId)
      )
    )
    .where(
      and(
        eq(proseBlocks.revisionId, revisionId),
        eq(proseBlocks.id, blockId),
        eq(proseSections.id, sectionId)
      )
    )
    .limit(1);
  const [finalBlock] = await transaction
    .select({ blockId: proseBlocks.id })
    .from(proseBlocks)
    .innerJoin(
      proseSections,
      and(
        eq(proseSections.id, proseBlocks.sectionId),
        eq(proseSections.revisionId, proseBlocks.revisionId)
      )
    )
    .where(eq(proseBlocks.revisionId, revisionId))
    .orderBy(desc(proseSections.ordinal), desc(proseBlocks.ordinal))
    .limit(1);
  if (!boundary || !finalBlock || boundary.blockId === finalBlock.blockId) {
    throw new CatalogDomainError('invalid_preview_boundary');
  }
}

async function validateComicBoundary(
  transaction: DatabaseTransaction,
  revisionId: string,
  pageId: string
): Promise<void> {
  const [boundary] = await transaction
    .select({ id: comicPages.id, ordinal: comicPages.ordinal })
    .from(comicPages)
    .where(and(eq(comicPages.revisionId, revisionId), eq(comicPages.id, pageId)))
    .limit(1);
  const [finalPage] = await transaction
    .select({ ordinal: comicPages.ordinal })
    .from(comicPages)
    .where(eq(comicPages.revisionId, revisionId))
    .orderBy(desc(comicPages.ordinal))
    .limit(1);
  if (!boundary || !finalPage || boundary.ordinal >= finalPage.ordinal) {
    throw new CatalogDomainError('invalid_preview_boundary');
  }
}

async function validatePresentationBoundary(
  transaction: DatabaseTransaction,
  input: SaveDraftPresentationInput,
  titleFormat: 'prose' | 'comic'
): Promise<void> {
  if (input.format !== titleFormat) throw new CatalogDomainError('invalid_preview_boundary');
  if (input.format === 'prose') {
    await validateProseBoundary(
      transaction,
      input.revisionId,
      input.previewSectionId,
      input.previewBlockId
    );
    return;
  }
  await validateComicBoundary(transaction, input.revisionId, input.previewPageId);
  if (input.panels.length === 0) return;
  const pageIds = [...new Set(input.panels.map((panel) => panel.pageId))];
  const pages = await transaction
    .select({ id: comicPages.id })
    .from(comicPages)
    .where(and(eq(comicPages.revisionId, input.revisionId), inArray(comicPages.id, pageIds)));
  if (pages.length !== pageIds.length) throw new CatalogDomainError('invalid_panel_page');
}

async function lockDraft(
  transaction: DatabaseTransaction,
  input: Pick<SaveDraftPresentationInput, 'revisionId' | 'presentationId' | 'expectedUpdatedAt'>
): Promise<RevisionPresentationRow> {
  const [draft] = await transaction
    .select()
    .from(revisionPresentations)
    .where(
      and(
        eq(revisionPresentations.id, input.presentationId),
        eq(revisionPresentations.revisionId, input.revisionId),
        eq(revisionPresentations.state, 'draft')
      )
    )
    .for('update')
    .limit(1);
  if (!draft) throw new CatalogDomainError('presentation_not_found');
  if (draft.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
    throw new CatalogDomainError('stale_presentation');
  }
  return draft;
}

export async function saveDraftPresentation(
  database: Database,
  command: PresentationCommand<SaveDraftPresentationInput>
): Promise<RevisionPresentationRow> {
  requireCapability(command.actor, 'catalog.manage');
  const actor = command.actor;
  const input = parseSaveDraftPresentationInput(command.input);
  return withTransaction(database, async (transaction) => {
    const [titleRecord] = await transaction
      .select({ format: titles.format })
      .from(titles)
      .where(eq(titles.id, input.titleId))
      .limit(1);
    if (!titleRecord) throw new CatalogDomainError('title_not_found');
    await requireEditableRevision(transaction, input.titleId, input.revisionId);
    const draft = await lockDraft(transaction, input);
    await validatePresentationBoundary(transaction, input, titleRecord.format);

    await transaction
      .delete(comicPanelRegions)
      .where(eq(comicPanelRegions.presentationId, draft.id));
    if (input.format === 'comic' && input.panels.length > 0) {
      await transaction.insert(comicPanelRegions).values(
        input.panels.map((panel) => ({
          revisionId: input.revisionId,
          presentationId: draft.id,
          pageId: panel.pageId,
          ordinal: panel.ordinal,
          x: panel.x,
          y: panel.y,
          width: panel.width,
          height: panel.height
        }))
      );
    }
    const updatedAt = nextUpdatedAt(draft.updatedAt);
    const [updated] = await transaction
      .update(revisionPresentations)
      .set({
        readingDirection: input.readingDirection,
        guidedViewEnabled: input.guidedViewEnabled,
        previewProseSectionId: input.previewSectionId,
        previewProseBlockId: input.previewBlockId,
        previewComicPageId: input.previewPageId,
        updatedAt
      })
      .where(eq(revisionPresentations.id, draft.id))
      .returning();
    if (!updated) throw new Error('Presentation update returned no row');
    await appendAuditEvent(transaction, {
      actor,
      action: 'catalog.reader_settings.draft.save',
      outcome: 'succeeded',
      resourceType: 'revision_presentation',
      resourceId: updated.id,
      correlationId: command.correlationId,
      after: {
        revisionId: input.revisionId,
        format: input.format,
        guidedViewEnabled: input.guidedViewEnabled,
        panelCount: input.panels.length
      }
    });
    return updated;
  });
}

async function requireCompleteGuidedView(
  transaction: DatabaseTransaction,
  revisionId: string,
  presentationId: string
): Promise<void> {
  const pages = await transaction
    .select({ id: comicPages.id })
    .from(comicPages)
    .where(eq(comicPages.revisionId, revisionId))
    .orderBy(asc(comicPages.ordinal));
  const panels = await transaction
    .select({ pageId: comicPanelRegions.pageId, ordinal: comicPanelRegions.ordinal })
    .from(comicPanelRegions)
    .where(
      and(
        eq(comicPanelRegions.revisionId, revisionId),
        eq(comicPanelRegions.presentationId, presentationId)
      )
    )
    .orderBy(asc(comicPanelRegions.pageId), asc(comicPanelRegions.ordinal));
  for (const page of pages) {
    const ordinals = panels
      .filter((panel) => panel.pageId === page.id)
      .map((panel) => panel.ordinal);
    if (ordinals.length === 0 || ordinals.some((ordinal, index) => ordinal !== index + 1)) {
      throw new CatalogDomainError('incomplete_guided_view');
    }
  }
}

export async function publishReaderSettings(
  database: Database,
  command: PresentationCommand<PublishReaderSettingsInput>
): Promise<RevisionPresentationRow> {
  requireCapability(command.actor, 'catalog.manage');
  const input = parsePublishReaderSettingsInput(command.input);
  return withTransaction(database, (transaction) =>
    withLockedAdminTitle(transaction, command.actor, input.titleId, async ({ actor, title }) => {
      await requireEditableRevision(transaction, input.titleId, input.revisionId);
      const draft = await lockDraft(transaction, input);
      if (title.format === 'prose') {
        if (!draft.previewProseSectionId || !draft.previewProseBlockId) {
          throw new CatalogDomainError('invalid_preview_boundary');
        }
        await validateProseBoundary(
          transaction,
          input.revisionId,
          draft.previewProseSectionId,
          draft.previewProseBlockId
        );
      } else {
        if (!draft.previewComicPageId) throw new CatalogDomainError('invalid_preview_boundary');
        await validateComicBoundary(transaction, input.revisionId, draft.previewComicPageId);
        if (draft.guidedViewEnabled) {
          await requireCompleteGuidedView(transaction, input.revisionId, draft.id);
        }
      }

      const [currentPublished] = await transaction
        .select()
        .from(revisionPresentations)
        .where(
          and(
            eq(revisionPresentations.revisionId, input.revisionId),
            eq(revisionPresentations.state, 'published')
          )
        )
        .for('update')
        .limit(1);
      const changedAt = nextUpdatedAt(draft.updatedAt);
      if (currentPublished) {
        await transaction
          .update(revisionPresentations)
          .set({ state: 'superseded', updatedAt: changedAt })
          .where(eq(revisionPresentations.id, currentPublished.id));
      }
      const [published] = await transaction
        .update(revisionPresentations)
        .set({ state: 'published', updatedAt: changedAt })
        .where(eq(revisionPresentations.id, draft.id))
        .returning();
      if (!published) throw new Error('Presentation publication returned no row');
      const [newDraft] = await transaction
        .insert(revisionPresentations)
        .values({
          revisionId: input.revisionId,
          state: 'draft',
          readingDirection: published.readingDirection,
          guidedViewEnabled: published.guidedViewEnabled,
          previewProseSectionId: published.previewProseSectionId,
          previewProseBlockId: published.previewProseBlockId,
          previewComicPageId: published.previewComicPageId
        })
        .returning();
      if (!newDraft) throw new Error('Draft clone returned no row');
      const panels = await transaction
        .select()
        .from(comicPanelRegions)
        .where(eq(comicPanelRegions.presentationId, published.id));
      if (panels.length > 0) {
        await transaction.insert(comicPanelRegions).values(
          panels.map((panel) => ({
            revisionId: panel.revisionId,
            presentationId: newDraft.id,
            pageId: panel.pageId,
            ordinal: panel.ordinal,
            x: panel.x,
            y: panel.y,
            width: panel.width,
            height: panel.height
          }))
        );
      }
      await appendAuditEvent(transaction, {
        actor,
        action: 'catalog.reader_settings.publish',
        outcome: 'succeeded',
        resourceType: 'revision_presentation',
        resourceId: published.id,
        correlationId: command.correlationId,
        after: {
          revisionId: input.revisionId,
          presentationId: published.id,
          guidedViewEnabled: published.guidedViewEnabled
        }
      });
      return published;
    })
  );
}
