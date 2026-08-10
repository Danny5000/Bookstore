import type { EmailTransport } from '$lib/server/email/types';
import { PermanentJobError } from '$lib/server/jobs/runner';
import type { OutboxTopicHandler } from '$lib/server/outbox/dispatcher';
import { parseCommerceEmailPayload } from './payload';
import { renderCommerceEmail } from './render';

export function createCommerceEmailHandler(
  transport: EmailTransport,
  from: string,
  messageIdDomain: string,
  applicationOrigin: string
): OutboxTopicHandler {
  return async (rawPayload, signal) => {
    let payload;
    try {
      payload = parseCommerceEmailPayload(rawPayload, applicationOrigin);
    } catch {
      throw new PermanentJobError('Invalid commerce email payload');
    }
    const rendered = renderCommerceEmail(payload);
    await transport.send({
      ...rendered,
      messageId: `<${payload.messageId}@${messageIdDomain}>`,
      from,
      to: payload.to
    }, signal);
  };
}
