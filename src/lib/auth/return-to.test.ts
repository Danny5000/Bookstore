import { describe, expect, it } from 'vitest';
import { allowedAuthReturnTo } from './return-to';

describe('auth return path allowlist', () => {
  it('allows only the claim completion continuation', () => {
    expect(allowedAuthReturnTo('/claim/complete')).toBe('/claim/complete');
    expect(allowedAuthReturnTo('/library')).toBeNull();
    expect(allowedAuthReturnTo('https://attacker.example/claim/complete')).toBeNull();
    expect(allowedAuthReturnTo('//attacker.example')).toBeNull();
    expect(allowedAuthReturnTo(null)).toBeNull();
  });
});
