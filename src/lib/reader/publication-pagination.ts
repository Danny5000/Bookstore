import type {
  InlineFragment,
  ProseBlockData,
  ProseReaderDocument,
  ReaderDocument
} from '$lib/types/publication';
import type {
  ComicReaderPage,
  PageBox,
  ReaderPage,
  RenderedProseBlock,
  TextReaderPage
} from '$lib/types/reader';
import { proseBlockVisibleLength } from './locations';

function fragmentLength(fragments: readonly InlineFragment[]): number {
  return fragments.reduce((total, fragment) => total + fragment.text.length, 0);
}

function blockLength(content: ProseBlockData): number {
  if (content.kind === 'heading' || content.kind === 'paragraph' || content.kind === 'quote') {
    return fragmentLength(content.fragments);
  }
  if (content.kind === 'list') {
    return content.items.reduce((total, item) => total + fragmentLength(item), 0);
  }
  return content.kind === 'image' ? 1 : 0;
}

function plainText(content: ProseBlockData): string {
  if (content.kind === 'heading' || content.kind === 'paragraph' || content.kind === 'quote') {
    return content.fragments.map((fragment) => fragment.text).join('');
  }
  if (content.kind === 'list') {
    return content.items
      .map((item, index) => `${content.ordered ? `${index + 1}.` : '•'} ${item.map((fragment) => fragment.text).join('')}`)
      .join('\n');
  }
  return '';
}

function blockCost(content: ProseBlockData, columns: number, budget: number): number {
  if (content.kind === 'heading') return blockLength(content) + columns * 2.5;
  if (content.kind === 'paragraph') return blockLength(content) + columns * 0.65;
  if (content.kind === 'quote') return blockLength(content) + columns * 1.2;
  if (content.kind === 'list') return blockLength(content) + columns * (1 + content.items.length * 0.65);
  if (content.kind === 'image') return Math.max(columns * 6, budget * 0.48);
  return columns * 1.5;
}

function splitFragments(
  fragments: readonly InlineFragment[],
  maximumCharacters: number
): readonly (readonly InlineFragment[])[] {
  const chunks: InlineFragment[][] = [];
  let current: InlineFragment[] = [];
  let currentLength = 0;
  for (const fragment of fragments) {
    let offset = 0;
    while (offset < fragment.text.length) {
      const available = maximumCharacters - currentLength;
      if (available <= 0) {
        chunks.push(current);
        current = [];
        currentLength = 0;
        continue;
      }
      const text = fragment.text.slice(offset, offset + available);
      current.push({
        text,
        marks: fragment.marks,
        ...(fragment.href ? { href: fragment.href } : {})
      });
      currentLength += text.length;
      offset += text.length;
      if (currentLength >= maximumCharacters) {
        chunks.push(current);
        current = [];
        currentLength = 0;
      }
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function prosePages(document: ProseReaderDocument, box: PageBox): ReaderPage[] {
  const columns = Math.max(16, Math.floor((box.pw - box.pad * 2 - 6) / (box.fs * 0.505)));
  const rows = Math.max(6, Math.floor((box.ph - box.pad * 2 - 26) / (box.fs * 1.72)));
  const budget = columns * rows;
  const paragraphCapacity = Math.max(columns, Math.floor(budget - columns * 0.65));
  const imageUrls = new Map(document.images.map((image) => [image.id, image.url]));
  const output: ReaderPage[] = [];

  for (const section of document.sections) {
    let pageBlocks: RenderedProseBlock[] = [];
    let pageCost = 0;
    let sectionOffset = 0;
    let pageOffset = 0;
    const pushPage = (): void => {
      if (pageBlocks.length === 0) return;
      const firstHeading = pageBlocks.find((block) => block.content.kind === 'heading');
      const page: TextReaderPage = {
        type: 'text',
        chapter: section.ordinal,
        at: pageOffset,
        heading: firstHeading ? plainText(firstHeading.content) : null,
        paras: pageBlocks.map((block) => plainText(block.content)).filter(Boolean),
        blocks: pageBlocks,
        folio: String(output.length + 1)
      };
      output.push(page);
      pageBlocks = [];
      pageCost = 0;
    };

    for (const block of section.blocks) {
      const length = blockLength(block.content);
      const cost = blockCost(block.content, columns, budget);
      if (block.content.kind === 'paragraph' && cost > budget) {
        if (pageBlocks.length > 0) pushPage();
        let consumed = 0;
        for (const fragments of splitFragments(block.content.fragments, paragraphCapacity)) {
          const chunkLength = fragmentLength(fragments);
          const chunkContent: ProseBlockData = { kind: 'paragraph', fragments };
          pageOffset = sectionOffset + consumed;
          pageBlocks = [{
            sourceBlockId: block.id,
            sourceStartOffset: consumed,
            sourceEndOffset: consumed + chunkLength,
            content: chunkContent
          }];
          pageCost = blockCost(chunkContent, columns, budget);
          consumed += chunkLength;
          pushPage();
        }
        sectionOffset += length;
        pageOffset = sectionOffset;
        continue;
      }
      if (pageBlocks.length > 0 && pageCost + cost > budget) {
        pushPage();
        pageOffset = sectionOffset;
      }
      if (pageBlocks.length === 0) pageOffset = sectionOffset;
      const imageUrl =
        block.content.kind === 'image' ? imageUrls.get(block.content.imageId) : undefined;
      pageBlocks.push({
        sourceBlockId: block.id,
        sourceStartOffset: 0,
        sourceEndOffset: proseBlockVisibleLength(block.content),
        content: block.content,
        ...(imageUrl ? { imageUrl } : {})
      });
      pageCost += cost;
      sectionOffset += length;
    }
    pushPage();
  }
  return output;
}

function comicPages(document: Extract<ReaderDocument, { format: 'comic' }>): ReaderPage[] {
  return document.pages.map((page, index): ComicReaderPage => ({
    type: 'comic',
    sourcePageId: page.id,
    chapter: 0,
    at: index,
    folio: String(index + 1),
    layout: [{ c: 2, r: 2, cap: `Page ${page.ordinal}` }],
    imageUrl: page.url,
    imageWidth: page.width,
    imageHeight: page.height,
    panels: page.panels
  }));
}

export function paginatePublication(document: ReaderDocument, box: PageBox): ReaderPage[] {
  return document.format === 'prose' ? prosePages(document, box) : comicPages(document);
}
