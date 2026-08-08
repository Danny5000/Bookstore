export function computeRetryDelayMs(
  attempts: number,
  baseDelayMs: number,
  maximumDelayMs: number
): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 30);
  return Math.min(maximumDelayMs, baseDelayMs * 2 ** exponent);
}
