import { describe, expect, it } from 'vitest';
import { authEmailPayloadSchema } from './payload';

const validPayload = {
  version: 1,
  template: 'auth.email-verification',
  to: ' Reader@Example.COM ',
  messageId: '2e6c68e8-b843-4f5f-a3e9-6e2712fd3f24',
  actionUrl: 'https://books.example.com/api/auth/verify-email?token=opaque',
  recipientName: 'Reader',
  expiresInMinutes: 60
} as const;

describe('authEmailPayloadSchema', () => {
  it('accepts every version-one auth template and normalizes the recipient', () => {
    for (const template of [
      'auth.email-verification',
      'auth.password-reset',
      'auth.magic-link'
    ] as const) {
      const parsed = authEmailPayloadSchema.parse({ ...validPayload, template });
      expect(parsed.to).toBe('reader@example.com');
      expect(parsed.template).toBe(template);
    }
  });

  it('rejects unknown versions, templates, keys, and unsafe action URLs', () => {
    expect(() => authEmailPayloadSchema.parse({ ...validPayload, version: 2 })).toThrow();
    expect(() =>
      authEmailPayloadSchema.parse({ ...validPayload, template: 'auth.other' })
    ).toThrow();
    expect(() => authEmailPayloadSchema.parse({ ...validPayload, unexpected: true })).toThrow();
    expect(() =>
      authEmailPayloadSchema.parse({ ...validPayload, actionUrl: 'javascript:alert(1)' })
    ).toThrow();
  });

  it('bounds identifiers, names, email addresses, and expiry', () => {
    expect(() => authEmailPayloadSchema.parse({ ...validPayload, messageId: 'not-a-uuid' })).toThrow();
    expect(() => authEmailPayloadSchema.parse({ ...validPayload, to: 'not-an-email' })).toThrow();
    expect(() => authEmailPayloadSchema.parse({ ...validPayload, recipientName: '' })).toThrow();
    expect(() => authEmailPayloadSchema.parse({ ...validPayload, expiresInMinutes: 0 })).toThrow();
    expect(() =>
      authEmailPayloadSchema.parse({ ...validPayload, expiresInMinutes: 1441 })
    ).toThrow();
  });
});
