import { describe, expect, it } from 'vitest';
import { PermanentJobError } from '$lib/server/jobs/runner';
import type { EmailMessage, EmailTransport } from './types';
import { createAuthEmailHandler } from './handler';

describe('createAuthEmailHandler', () => {
  it('validates, renders, and sends an auth email', async () => {
    const sent: EmailMessage[] = [];
    const transport: EmailTransport = {
      async send(message) {
        sent.push(message);
      }
    };
    const handler = createAuthEmailHandler(
      transport,
      'Pale Orbit <books@paleorbit.test>',
      'paleorbit.test'
    );

    await handler(
      {
        version: 1,
        template: 'auth.magic-link',
        to: 'reader@example.com',
        messageId: '2e6c68e8-b843-4f5f-a3e9-6e2712fd3f24',
        actionUrl: 'https://books.example.com/api/auth/magic-link/verify?token=opaque',
        recipientName: 'Reader',
        expiresInMinutes: 15
      },
      new AbortController().signal
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: 'reader@example.com',
      from: 'Pale Orbit <books@paleorbit.test>',
      subject: 'Your Pale Orbit sign-in link',
      messageId: '<2e6c68e8-b843-4f5f-a3e9-6e2712fd3f24@paleorbit.test>'
    });
  });

  it('classifies an invalid payload as permanent without sending', async () => {
    const transport: EmailTransport = {
      async send() {
        throw new Error('must not send');
      }
    };
    const handler = createAuthEmailHandler(transport, 'books@example.com', 'example.com');

    await expect(handler({ template: 'unknown' }, new AbortController().signal)).rejects.toBeInstanceOf(
      PermanentJobError
    );
  });
});
