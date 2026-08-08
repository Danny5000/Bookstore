import type { JsonValue } from '$lib/server/db/schema';

const SENSITIVE_KEY = /password|secret|token|authorization|cookie|credential/i;
const MAX_DEPTH = 8;

export function redactAuditDetails(value: JsonValue, depth = 0): JsonValue {
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((entry) => redactAuditDetails(entry, depth + 1));
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[redacted]' : redactAuditDetails(entry, depth + 1)
    ])
  );
}
