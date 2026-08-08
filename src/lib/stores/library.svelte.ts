import { browser } from '$app/environment';
import type {
  PaperId,
  ReaderPreferences,
  ReadingAnchor,
  TypefaceId
} from '$lib/types/reader';
import {
  isRecord,
  parseStoredJson,
  readAnchorRecord,
  readNumberArrayRecord,
  readNumberRecord,
  readStringArray
} from '$lib/utils/persistence';

const KEY = 'paleorbit.library';

function isPaper(value: unknown): value is PaperId {
  return value === 'white' || value === 'sepia' || value === 'dim';
}

function isTypeface(value: unknown): value is TypefaceId {
  return value === 'serif' || value === 'sans' || value === 'georgia';
}

class LibraryStore {
  owned = $state<string[]>([]);
  progress = $state<Record<string, number>>({});
  anchors = $state<Record<string, ReadingAnchor>>({});
  bookmarks = $state<Record<string, number[]>>({});
  prefs = $state<ReaderPreferences>({
    fontSize: 18,
    typeface: 'serif',
    paper: 'white'
  });

  constructor() {
    if (!browser) return;
    const value = parseStoredJson(localStorage.getItem(KEY));
    if (!isRecord(value)) return;
    this.owned = readStringArray(value.owned);
    this.progress = readNumberRecord(value.progress);
    this.anchors = readAnchorRecord(value.anchors);
    this.bookmarks = readNumberArrayRecord(value.bookmarks);
    if (isRecord(value.prefs)) {
      this.prefs = {
        fontSize:
          typeof value.prefs.fontSize === 'number'
            ? value.prefs.fontSize
            : this.prefs.fontSize,
        typeface: isTypeface(value.prefs.typeface)
          ? value.prefs.typeface
          : this.prefs.typeface,
        paper: isPaper(value.prefs.paper) ? value.prefs.paper : this.prefs.paper
      };
    }
  }

  save(): void {
    if (!browser) return;
    localStorage.setItem(
      KEY,
      JSON.stringify({
        owned: this.owned,
        progress: this.progress,
        anchors: this.anchors,
        bookmarks: this.bookmarks,
        prefs: this.prefs
      })
    );
  }

  owns(id: string): boolean {
    return this.owned.includes(id);
  }

  grant(id: string): void {
    if (!this.owns(id)) this.owned = [...this.owned, id];
    this.save();
  }

  setProgress(id: string, sheet: number, anchor: ReadingAnchor | null): void {
    this.progress = { ...this.progress, [id]: sheet };
    if (anchor) this.anchors = { ...this.anchors, [id]: anchor };
    this.save();
  }

  anchorFor(id: string): ReadingAnchor | null {
    return this.anchors[id] ?? null;
  }

  bookmarksFor(id: string): number[] {
    return this.bookmarks[id] ?? [];
  }

  toggleBookmark(id: string, sheet: number): void {
    const list = this.bookmarksFor(id);
    const next = list.includes(sheet)
      ? list.filter((value) => value !== sheet)
      : [...list, sheet].sort((left, right) => left - right);
    this.bookmarks = { ...this.bookmarks, [id]: next };
    this.save();
  }

  setPref<Key extends keyof ReaderPreferences>(
    key: Key,
    value: ReaderPreferences[Key]
  ): void {
    this.prefs = { ...this.prefs, [key]: value };
    this.save();
  }
}

export const library = new LibraryStore();
