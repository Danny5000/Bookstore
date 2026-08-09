import { describe, expect, it } from 'vitest';
import {
  normalizeBrowserEmail,
  validatePasswordConfirmation,
  validateRegistration
} from './forms';

describe('authentication form validation', () => {
  it('normalizes browser email input', () => {
    expect(normalizeBrowserEmail('  Reader@Example.COM ')).toBe('reader@example.com');
  });

  it('requires a display name and valid matching registration passwords', () => {
    expect(validateRegistration('', 'long-enough-password', 'long-enough-password')).toMatch(
      /name/i
    );
    expect(validateRegistration('Reader', 'short', 'short')).toMatch(/12/);
    expect(validateRegistration('Reader', 'long-enough-password', 'different-password')).toMatch(
      /match/i
    );
    expect(
      validateRegistration(' Reader ', 'long-enough-password', 'long-enough-password')
    ).toBeNull();
  });

  it('validates reset password confirmation without exposing tokens', () => {
    expect(validatePasswordConfirmation('short', 'short')).toMatch(/12/);
    expect(validatePasswordConfirmation('long-enough-password', 'different-password')).toMatch(
      /match/i
    );
    expect(validatePasswordConfirmation('long-enough-password', 'long-enough-password')).toBeNull();
  });
});
