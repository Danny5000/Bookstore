import { chapters } from './prose.js';

/**
 * Seed catalog. In production this comes from your DB (README -> Data model);
 * the shape below is what every component expects.
 *
 * @typedef {Object} Title
 * @property {string} id
 * @property {'novel'|'comic'} kind
 * @property {string} title
 * @property {string} author
 * @property {number} price
 * @property {string} released
 * @property {number} cover        index into SWATCHES (placeholder art)
 * @property {string|null} [coverUrl] uploaded cover image; falls back to SWATCHES
 * @property {string} summary
 * @property {{title: string, paras: string[]}[]} [chapters]
 * @property {number} [pages]      comics only
 */

/** Placeholder cover palettes: [accent, ground] */
export const SWATCHES = [
  ['oklch(0.72 0.14 200)', 'oklch(0.28 0.06 260)'],
  ['oklch(0.78 0.15 60)', 'oklch(0.30 0.05 30)'],
  ['oklch(0.70 0.16 340)', 'oklch(0.26 0.05 300)'],
  ['oklch(0.80 0.13 130)', 'oklch(0.27 0.05 160)'],
  ['oklch(0.86 0.05 90)', 'oklch(0.24 0.02 260)']
];

/**
 * The `background` shorthand for a cover: uploaded artwork when there is one,
 * otherwise the placeholder palette. One definition, so the shelf, the reader's
 * boards and every catalogue card draw the same cover.
 */
export function coverBackground(index = 0, url = null) {
  if (url) return `center / cover url(${url})`;
  const [accent, ground] = SWATCHES[index % SWATCHES.length];
  return `linear-gradient(150deg, ${ground} 0%, ${ground} 46%, ${accent} 47%, ${accent} 53%, ${ground} 54%)`;
}

/** Comic page layouts: c = column span, r = row span, cap = art-direction note */
export const COMIC_LAYOUTS = [
  [
    { c: 2, r: 1, cap: 'PANEL - establishing shot, the salt flats at dawn' },
    { c: 1, r: 1, cap: 'PANEL - Ceren, close' },
    { c: 1, r: 1, cap: 'PANEL - the rake in the water' }
  ],
  [
    { c: 1, r: 2, cap: 'PANEL - vertical: the tower' },
    { c: 1, r: 1, cap: 'PANEL - hands' },
    { c: 1, r: 1, cap: 'PANEL - the ring, breaking' }
  ],
  [{ c: 2, r: 2, cap: 'SPLASH - the freighter descending through cloud' }],
  [
    { c: 1, r: 1, cap: 'PANEL - corridor' },
    { c: 1, r: 1, cap: 'PANEL - the inquiry room' },
    { c: 2, r: 1, cap: 'PANEL - wide: everyone leaving at once' }
  ]
];

/** @type {Title[]} */
export const CATALOG = [
  {
    id: 'salt',
    kind: 'novel',
    title: 'The Salt Harvest',
    author: 'R. Vale Okonjo',
    price: 9.99,
    released: 'Mar 2026',
    cover: 0,
    summary:
      'Three seasons on a company world, one failing orbital ring, and the arithmetic of getting out.',
    chapters: chapters(0, [
      'One - Low Water',
      'Two - The Rake',
      'Three - Company Time',
      'Four - The Ring',
      'Five - Inquiry'
    ])
  },
  {
    id: 'ninety',
    kind: 'novel',
    title: 'Ninety Days of Vacuum',
    author: 'R. Vale Okonjo',
    price: 12.99,
    released: 'Nov 2025',
    cover: 1,
    summary: 'A salvage crew signs a contract nobody reads. The vacuum reads it for them.',
    chapters: chapters(3, ['One - Signing', 'Two - Drift', 'Three - Quiet Hours', 'Four - Return'])
  },
  {
    id: 'quiet',
    kind: 'novel',
    title: 'Quiet Machines',
    author: 'R. Vale Okonjo',
    price: 7.99,
    released: 'Jun 2025',
    cover: 4,
    summary:
      'Essays on growing up around engines, and what my father meant when he said a thing was running right.',
    chapters: chapters(5, ['The Garage', 'Running Right', 'My Mothers Radio', 'Afterward'])
  },
  {
    id: 'under',
    kind: 'novel',
    title: 'Understory',
    author: 'R. Vale Okonjo',
    price: 11.99,
    released: 'Jan 2026',
    cover: 3,
    summary: 'Terraforming is slow. Grief is slower. A botanist stays behind on a world that is not finished.',
    chapters: chapters(2, ['One - Seedbank', 'Two - Canopy', 'Three - Rot', 'Four - Understory'])
  },
  {
    id: 'vector',
    kind: 'comic',
    title: 'Vector & Vine',
    author: 'Okonjo - art by A. Reyes',
    price: 4.99,
    released: 'Apr 2026',
    cover: 2,
    pages: 8,
    summary: 'Issue #1. Two couriers, one cargo that is technically alive.'
  },
  {
    id: 'deep',
    kind: 'comic',
    title: 'Deep Field',
    author: 'Okonjo - art by A. Reyes',
    price: 5.99,
    released: 'Feb 2026',
    cover: 0,
    pages: 8,
    summary: 'Issue #1. What the long-exposure survey found looking away from everything.'
  }
];

export const money = (n) => '$' + Number(n).toFixed(2);

export const byId = (id) => CATALOG.find((t) => t.id === id);
