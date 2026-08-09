import { z } from 'zod';

export interface Point {
  x: number;
  y: number;
}

export interface PixelBounds {
  width: number;
  height: number;
}

export interface NormalizedPanelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ResizeHandle = 'nw' | 'ne' | 'se' | 'sw';

const minimumPixels = 2;
const precision = 1_000_000;

function round(value: number): number {
  return Math.round(value * precision) / precision;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function validBounds(bounds: PixelBounds): boolean {
  return Number.isFinite(bounds.width) && Number.isFinite(bounds.height) &&
    bounds.width > 0 && bounds.height > 0;
}

function rounded(box: NormalizedPanelBox): NormalizedPanelBox {
  return {
    x: round(box.x),
    y: round(box.y),
    width: round(box.width),
    height: round(box.height)
  };
}

export function normalizeDragBox(
  start: Point,
  end: Point,
  bounds: PixelBounds
): NormalizedPanelBox | null {
  if (!validBounds(bounds)) return null;
  const startX = clamp(start.x, 0, bounds.width);
  const startY = clamp(start.y, 0, bounds.height);
  const endX = clamp(end.x, 0, bounds.width);
  const endY = clamp(end.y, 0, bounds.height);
  const pixelWidth = Math.abs(endX - startX);
  const pixelHeight = Math.abs(endY - startY);
  if (pixelWidth < minimumPixels || pixelHeight < minimumPixels) return null;
  return rounded({
    x: Math.min(startX, endX) / bounds.width,
    y: Math.min(startY, endY) / bounds.height,
    width: pixelWidth / bounds.width,
    height: pixelHeight / bounds.height
  });
}

export function movePanelBox(
  box: NormalizedPanelBox,
  delta: Point,
  bounds: PixelBounds
): NormalizedPanelBox {
  if (!validBounds(bounds)) return rounded(box);
  return rounded({
    ...box,
    x: clamp(box.x + delta.x / bounds.width, 0, 1 - box.width),
    y: clamp(box.y + delta.y / bounds.height, 0, 1 - box.height)
  });
}

export function resizePanelBox(
  box: NormalizedPanelBox,
  handle: ResizeHandle,
  delta: Point,
  bounds: PixelBounds
): NormalizedPanelBox {
  if (!validBounds(bounds)) return rounded(box);
  const minWidth = Math.min(1, minimumPixels / bounds.width);
  const minHeight = Math.min(1, minimumPixels / bounds.height);
  let left = box.x;
  let top = box.y;
  let right = box.x + box.width;
  let bottom = box.y + box.height;
  const dx = delta.x / bounds.width;
  const dy = delta.y / bounds.height;

  if (handle.includes('w')) left = clamp(left + dx, 0, right - minWidth);
  if (handle.includes('e')) right = clamp(right + dx, left + minWidth, 1);
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - minHeight);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + minHeight, 1);

  return rounded({ x: left, y: top, width: right - left, height: bottom - top });
}

const boxSchema = z
  .strictObject({
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1),
    width: z.number().finite().positive().max(1),
    height: z.number().finite().positive().max(1)
  })
  .refine((box) => box.x + box.width <= 1 && box.y + box.height <= 1, {
    message: 'Panel must fit within the page'
  });

const boxesSchema = z.array(boxSchema).max(100_000);

export function serializePanelBoxes(boxes: readonly NormalizedPanelBox[]): string {
  return JSON.stringify(boxes.map(rounded));
}

export function parsePanelBoxes(value: string): NormalizedPanelBox[] {
  return boxesSchema.parse(JSON.parse(value)).map(rounded);
}
