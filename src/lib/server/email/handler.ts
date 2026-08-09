import type { OutboxTopicHandler } from '$lib/server/outbox/dispatcher';
import { PermanentJobError } from '$lib/server/jobs/runner';
import { authEmailPayloadSchema } from './payload';
import { renderAuthEmail } from './templates';
import type { EmailTransport } from './types';

export function createAuthEmailHandler(
  transport: EmailTransport,
  from: string,
  messageIdDomain: string
): OutboxTopicHandler {
  return async (rawPayload, signal) => {
    const payload = authEmailPayloadSchema.safeParse(rawPayload);
    if (!payload.success) throw new PermanentJobError('Invalid auth email payload');

    const rendered = renderAuthEmail(payload.data);
    await transport.send(
      {
        ...rendered,
        messageId: `<${payload.data.messageId}@${messageIdDomain}>`,
        from,
        to: payload.data.to
      },
      signal
    );
  };
}
