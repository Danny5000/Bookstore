import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendBookEmail } from './mail';

describe('prototype book delivery seam', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not log customer or title data while delivery remains unimplemented', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await sendBookEmail({
      email: 'private-reader@example.com',
      titleId: 'private-title'
    });

    expect(log).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith('[mail] book delivery is not implemented');
  });
});
