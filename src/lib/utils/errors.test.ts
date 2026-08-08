import { describe, expect, it } from 'vitest';
import { messageFromUnknown } from './errors';

describe('messageFromUnknown', () => {
  it('uses Error messages and hides non-Error values', () => {
    expect(messageFromUnknown(new Error('offline'))).toBe('offline');
    expect(messageFromUnknown('secret value')).toBe('Unexpected error');
  });
});
