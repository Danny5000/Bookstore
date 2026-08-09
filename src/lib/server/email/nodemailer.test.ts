import { describe, expect, it } from 'vitest';
import type { SmtpConfig } from '$lib/server/config';
import { createSmtpTransportOptions } from './nodemailer';

const config: SmtpConfig = {
  host: 'smtp.example.com',
  port: 587,
  secure: false,
  requireTls: true,
  user: 'mailer',
  password: 'secret',
  from: 'books@example.com',
  connectionTimeoutMs: 5000,
  greetingTimeoutMs: 6000,
  socketTimeoutMs: 7000
};

describe('createSmtpTransportOptions', () => {
  it('maps bounded TLS and authenticated SMTP settings', () => {
    expect(createSmtpTransportOptions(config)).toEqual({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: 'mailer', pass: 'secret' },
      connectionTimeout: 5000,
      greetingTimeout: 6000,
      socketTimeout: 7000
    });
  });

  it('omits auth for local Mailpit', () => {
    expect(
      createSmtpTransportOptions({ ...config, user: undefined, password: undefined }).auth
    ).toBeUndefined();
  });
});
