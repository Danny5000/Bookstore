import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { loadApplicationConfig } from '$lib/server/config/load';
import { jobs, outboxMessages } from '$lib/server/db/schema';
import { AUTH_EMAIL_TOPIC, queueAuthEmail } from '$lib/server/email/enqueue';
import { createAuthEmailHandler } from '$lib/server/email/handler';
import { createNodemailerEmailTransport } from '$lib/server/email/nodemailer';
import type { EmailTransport } from '$lib/server/email/types';
import { createPostgresJobRepository } from '$lib/server/jobs/repository';
import { createOutboxDispatchHandler } from '$lib/server/outbox/dispatcher';
import { databaseClient, ownerDatabaseClient, workerDatabaseClient } from './database';

const config = loadApplicationConfig(process.env);

async function pollLatestMessage(recipient: string): Promise<string> {
  const mailpitUrl = process.env.MAILPIT_HTTP_URL;
  if (!mailpitUrl) throw new Error('MAILPIT_HTTP_URL is required');
  const url = new URL('/view/latest.txt', mailpitUrl);
  url.searchParams.set('query', `to:${recipient}`);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await fetch(url);
    if (response.ok) return response.text();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for Mailpit delivery');
}

async function searchMessages(recipient: string): Promise<Array<Record<string, unknown>>> {
  const mailpitUrl = process.env.MAILPIT_HTTP_URL;
  if (!mailpitUrl) throw new Error('MAILPIT_HTTP_URL is required');
  const url = new URL('/api/v1/search', mailpitUrl);
  url.searchParams.set('query', `to:${recipient}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Mailpit search failed with ${response.status}`);
  const result = (await response.json()) as { messages: Array<Record<string, unknown>> };
  return result.messages;
}

describe('SMTP outbox delivery', () => {
  it('delivers once through Mailpit and keeps transient errors safe and retryable', async () => {
    const recipient = `${randomUUID()}@example.com`;
    const actionUrl = `${config.origin}/reset-password?token=opaque-test-token`;
    await queueAuthEmail(databaseClient.db, {
      template: 'auth.password-reset',
      to: recipient,
      recipientName: 'Mailpit Reader',
      actionUrl,
      expiresInSeconds: 601
    });

    const repository = createPostgresJobRepository(
      workerDatabaseClient.db,
      config.jobs,
      () => new Date(Date.now() + 1_000)
    );
    const transport = createNodemailerEmailTransport(config.smtp);
    const dispatch = createOutboxDispatchHandler(
      workerDatabaseClient.db,
      new Map([
        [
          AUTH_EMAIL_TOPIC,
          createAuthEmailHandler(transport, config.smtp.from, new URL(config.origin).hostname)
        ]
      ])
    );
    const controller = new AbortController();
    try {
      const job = await repository.claimNext('mailpit-test-worker');
      if (!job) throw new Error('Expected queued email job');
      await dispatch(job, controller.signal);
      await repository.complete(job.id, job.lockedBy);

      const message = await pollLatestMessage(recipient);
      const searchResult = await searchMessages(recipient);
      expect(searchResult).toHaveLength(1);
      expect(searchResult[0]?.Subject ?? searchResult[0]?.subject).toBe(
        'Reset your Pale Orbit password'
      );
      expect(message).toContain('reset your password');
      expect(message).toContain('expires in 11 minutes');
      expect(message).toContain(actionUrl);
      expect(
        await ownerDatabaseClient.db.select().from(outboxMessages)
          .where(eq(outboxMessages.status, 'delivered'))
      ).toHaveLength(1);

      await dispatch(job, controller.signal);
      expect(await searchMessages(recipient)).toHaveLength(1);
    } finally {
      transport.close();
    }

    const failingRecipient = `${randomUUID()}@example.com`;
    await queueAuthEmail(databaseClient.db, {
      template: 'auth.magic-link',
      to: failingRecipient,
      recipientName: 'Failure Reader',
      actionUrl: `${config.origin}/api/auth/magic-link/verify?token=opaque`,
      expiresInSeconds: 600
    });
    const unsafeTransport: EmailTransport = {
      send: async () => {
        throw new Error(`SMTP rejected ${failingRecipient} with a private body`);
      }
    };
    const failingDispatch = createOutboxDispatchHandler(
      workerDatabaseClient.db,
      new Map([
        [
          AUTH_EMAIL_TOPIC,
          createAuthEmailHandler(unsafeTransport, config.smtp.from, 'example.test')
        ]
      ])
    );
    const failingRepository = createPostgresJobRepository(
      workerDatabaseClient.db,
      config.jobs,
      () => new Date(Date.now() + 1_000)
    );
    const failedJob = await failingRepository.claimNext('failure-test-worker');
    if (!failedJob) throw new Error('Expected queued failing email job');
    await expect(failingDispatch(failedJob, controller.signal)).rejects.toThrow();
    await failingRepository.fail(
      failedJob.id,
      failedJob.lockedBy,
      'Transient job handler failure',
      true
    );

    const [storedJob] = await databaseClient.db
      .select()
      .from(jobs)
      .where(eq(jobs.id, failedJob.id));
    const [storedMessage] = await ownerDatabaseClient.db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.dispatchJobId, failedJob.id));
    expect(storedJob).toMatchObject({ status: 'pending', lastError: 'Transient job handler failure' });
    expect(storedMessage).toMatchObject({
      status: 'failed',
      lastError: 'Transient outbox handler failure'
    });
    expect(`${storedJob?.lastError} ${storedMessage?.lastError}`).not.toContain(failingRecipient);
    expect(`${storedJob?.lastError} ${storedMessage?.lastError}`).not.toContain('private body');
  });
});
