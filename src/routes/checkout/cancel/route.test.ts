import { describe, expect, it } from 'vitest';
import { GET } from './+server';

describe('GET /checkout/cancel', () => {
  it('redirects 303 to the intact cart cancellation state', async () => {
    await expect(GET({} as never)).rejects.toMatchObject({
      status: 303,
      location: '/cart?canceled=1'
    });
  });
});
