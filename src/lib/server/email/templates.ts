import type { AuthEmailPayload } from './payload';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    };
    return entities[character] ?? character;
  });
}

export function renderAuthEmail(payload: AuthEmailPayload): RenderedEmail {
  const content = {
    'auth.email-verification': {
      purpose: 'verify your email address',
      subject: 'Verify your Pale Orbit email'
    },
    'auth.password-reset': {
      purpose: 'reset your password',
      subject: 'Reset your Pale Orbit password'
    },
    'auth.magic-link': {
      purpose: 'sign in',
      subject: 'Your Pale Orbit sign-in link'
    }
  } as const;
  const { purpose, subject } = content[payload.template];
  const name = escapeHtml(payload.recipientName);
  const url = escapeHtml(payload.actionUrl);

  return {
    subject,
    text: [
      `Hello ${payload.recipientName},`,
      '',
      `Use this link to ${purpose}:`,
      payload.actionUrl,
      '',
      `This single-use link expires in ${payload.expiresInMinutes} minutes.`,
      'If you did not request this, you can ignore this email.'
    ].join('\n'),
    html: [
      '<!doctype html><html><body>',
      `<p>Hello ${name},</p>`,
      `<p>Use this link to ${escapeHtml(purpose)}:</p>`,
      `<p><a href="${url}">${escapeHtml(subject)}</a></p>`,
      `<p>This single-use link expires in ${payload.expiresInMinutes} minutes.</p>`,
      '<p>If you did not request this, you can ignore this email.</p>',
      '</body></html>'
    ].join('')
  };
}
