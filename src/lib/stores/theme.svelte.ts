import { browser } from '$app/environment';

const KEY = 'paleorbit.theme';
export type ThemeId = 'nocturne' | 'vellum';

export const THEMES = [
  { id: 'nocturne', label: 'Nocturne', chip: 'oklch(0.18 0.018 262)' },
  { id: 'vellum', label: 'Vellum', chip: 'oklch(0.955 0.012 88)' }
] as const satisfies readonly { id: ThemeId; label: string; chip: string }[];

function isThemeId(value: string | null): value is ThemeId {
  return value === 'nocturne' || value === 'vellum';
}

class ThemeStore {
  current = $state<ThemeId>('nocturne');

  constructor() {
    if (!browser) return;
    const saved = localStorage.getItem(KEY);
    if (isThemeId(saved)) this.current = saved;
    this.apply();
  }

  set(id: ThemeId): void {
    this.current = id;
    if (!browser) return;
    localStorage.setItem(KEY, id);
    this.apply();
  }

  apply(): void {
    document.documentElement.dataset.theme = this.current;
  }
}

export const theme = new ThemeStore();
