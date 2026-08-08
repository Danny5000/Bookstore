import type { ReadingAnchor } from '$lib/types/reader';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseStoredJson(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function readStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];
}

export function readNumberRecord(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.values(value).every((item) => typeof item === 'number')
    ? (value as Record<string, number>)
    : {};
}

export function readNumberArrayRecord(value: unknown): Record<string, number[]> {
  if (!isRecord(value)) return {};
  const entries = Object.entries(value);
  if (
    !entries.every(
      ([, item]) => Array.isArray(item) && item.every((part) => typeof part === 'number')
    )
  ) {
    return {};
  }
  return Object.fromEntries(entries) as Record<string, number[]>;
}

export function readAnchorRecord(value: unknown): Record<string, ReadingAnchor> {
  if (!isRecord(value)) return {};
  const entries = Object.entries(value);
  if (
    !entries.every(
      ([, item]) =>
        isRecord(item) && typeof item.chapter === 'number' && typeof item.at === 'number'
    )
  ) {
    return {};
  }
  return Object.fromEntries(entries) as Record<string, ReadingAnchor>;
}
