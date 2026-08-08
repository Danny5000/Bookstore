import type { ReaderPage, SheetView, TurnProgress } from '$lib/types/reader';

const WINDOW_RADIUS = 2;

export interface SheetWindowInput {
  pages: readonly ReaderPage[];
  per: number;
  currentSheet: number;
  totalSheets: number;
  maxReadableSheet: number;
  turn: TurnProgress | null;
}

export function visibleSheetIndices(
  currentSheet: number,
  totalSheets: number,
  maxReadableSheet: number,
  radius = WINDOW_RADIUS
): number[] {
  const lastSheet = Math.min(totalSheets - 1, maxReadableSheet);
  if (lastSheet < 0) return [];

  const start = Math.max(0, currentSheet - radius);
  const end = Math.min(lastSheet, currentSheet + radius);
  if (start > end) return [];

  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset);
}

export function buildSheetWindow({
  pages,
  per,
  currentSheet,
  totalSheets,
  maxReadableSheet,
  turn
}: SheetWindowInput): SheetView[] {
  const settled = turn === null;

  return visibleSheetIndices(currentSheet, totalSheets, maxReadableSheet).map((index) => {
    const isFlipped = index < currentSheet;
    let angle = isFlipped ? -180 : 0;
    if (turn?.dir === 1 && index === currentSheet) angle = -180 * turn.t;
    if (turn?.dir === -1 && index === currentSheet - 1) {
      angle = -180 * (1 - turn.t);
    }
    const active = turn !== null && (index === currentSheet || index === currentSheet - 1);
    const curl = Math.sin((Math.abs(angle) / 180) * Math.PI);

    return {
      k: index,
      angle,
      curl,
      active,
      z: active
        ? totalSheets + 3
        : isFlipped
          ? index + 1
          : totalSheets - index + 1,
      showFront: settled ? angle > -90 : true,
      showBack: settled ? angle <= -90 : true,
      front: pages[index * per] ?? null,
      back: per === 2 ? (pages[index * per + 1] ?? null) : null
    };
  });
}
