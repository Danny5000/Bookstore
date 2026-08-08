import { describe, expect, it } from 'vitest';
import { isRecord, parseStoredJson, readNumberRecord, readStringArray } from './persistence';

describe('persistence decoders', () => {
  it('returns undefined instead of leaking malformed JSON', () => {
    expect(parseStoredJson('{broken')).toBeUndefined();
  });

  it('narrows records and arrays without trusting JSON.parse', () => {
    expect(isRecord({ id: 'salt' })).toBe(true);
    expect(readStringArray(['salt', 1])).toEqual([]);
    expect(readNumberRecord({ salt: 2, bad: '2' })).toEqual({});
  });
});
