import { browser } from '$app/environment';

const KEY = 'paleorbit.library';

/**
 * Client mirror of the reader's shelf: entitlements, reading position,
 * bookmarks and reader preferences.
 *
 * In production `owned` is authoritative on the server (purchases table) and
 * hydrated in +layout.server.js; progress and bookmarks can sync to the account
 * so they follow the reader across devices.
 */
class LibraryStore {
  owned = $state([]);
  progress = $state({});
  // Where the reader is in the TEXT ({ chapter, at }), which survives reflow.
  // `progress` is only the page that position landed on at the last size.
  anchors = $state({});
  bookmarks = $state({});
  prefs = $state({ fontSize: 18, typeface: 'serif', paper: 'white' });

  constructor() {
    if (!browser) return;
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
      this.owned = raw.owned || [];
      this.progress = raw.progress || {};
      this.anchors = raw.anchors || {};
      this.bookmarks = raw.bookmarks || {};
      this.prefs = { ...this.prefs, ...(raw.prefs || {}) };
    } catch (e) {
      // first run
    }
  }

  save() {
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

  owns(id) {
    return this.owned.includes(id);
  }

  grant(id) {
    if (!this.owns(id)) this.owned = [...this.owned, id];
    this.save();
  }

  setProgress(id, sheet, anchor) {
    this.progress = { ...this.progress, [id]: sheet };
    if (anchor) this.anchors = { ...this.anchors, [id]: anchor };
    this.save();
  }

  anchorFor(id) {
    return this.anchors[id] || null;
  }

  bookmarksFor(id) {
    return this.bookmarks[id] || [];
  }

  toggleBookmark(id, sheet) {
    const list = this.bookmarksFor(id);
    const next = list.includes(sheet)
      ? list.filter((n) => n !== sheet)
      : [...list, sheet].sort((a, b) => a - b);
    this.bookmarks = { ...this.bookmarks, [id]: next };
    this.save();
  }

  setPref(key, value) {
    this.prefs = { ...this.prefs, [key]: value };
    this.save();
  }
}

export const library = new LibraryStore();
