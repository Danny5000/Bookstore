import { describe, expect, it } from 'vitest';
import { normalizeEmailAddress } from './identity';

describe('normalizeEmailAddress', () => {
  it('trims and lowercases a valid address', () => {
    expect(normalizeEmailAddress('  Reader@Example.COM ')).toBe('reader@example.com');
  });

  it.each(['not-an-email', '', 'reader@'])('rejects invalid address %j', (value) => {
    expect(() => normalizeEmailAddress(value)).toThrow('Invalid email address');
  });
});
