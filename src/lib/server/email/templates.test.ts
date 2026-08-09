import { describe, expect, it } from 'vitest';
import type { AuthEmailPayload } from './payload';
import { renderAuthEmail } from './templates';

const basePayload: Omit<AuthEmailPayload, 'template'> = {
  version: 1,
  to: 'reader@example.com',
  messageId: '2e6c68e8-b843-4f5f-a3e9-6e2712fd3f24',
  actionUrl: 'https://books.example.com/continue?token=a&next="library"',
  recipientName: '<Reader & Friend>',
  expiresInMinutes: 15
};

describe('renderAuthEmail', () => {
  it.each([
    ['auth.email-verification', 'Verify your Pale Orbit email', 'verify your email address'],
    ['auth.password-reset', 'Reset your Pale Orbit password', 'reset your password'],
    ['auth.magic-link', 'Your Pale Orbit sign-in link', 'sign in']
  ] as const)('renders complete %s text and HTML', (template, subject, purpose) => {
    const rendered = renderAuthEmail({ ...basePayload, template });

    expect(rendered.subject).toBe(subject);
    expect(rendered.text).toContain(purpose);
    expect(rendered.text).toContain(basePayload.actionUrl);
    expect(rendered.text).toContain('15 minutes');
    expect(rendered.html).toContain('<!doctype html>');
    expect(rendered.html).toContain('15 minutes');
    expect(rendered.text).not.toContain(template);
    expect(rendered.html).not.toContain(template);
  });

  it('escapes recipient-controlled values in HTML', () => {
    const rendered = renderAuthEmail({ ...basePayload, template: 'auth.magic-link' });

    expect(rendered.html).toContain('&lt;Reader &amp; Friend&gt;');
    expect(rendered.html).toContain('token=a&amp;next=&quot;library&quot;');
    expect(rendered.html).not.toContain('<Reader & Friend>');
  });
});
