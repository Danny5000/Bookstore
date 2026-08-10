import { and, eq } from 'drizzle-orm';
import { proseBlockVisibleLength } from '$lib/reader/locations';
import {
  comicPages,
  comicPanelRegions,
  proseBlocks,
  titleRevisions
} from '$lib/server/db/schema';
import type { DatabaseExecutor } from '$lib/server/db/transaction';
import type { ReaderLocation } from '$lib/types/library';
import type { PublicationFormat } from '$lib/types/publication';
import { InvalidReaderLocationError } from './errors';

export interface ReaderAnchorContext {
  titleId: string;
  revisionId: string;
  format: PublicationFormat;
  presentation: {
    id: string;
    state: 'draft' | 'published' | 'superseded';
    guidedViewEnabled: boolean;
  };
  location: ReaderLocation;
}

function invalidLocation(): never {
  throw new InvalidReaderLocationError();
}

export async function validateReaderLocation(
  database: DatabaseExecutor,
  input: ReaderAnchorContext
): Promise<ReaderLocation> {
  if (input.presentation.state !== 'published') invalidLocation();
  if (input.format === 'prose') {
    if (input.location.format !== 'prose' || input.location.offset < 0) invalidLocation();
    const [block] = await database
      .select({ id: proseBlocks.id, content: proseBlocks.content })
      .from(proseBlocks)
      .innerJoin(titleRevisions, eq(titleRevisions.id, proseBlocks.revisionId))
      .where(
        and(
          eq(proseBlocks.id, input.location.blockId),
          eq(proseBlocks.revisionId, input.revisionId),
          eq(titleRevisions.titleId, input.titleId)
        )
      )
      .limit(1);
    if (!block || input.location.offset > proseBlockVisibleLength(block.content)) invalidLocation();
    return input.location;
  }

  if (input.location.format !== 'comic') invalidLocation();
  const [page] = await database
    .select({ id: comicPages.id })
    .from(comicPages)
    .innerJoin(titleRevisions, eq(titleRevisions.id, comicPages.revisionId))
    .where(
      and(
        eq(comicPages.id, input.location.pageId),
        eq(comicPages.revisionId, input.revisionId),
        eq(titleRevisions.titleId, input.titleId)
      )
    )
    .limit(1);
  if (!page) invalidLocation();
  if (input.location.panelOrdinal === null) return input.location;
  if (!input.presentation.guidedViewEnabled) invalidLocation();
  const [panel] = await database
    .select({ ordinal: comicPanelRegions.ordinal })
    .from(comicPanelRegions)
    .where(
      and(
        eq(comicPanelRegions.revisionId, input.revisionId),
        eq(comicPanelRegions.presentationId, input.presentation.id),
        eq(comicPanelRegions.pageId, page.id),
        eq(comicPanelRegions.ordinal, input.location.panelOrdinal)
      )
    )
    .limit(1);
  if (!panel) invalidLocation();
  return input.location;
}
