import type { ReaderLocation } from '$lib/types/library';
import type { ProseBlockData, ReaderDocument } from '$lib/types/publication';
import type { ReaderPage, RenderedProseBlock } from '$lib/types/reader';

function fragmentLength(fragments: readonly { text: string }[]): number {
  return fragments.reduce((total, fragment) => total + fragment.text.length, 0);
}

export function proseBlockVisibleLength(content: ProseBlockData): number {
  switch (content.kind) {
    case 'heading':
    case 'paragraph':
    case 'quote':
      return fragmentLength(content.fragments);
    case 'list':
      return content.items.reduce((total, item) => total + fragmentLength(item), 0);
    case 'image':
    case 'break':
      return 0;
  }
}

function documentBlock(
  document: Extract<ReaderDocument, { format: 'prose' }>,
  blockId: string
) {
  for (const section of document.sections) {
    const block = section.blocks.find((candidate) => candidate.id === blockId);
    if (block) return block;
  }
  return null;
}

function validRenderedBlock(
  block: RenderedProseBlock,
  maximumOffset: number
): boolean {
  return (
    block.sourceStartOffset >= 0 &&
    block.sourceEndOffset >= block.sourceStartOffset &&
    block.sourceEndOffset <= maximumOffset
  );
}

export function pageIndexForLocation(
  document: ReaderDocument,
  pages: readonly ReaderPage[],
  location: ReaderLocation
): number | null {
  if (document.format === 'prose') {
    if (location.format !== 'prose' || location.offset < 0) return null;
    const block = documentBlock(document, location.blockId);
    if (!block) return null;
    const maximumOffset = proseBlockVisibleLength(block.content);
    const targetOffset = Math.min(location.offset, maximumOffset);
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
      const page = pages[pageIndex];
      if (page?.type !== 'text') continue;
      for (const rendered of page.blocks ?? []) {
        if (
          rendered.sourceBlockId !== block.id ||
          !validRenderedBlock(rendered, maximumOffset)
        ) continue;
        const isEndpoint = targetOffset === maximumOffset;
        const contains =
          maximumOffset === 0
            ? rendered.sourceStartOffset === 0 && rendered.sourceEndOffset === 0
            : isEndpoint
              ? rendered.sourceStartOffset <= targetOffset && targetOffset <= rendered.sourceEndOffset
              : rendered.sourceStartOffset <= targetOffset && targetOffset < rendered.sourceEndOffset;
        if (contains) return pageIndex;
      }
    }
    return null;
  }

  if (location.format !== 'comic') return null;
  const sourcePage = document.pages.find((page) => page.id === location.pageId);
  if (!sourcePage) return null;
  if (location.panelOrdinal !== null) {
    if (
      !document.guidedViewEnabled ||
      !sourcePage.panels.some((panel) => panel.ordinal === location.panelOrdinal)
    ) return null;
  }
  const pageIndex = pages.findIndex(
    (page) => page.type === 'comic' && page.sourcePageId === sourcePage.id
  );
  return pageIndex >= 0 ? pageIndex : null;
}

export function locationForPage(
  document: ReaderDocument,
  pages: readonly ReaderPage[],
  pageIndex: number,
  comicMode: 'page' | 'guided'
): ReaderLocation | null {
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pages.length) return null;
  const page = pages[pageIndex];
  if (!page) return null;

  if (document.format === 'prose') {
    if (page.type !== 'text') return null;
    for (const rendered of page.blocks ?? []) {
      const block = documentBlock(document, rendered.sourceBlockId);
      if (!block) continue;
      const maximumOffset = proseBlockVisibleLength(block.content);
      if (!validRenderedBlock(rendered, maximumOffset)) continue;
      return {
        format: 'prose',
        blockId: rendered.sourceBlockId,
        offset: rendered.sourceStartOffset
      };
    }
    return null;
  }

  if (page.type !== 'comic') return null;
  const sourcePage = document.pages.find((candidate) => candidate.id === page.sourcePageId);
  if (!sourcePage) return null;
  if (comicMode === 'page') {
    return { format: 'comic', pageId: sourcePage.id, panelOrdinal: null };
  }
  if (!document.guidedViewEnabled) return null;
  const firstPanel = [...sourcePage.panels].sort(
    (left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id)
  )[0];
  return firstPanel
    ? { format: 'comic', pageId: sourcePage.id, panelOrdinal: firstPanel.ordinal }
    : null;
}
