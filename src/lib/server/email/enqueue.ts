import { randomUUID } from 'node:crypto';
import type { Database } from '$lib/server/db/client';
import type { JsonObject } from '$lib/server/db/schema';
import { withTransaction } from '$lib/server/db/transaction';
import { enqueueOutboxMessage } from '$lib/server/outbox/repository';
import { authEmailPayloadSchema, type AuthEmailPayload } from './payload';

export const AUTH_EMAIL_TOPIC = 'email.auth.v1';

export interface QueueAuthEmailInput {
  template: AuthEmailPayload['template'];
  to: string;
  recipientName: string;
  actionUrl: string;
  expiresInSeconds: number;
}

export async function queueAuthEmail(database: Database, input: QueueAuthEmailInput): Promise<void> {
  const validated = authEmailPayloadSchema.parse({
    version: 1,
    template: input.template,
    to: input.to,
    recipientName: input.recipientName,
    actionUrl: input.actionUrl,
    expiresInMinutes: Math.ceil(input.expiresInSeconds / 60),
    messageId: randomUUID()
  });
  const payload: JsonObject = {
    version: validated.version,
    template: validated.template,
    to: validated.to,
    recipientName: validated.recipientName,
    actionUrl: validated.actionUrl,
    expiresInMinutes: validated.expiresInMinutes,
    messageId: validated.messageId
  };

  await withTransaction(database, async (transaction) => {
    await enqueueOutboxMessage(transaction, {
      topic: AUTH_EMAIL_TOPIC,
      payload
    });
  });
}
