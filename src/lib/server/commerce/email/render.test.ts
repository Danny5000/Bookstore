import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseCommerceEmailPayload } from './payload';
import { renderCommerceEmail } from './render';

const origin = 'https://books.example.com';

function receipt(template: 'commerce.account-receipt' | 'commerce.guest-receipt-claim') {
  return parseCommerceEmailPayload({
    version: 1,
    template,
    to: 'reader@example.com',
    messageId: randomUUID(),
    orderNumber: randomUUID(),
    orderDate: '2026-08-10T12:05:00.000Z',
    currency: 'USD',
    subtotalMinor: 1299,
    taxMinor: 104,
    totalMinor: 1403,
    items: [{
      title: '<script>alert("book")</script>',
      creatorName: 'A & B',
      format: 'prose'
    }],
    ...(template === 'commerce.guest-receipt-claim'
      ? {
          claimUrl: `${origin}/api/auth/magic-link/verify?token=safe&callbackURL=%2Fclaim%2Fcomplete`
        }
      : {})
  }, origin);
}

describe('commerce email rendering', () => {
  it('renders escaped receipt HTML and explicit direct-download guidance', () => {
    const rendered = renderCommerceEmail(receipt('commerce.account-receipt'));
    expect(rendered.subject).toBe('Your Pale Orbit purchase');
    expect(rendered.text).toContain('available for direct download from your library');
    expect(rendered.text).toContain('$14.03');
    expect(rendered.html).toContain('&lt;script&gt;alert(&quot;book&quot;)&lt;/script&gt;');
    expect(rendered.html).toContain('A &amp; B');
    expect(rendered.html).not.toContain('<script>');
    expect(Object.keys(rendered).sort()).toEqual(['html', 'subject', 'text']);
  });

  it('renders the claim action only for a guest receipt', () => {
    const account = renderCommerceEmail(receipt('commerce.account-receipt'));
    const guest = renderCommerceEmail(receipt('commerce.guest-receipt-claim'));
    expect(account.text).not.toContain('/api/auth/magic-link/verify');
    expect(guest.text).toContain('/api/auth/magic-link/verify');
    expect(guest.html).toContain('Claim your purchase');
  });

  it('renders minimized access-change guidance without payment evidence', () => {
    const payload = parseCommerceEmailPayload({
      version: 1,
      template: 'commerce.dispute-access-changed',
      to: 'reader@example.com',
      messageId: randomUUID(),
      reasonCategory: 'dispute_opened',
      affectedTitleCount: 2,
      libraryUrl: `${origin}/library`,
      helpUrl: `${origin}/help`
    }, origin);
    const rendered = renderCommerceEmail(payload);
    expect(rendered.subject).toContain('library access changed');
    expect(rendered.text).toContain('2 titles');
    expect(rendered.text).toContain(`${origin}/library`);
    expect(rendered.text).toContain(`${origin}/help`);
    expect(JSON.stringify(rendered)).not.toMatch(/pi_|ch_|card|billing|stripe|refund amount/iu);
  });
});
