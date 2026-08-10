export const COVER_SWATCHES = [
  ['oklch(0.72 0.14 200)', 'oklch(0.28 0.06 260)'],
  ['oklch(0.78 0.15 60)', 'oklch(0.30 0.05 30)'],
  ['oklch(0.70 0.16 340)', 'oklch(0.26 0.05 300)'],
  ['oklch(0.80 0.13 130)', 'oklch(0.27 0.05 160)'],
  ['oklch(0.86 0.05 90)', 'oklch(0.24 0.02 260)']
] as const satisfies readonly (readonly [string, string])[];

function seedIndex(seed: string | number): number {
  if (typeof seed === 'number') return Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) : 0;
  let hash = 2_166_136_261;
  for (const character of seed) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export function coverPalette(seed: string | number = 0): (typeof COVER_SWATCHES)[number] {
  return COVER_SWATCHES[seedIndex(seed) % COVER_SWATCHES.length] ?? COVER_SWATCHES[0];
}

export function coverBackground(
  seed: string | number = 0,
  url: string | null | undefined = null
): string {
  if (url) return `center / cover url(${url})`;
  const [accent, ground] = coverPalette(seed);
  return `linear-gradient(150deg, ${ground} 0%, ${ground} 46%, ${accent} 47%, ${accent} 53%, ${ground} 54%)`;
}
