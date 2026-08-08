import type { EasingFunction } from '$lib/types/reader';

export function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number
): EasingFunction {
  const coefficientA = (start: number, end: number): number => 1 - 3 * end + 3 * start;
  const coefficientB = (start: number, end: number): number => 3 * end - 6 * start;
  const at = (time: number, start: number, end: number): number =>
    ((coefficientA(start, end) * time + coefficientB(start, end)) * time + 3 * start) *
    time;
  const slope = (time: number, start: number, end: number): number =>
    (3 * coefficientA(start, end) * time + 2 * coefficientB(start, end)) * time +
    3 * start;

  return (position: number): number => {
    let time = position;
    for (let pass = 0; pass < 5; pass += 1) {
      const currentSlope = slope(time, x1, x2);
      if (currentSlope === 0) break;
      time -= (at(time, x1, x2) - position) / currentSlope;
    }
    return at(time, y1, y2);
  };
}
