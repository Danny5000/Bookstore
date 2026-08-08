import type { TitleKind } from '$lib/types/catalog';

export function bookDepth(kind: TitleKind, pageCount: number): number {
  const pages = Math.max(0, pageCount);
  return kind === 'comic'
    ? Math.max(5, Math.min(11, Math.round(pages * 0.5)))
    : Math.max(16, Math.min(58, Math.round(pages * 0.9) + 10));
}
