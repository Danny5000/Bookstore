import { browser } from '$app/environment';
import { CATALOG } from '$lib/data/catalog';
import type { Title } from '$lib/types/catalog';
import { isRecord, parseStoredJson, readStringArray } from '$lib/utils/persistence';

const KEY = 'paleorbit.titles';
const HIDDEN_KEY = 'paleorbit.titles.hidden';

function isTitle(value: unknown): value is Title {
  if (!isRecord(value)) return false;
  const optionalString = (candidate: unknown): boolean =>
    candidate === undefined || candidate === null || typeof candidate === 'string';
  const optionalNumber = (candidate: unknown): boolean =>
    candidate === undefined || typeof candidate === 'number';
  const baseIsValid =
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.author === 'string' &&
    typeof value.price === 'number' &&
    typeof value.released === 'string' &&
    typeof value.cover === 'number' &&
    typeof value.summary === 'string' &&
    optionalString(value.coverUrl);
  if (!baseIsValid) return false;
  if (value.kind === 'comic') {
    return (
      typeof value.pages === 'number' &&
      (value.pageNames === undefined ||
        (Array.isArray(value.pageNames) &&
          value.pageNames.every((name) => typeof name === 'string'))) &&
      (value.direction === undefined || value.direction === 'ltr' || value.direction === 'rtl') &&
      (value.panelMode === undefined ||
        value.panelMode === 'auto' ||
        value.panelMode === 'manual' ||
        value.panelMode === 'off')
    );
  }
  if (value.kind !== 'novel') return false;
  return (
    (value.chapters === undefined ||
      (Array.isArray(value.chapters) &&
        value.chapters.every(
          (chapter) =>
            isRecord(chapter) &&
            typeof chapter.title === 'string' &&
            Array.isArray(chapter.paras) &&
            chapter.paras.every((paragraph) => typeof paragraph === 'string')
        ))) &&
    (value.fixed === undefined || typeof value.fixed === 'boolean') &&
    optionalNumber(value.pages) &&
    optionalString(value.sourceFile) &&
    optionalNumber(value.samplePages)
  );
}

class TitleStore {
  added = $state<Title[]>([]);
  hidden = $state<string[]>([]);

  constructor() {
    if (!browser) return;
    const added = parseStoredJson(localStorage.getItem(KEY));
    this.added = Array.isArray(added) ? added.filter(isTitle) : [];
    this.hidden = readStringArray(parseStoredJson(localStorage.getItem(HIDDEN_KEY)));
  }

  get all(): Title[] {
    return [...this.added, ...CATALOG].filter((title) => !this.hidden.includes(title.id));
  }

  get(id: string): Title | undefined {
    return this.all.find((title) => title.id === id);
  }

  publish(title: Title): void {
    this.added = [title, ...this.added];
    this.#persist();
  }

  remove(id: string): void {
    if (this.added.some((title) => title.id === id)) {
      this.added = this.added.filter((title) => title.id !== id);
    } else if (!this.hidden.includes(id)) {
      this.hidden = [...this.hidden, id];
    }
    this.#persist();
  }

  restoreAll(): void {
    this.hidden = [];
    this.#persist();
  }

  #persist(): void {
    if (!browser) return;
    localStorage.setItem(KEY, JSON.stringify(this.added));
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(this.hidden));
  }
}

export const titles = new TitleStore();
