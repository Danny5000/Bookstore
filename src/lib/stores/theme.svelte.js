import { browser } from '$app/environment';

const KEY = 'paleorbit.theme';

export const THEMES = [
  { id: 'nocturne', label: 'Nocturne', chip: 'oklch(0.18 0.018 262)' },
  { id: 'vellum', label: 'Vellum', chip: 'oklch(0.955 0.012 88)' }
];

class ThemeStore {
  current = $state('nocturne');

  constructor() {
    if (!browser) return;
    this.current = localStorage.getItem(KEY) || 'nocturne';
    this.apply();
  }

  set(id) {
    this.current = id;
    if (!browser) return;
    localStorage.setItem(KEY, id);
    this.apply();
  }

  apply() {
    document.documentElement.dataset.theme = this.current;
  }
}

export const theme = new ThemeStore();
