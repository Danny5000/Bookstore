export function clampSheet(index: number, totalSheets: number, limit = totalSheets): number {
  const upper = Math.max(0, Math.min(totalSheets, limit));
  return Math.max(0, Math.min(upper, index));
}
