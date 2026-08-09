export type ByteRange = { start: number; endInclusive: number } | null;

export class RangeNotSatisfiableError extends Error {
  readonly status = 416;

  constructor(readonly size: number) {
    super('Requested byte range is not satisfiable');
    this.name = 'RangeNotSatisfiableError';
  }
}

function invalid(size: number): never {
  throw new RangeNotSatisfiableError(size);
}

export function parseSingleRange(header: string | null, size: number): ByteRange {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('Object size is invalid');
  if (header === null) return null;
  if (size === 0 || !header.startsWith('bytes=') || header.includes(',')) invalid(size);
  const specification = header.slice('bytes='.length);
  const match = /^(\d*)-(\d*)$/u.exec(specification);
  if (!match || (!match[1] && !match[2])) invalid(size);

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) invalid(size);
    return {
      start: Math.max(0, size - suffixLength),
      endInclusive: size - 1
    };
  }

  const start = Number(match[1]);
  if (!Number.isSafeInteger(start) || start >= size) invalid(size);
  if (!match[2]) return { start, endInclusive: size - 1 };
  const requestedEnd = Number(match[2]);
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) invalid(size);
  return { start, endInclusive: Math.min(requestedEnd, size - 1) };
}
