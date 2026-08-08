import { describe, expect, it } from 'vitest';
import type { JsonValue } from '$lib/server/db/schema';
import { redactAuditDetails } from './redact';

describe('redactAuditDetails', () => {
  it('redacts nested sensitive keys while retaining safe context', () => {
    expect(
      redactAuditDetails({
        title: 'A Safe Title',
        credentials: {
          password: 'never-store-this',
          resetToken: 'never-store-this-either'
        },
        changes: [{ field: 'visibility', value: 'private' }]
      })
    ).toEqual({
      title: 'A Safe Title',
      credentials: '[redacted]',
      changes: [{ field: 'visibility', value: 'private' }]
    });
  });

  it('bounds deeply nested data', () => {
    const value: JsonValue = {};
    let cursor = value as { [key: string]: JsonValue };
    for (let index = 0; index < 12; index += 1) {
      const nested: { [key: string]: JsonValue } = {};
      cursor.nested = nested;
      cursor = nested;
    }
    expect(JSON.stringify(redactAuditDetails(value))).toContain('[truncated]');
  });
});
