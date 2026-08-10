import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { EmailMessage } from '$lib/server/email/types';
import { PermanentJobError } from '$lib/server/jobs/runner';
import { createCommerceEmailHandler } from './handler';

const origin = 'https://books.example.com';

function payload() {
  const orderId = randomUUID();
  return {
    version: 1 as const,
    template: 'commerce.account-receipt' as const,
    to: 'reader@example.com',
    messageId: orderId,
    orderNumber: orderId,
    orderDate: '2026-08-10T12:05:00.000Z',
    currency: 'USD',
    subtotalMinor: 1299,
    taxMinor: 104,
    totalMinor: 1403,
    items: [{ title: 'Book', creatorName: 'Writer', format: 'prose' as const }]
  };
}

describe('commerce email outbox handler', () => {
  it('renders and sends one bounded message with an internal UUID message id', async () => {
    const send = vi.fn(async (_message: EmailMessage, _signal: AbortSignal) => undefined);
    const transport = { send };
    const input = payload();
    const signal = new AbortController().signal;
    await createCommerceEmailHandler(
      transport,
      'books@example.com',
      'books.example.com',
      origin
    )(input, signal);
    expect(send).toHaveBeenCalledWith({
      messageId: `<${input.messageId}@books.example.com>`,
      from: 'books@example.com',
      to: 'reader@example.com',
      subject: 'Your Pale Orbit purchase',
      text: expect.stringContaining('direct download'),
      html: expect.stringContaining('<!doctype html>')
    }, signal);
    expect(Object.keys(send.mock.calls[0]![0]).sort()).toEqual([
      'from', 'html', 'messageId', 'subject', 'text', 'to'
    ]);
  });

  it('rejects invalid payloads permanently before transport', async () => {
    const send = vi.fn(async (_message: EmailMessage, _signal: AbortSignal) => undefined);
    const transport = { send };
    await expect(createCommerceEmailHandler(
      transport,
      'books@example.com',
      'books.example.com',
      origin
    )({ ...payload(), card: { last4: '4242' } }, new AbortController().signal))
      .rejects.toBeInstanceOf(PermanentJobError);
    expect(send).not.toHaveBeenCalled();
  });

  it('propagates transient transport failures for outbox retry', async () => {
    const transport = {
      send: vi.fn(async (_message: EmailMessage, _signal: AbortSignal) => {
        throw new Error('temporary SMTP failure');
      })
    };
    await expect(createCommerceEmailHandler(
      transport,
      'books@example.com',
      'books.example.com',
      origin
    )(payload(), new AbortController().signal)).rejects.toThrow('temporary SMTP failure');
  });
});
