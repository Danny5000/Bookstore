import { COMIC_LAYOUTS } from './data/catalog.js';

/**
 * Page box that fits the available stage, keeping a book-ish 0.73 aspect.
 * `chrome` is everything above and below the stage (header, toolbar, nav row).
 */
export function pageBox({ vw, vh, narrow, fontSize, chrome = 244 }) {
  let ph = Math.max(200, Math.min(620, vh - chrome));
  let pw = Math.round(ph * 0.73);
  const maxW = narrow ? vw - 44 : (vw - 96) / 2;
  if (pw > maxW) {
    pw = Math.max(220, maxW);
    ph = Math.round(pw / 0.73);
  }
  return {
    pw,
    ph,
    pad: Math.max(16, Math.round(pw * 0.105)),
    fs: Math.max(12, Math.min(fontSize, Math.round(pw / 19)))
  };
}

/**
 * Turn a title into pages that fit the measured page box. The character budget
 * is derived from real geometry, so text reflows on resize and type-size change.
 *
 * Memoised: this walks every paragraph of every chapter, and it is called for
 * the reader, the shelf and the detail page on every render — including every
 * frame of a page turn. Repeat calls at the same size are free, and the stable
 * array identity also means repagination effects only fire on a real reflow.
 *
 * @param {import('./data/catalog.js').Title} title
 * @param {{pw:number, ph:number, pad:number, fs:number}} box
 */
const cache = new WeakMap();

export function paginate(title, box) {
  if (!title) return [];
  const key = `${box.pw}:${box.ph}:${box.pad}:${box.fs}:${(title.chapters || []).length}:${title.pages || 0}`;
  let sizes = cache.get(title);
  if (!sizes) {
    sizes = new Map();
    cache.set(title, sizes);
  }
  const hit = sizes.get(key);
  if (hit) return hit;
  // Sizes churn while a window is being dragged; keep only a few.
  if (sizes.size > 8) sizes.clear();
  const out = build(title, box);
  sizes.set(key, out);
  return out;
}

function build(title, box) {
  if (title.kind === 'comic') {
    const n = title.pages || 8;
    const names = title.pageNames || null;
    // Uploaded art with no panel regions yet reads as one whole-page "panel".
    const wholePage = title.panelMode === 'off' || title.panelMode === 'manual';
    return Array.from({ length: n }, (_, i) => {
      let layout = COMIC_LAYOUTS[i % COMIC_LAYOUTS.length];
      if (names) {
        const nm = names[i] || `page ${i + 1}`;
        layout = wholePage
          ? [{ c: 2, r: 2, cap: nm }]
          : layout.map((cell, n2) => ({ c: cell.c, r: cell.r, cap: `${nm} · panel ${n2 + 1}` }));
      }
      return { type: 'comic', chapter: 0, at: i, layout, folio: String(i + 1) };
    });
  }

  // Fixed-page novels (a PDF kept exactly as laid out): one image per page,
  // no reflow, no type controls.
  if (title.fixed) {
    const n = title.pages || 24;
    return Array.from({ length: n }, (_, i) => ({
      type: 'scan',
      chapter: 0,
      at: i,
      folio: String(i + 1),
      label: `${title.sourceFile || 'manuscript.pdf'} · page ${i + 1}`
    }));
  }

  const cols = Math.max(16, Math.floor((box.pw - box.pad * 2 - 6) / (box.fs * 0.505)));
  const rows = Math.max(6, Math.floor((box.ph - box.pad * 2 - 26) / (box.fs * 1.72)));
  const budget = cols * rows;
  const headCost = cols * 3;

  const out = [];
  (title.chapters || []).forEach((ch, ci) => {
    let buf = [];
    let len = 0;
    let first = true;
    // Characters of this chapter consumed before the page being built. It is
    // the one page property that survives reflow, so it is what a reading
    // position is anchored to.
    let at = 0;
    const push = () => {
      out.push({
        type: 'text',
        chapter: ci,
        at,
        heading: first ? ch.title : null,
        paras: buf,
        folio: String(out.length + 1)
      });
      at += buf.reduce((n, p) => n + p.length, 0);
      buf = [];
      len = 0;
      first = false;
    };
    ch.paras.forEach((p) => {
      const cost = p.length + cols * 0.5 + (first && !buf.length ? headCost : 0);
      if (len + cost > budget && buf.length) push();
      buf.push(p);
      len += cost;
    });
    if (buf.length) push();
    // keep spreads even so chapters always open on a right-hand page
    if (out.length % 2 === 1) {
      out.push({ type: 'text', chapter: ci, at, heading: null, paras: [], folio: String(out.length + 1) });
    }
  });

  // Never end the book on a padding blank — it reads as a missing page.
  while (out.length) {
    const last = out[out.length - 1];
    if (last.type === 'text' && !last.heading && !last.paras.length) out.pop();
    else break;
  }

  return out;
}

/**
 * The page holding a reading position after the book has been repaginated.
 * Pages run in chapter then `at` order, so the match is the last page that
 * starts at or before the anchor.
 */
export function pageForAnchor(pages, anchor) {
  if (!anchor) return 0;
  let idx = 0;
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    if (p.chapter < anchor.chapter || (p.chapter === anchor.chapter && (p.at || 0) <= anchor.at)) idx = i;
    else break;
  }
  return idx;
}

/** Last sheet included in the free sample. */
export function freeSheets(title, pages, per) {
  if (!title || title.kind === 'comic') return Math.min(2, Math.ceil(pages.length / per));

  // A fixed-page PDF has no chapter structure to cut on, so the publisher sets
  // the preview length in Studio (default: 10% of the book, min 6 pages).
  if (title.fixed) {
    const n = title.samplePages || Math.max(6, Math.round((title.pages || 24) * 0.1));
    return Math.max(1, Math.min(Math.ceil(pages.length / per), Math.ceil(n / per)));
  }

  let last = 0;
  pages.forEach((p, i) => {
    if (p.chapter === 0) last = i;
  });
  if (per === 1) return last + 1;
  // page index i is fully visible at sheet i/2 (as a front) or (i+1)/2 (as a back)
  return last % 2 === 0 ? last / 2 : (last + 1) / 2;
}

export const PAPERS = {
  white: { label: 'White', bg: '#f7f5f1', ink: '#25211c' },
  sepia: { label: 'Sepia', bg: '#efe2c8', ink: '#3a2f21' },
  dim: { label: 'Dim', bg: '#2a2926', ink: '#cfc9be' }
};

export const TYPEFACES = {
  serif: { label: 'Newsreader', css: "'Newsreader', Georgia, serif" },
  sans: { label: 'Plex Sans', css: "'IBM Plex Sans', system-ui, sans-serif" },
  georgia: { label: 'Georgia', css: "Georgia, 'Times New Roman', serif" }
};
