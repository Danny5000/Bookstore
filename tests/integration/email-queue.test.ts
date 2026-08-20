import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { jobs, outboxMessages } from '$lib/server/db/schema';
import { AUTH_EMAIL_TOPIC, queueAuthEmail } from '$lib/server/email/enqueue';
import { databaseClient, ownerDatabaseClient } from './database';

describe('auth email queue', () => {
  it('atomically creates a versioned outbox message and dispatch job', async () => {
    await queueAuthEmail(databaseClient.db, {
      template: 'auth.password-reset',
      to: ' Reader@Example.COM ',
      recipientName: 'Reader',
      actionUrl: 'http://127.0.0.1:4173/reset-password?token=opaque',
      expiresInSeconds: 601
    });

    const [message] = await ownerDatabaseClient.db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.topic, AUTH_EMAIL_TOPIC));
    expect(message?.payload).toMatchObject({
      version: 1,
      template: 'auth.password-reset',
      to: 'reader@example.com',
      expiresInMinutes: 11
    });

    const [job] = await databaseClient.db
      .select()
      .from(jobs)
      .where(eq(jobs.id, message?.dispatchJobId ?? '00000000-0000-0000-0000-000000000000'));
    expect(job?.type).toBe('outbox.dispatch');
  });
});
