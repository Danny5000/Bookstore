import type { Title } from '$lib/types/catalog';
import type {
  ComicReaderPage,
  PageBox,
  PageBoxInput,
  PanelCell,
  PaperId,
  ReaderPage,
  ReadingAnchor,
  ScanReaderPage,
  TypefaceId
} from '$lib/types/reader';
import { COMIC_LAYOUTS } from './data/catalog';

export function pageBox({
  vw,
  vh,
  narrow,
  fontSize,
  chrome = 244
}: PageBoxInput): PageBox {
  let ph = Math.max(200, Math.min(620, vh - chrome));
  let pw = Math.round(ph * 0.73);
  const maxWidth = narrow ? vw - 44 : (vw - 96) / 2;
  if (pw > maxWidth) {
    pw = Math.max(220, maxWidth);
    ph = Math.round(pw / 0.73);
  }
  return {
    pw,
    ph,
    pad: Math.max(16, Math.round(pw * 0.105)),
    fs: Math.max(12, Math.min(fontSize, Math.round(pw / 19)))
  };
}

const cache = new WeakMap<Title, Map<string, ReaderPage[]>>();

export function paginate(title: Title | undefined, box: PageBox): ReaderPage[] {
  if (!title) return [];
  const key = `${box.pw}:${box.ph}:${box.pad}:${box.fs}:${title.chapters?.length ?? 0}:${title.pages ?? 0}`;
  let sizes = cache.get(title);
  if (!sizes) {
    sizes = new Map<string, ReaderPage[]>();
    cache.set(title, sizes);
  }
  const cached = sizes.get(key);
  if (cached) return cached;
  if (sizes.size > 8) sizes.clear();
  const pages = build(title, box);
  sizes.set(key, pages);
  return pages;
}

function build(title: Title, box: PageBox): ReaderPage[] {
  if (title.kind === 'comic') {
    const count = title.pages || 8;
    const names = title.pageNames ?? null;
    const wholePage = title.panelMode === 'off' || title.panelMode === 'manual';
    return Array.from({ length: count }, (_, index): ComicReaderPage => {
      const seedLayout = COMIC_LAYOUTS[index % COMIC_LAYOUTS.length] ?? COMIC_LAYOUTS[0];
      let layout: PanelCell[] = seedLayout.map((cell) => ({ ...cell }));
      if (names) {
        const name = names[index] ?? `page ${index + 1}`;
        layout = wholePage
          ? [{ c: 2, r: 2, cap: name }]
          : layout.map((cell, panelIndex) => ({
              c: cell.c,
              r: cell.r,
              cap: `${name} · panel ${panelIndex + 1}`
            }));
      }
      return {
        type: 'comic',
        chapter: 0,
        at: index,
        layout,
        folio: String(index + 1)
      };
    });
  }

  if (title.fixed) {
    const count = title.pages || 24;
    return Array.from({ length: count }, (_, index): ScanReaderPage => ({
      type: 'scan',
      chapter: 0,
      at: index,
      folio: String(index + 1),
      label: `${title.sourceFile ?? 'manuscript.pdf'} · page ${index + 1}`
    }));
  }

  const columns = Math.max(16, Math.floor((box.pw - box.pad * 2 - 6) / (box.fs * 0.505)));
  const rows = Math.max(6, Math.floor((box.ph - box.pad * 2 - 26) / (box.fs * 1.72)));
  const budget = columns * rows;
  const headingCost = columns * 3;
  const output: ReaderPage[] = [];

  (title.chapters ?? []).forEach((chapter, chapterIndex) => {
    let buffer: string[] = [];
    let length = 0;
    let first = true;
    let at = 0;
    const push = (): void => {
      output.push({
        type: 'text',
        chapter: chapterIndex,
        at,
        heading: first ? chapter.title : null,
        paras: buffer,
        folio: String(output.length + 1)
      });
      at += buffer.reduce((total, paragraph) => total + paragraph.length, 0);
      buffer = [];
      length = 0;
      first = false;
    };

    chapter.paras.forEach((paragraph) => {
      const cost =
        paragraph.length +
        columns * 0.5 +
        (first && buffer.length === 0 ? headingCost : 0);
      if (length + cost > budget && buffer.length > 0) push();
      buffer.push(paragraph);
      length += cost;
    });
    if (buffer.length > 0) push();
    if (output.length % 2 === 1) {
      output.push({
        type: 'text',
        chapter: chapterIndex,
        at,
        heading: null,
        paras: [],
        folio: String(output.length + 1)
      });
    }
  });

  while (output.length > 0) {
    const last = output[output.length - 1];
    if (last?.type === 'text' && !last.heading && last.paras.length === 0) output.pop();
    else break;
  }
  return output;
}

export function pageForAnchor(
  pages: readonly ReaderPage[],
  anchor: ReadingAnchor | null
): number {
  if (!anchor) return 0;
  let index = 0;
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex];
    if (!page) continue;
    if (
      page.chapter < anchor.chapter ||
      (page.chapter === anchor.chapter && page.at <= anchor.at)
    ) {
      index = pageIndex;
    } else {
      break;
    }
  }
  return index;
}

export function freeSheets(
  title: Title | undefined,
  pages: readonly ReaderPage[],
  per: number
): number {
  if (!title || title.kind === 'comic') {
    return Math.min(2, Math.ceil(pages.length / per));
  }
  if (title.fixed) {
    const previewPages =
      title.samplePages ?? Math.max(6, Math.round((title.pages ?? 24) * 0.1));
    return Math.max(
      1,
      Math.min(Math.ceil(pages.length / per), Math.ceil(previewPages / per))
    );
  }

  let last = 0;
  pages.forEach((page, index) => {
    if (page.chapter === 0) last = index;
  });
  if (per === 1) return last + 1;
  return last % 2 === 0 ? last / 2 : (last + 1) / 2;
}

interface PaperTheme {
  label: string;
  bg: string;
  ink: string;
}

interface Typeface {
  label: string;
  css: string;
}

export const PAPERS: Record<PaperId, PaperTheme> = {
  white: { label: 'White', bg: '#f7f5f1', ink: '#25211c' },
  sepia: { label: 'Sepia', bg: '#efe2c8', ink: '#3a2f21' },
  dim: { label: 'Dim', bg: '#2a2926', ink: '#cfc9be' }
};

export const TYPEFACES: Record<TypefaceId, Typeface> = {
  serif: { label: 'Newsreader', css: "'Newsreader', Georgia, serif" },
  sans: { label: 'Plex Sans', css: "'IBM Plex Sans', system-ui, sans-serif" },
  georgia: { label: 'Georgia', css: "Georgia, 'Times New Roman', serif" }
};
