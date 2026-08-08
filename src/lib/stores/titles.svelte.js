import { browser } from '$app/environment';
import { CATALOG } from '$lib/data/catalog.js';

const KEY = 'paleorbit.titles';
const HIDDEN_KEY = 'paleorbit.titles.hidden';

/**
 * Catalog store. Seeded from src/lib/data/catalog.js and extended by anything
 * published in Studio. Replace with load() data from your DB when you wire one
 * up — every component reads `titles.all` and `titles.get(id)`.
 *
 * Seeded titles can't be deleted from a static file, so removing one records
 * its id in `hidden` instead. With a real DB, both cases are one DELETE.
 */
class TitleStore {
  added = $state([]);
  hidden = $state([]);

  constructor() {
    if (!browser) return;
    try {
      this.added = JSON.parse(localStorage.getItem(KEY) || '[]');
      this.hidden = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]');
    } catch (e) {
      this.added = [];
      this.hidden = [];
    }
  }

  get all() {
    return [...this.added, ...CATALOG].filter((t) => !this.hidden.includes(t.id));
  }

  get(id) {
    return this.all.find((t) => t.id === id);
  }

  publish(title) {
    this.added = [title, ...this.added];
    this.#persist();
  }

  remove(id) {
    if (this.added.some((t) => t.id === id)) {
      this.added = this.added.filter((t) => t.id !== id);
    } else {
      this.hidden = [...this.hidden, id];
    }
    this.#persist();
  }

  restoreAll() {
    this.hidden = [];
    this.#persist();
  }

  #persist() {
    if (!browser) return;
    localStorage.setItem(KEY, JSON.stringify(this.added));
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(this.hidden));
  }
}

export const titles = new TitleStore();

/** Parse a pasted manuscript into chapters. "## Title" starts a chapter. */
export function parseManuscript(text) {
  const chapters = [];
  (text || '').split(/\n(?=##\s)/).forEach((block) => {
    const lines = block.split('\n').filter((l) => l.trim());
    if (!lines.length) return;
    let title = 'Chapter ' + (chapters.length + 1);
    let body = lines;
    if (/^##\s/.test(lines[0])) {
      title = lines[0].replace(/^##\s*/, '');
      body = lines.slice(1);
    }
    chapters.push({ title, paras: body });
  });
  return chapters;
}
