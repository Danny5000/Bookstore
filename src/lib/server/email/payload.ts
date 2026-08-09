import { z } from 'zod';

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const actionUrl = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' || (url.protocol === 'http:' && loopbackHosts.has(url.hostname));
}, 'must use https or loopback http');

const common = {
  version: z.literal(1),
  to: z.string().trim().transform((value) => value.toLowerCase()).pipe(z.email()),
  messageId: z.uuid(),
  actionUrl,
  recipientName: z.string().trim().min(1).max(200),
  expiresInMinutes: z.number().int().min(1).max(24 * 60)
};

export const authEmailPayloadSchema = z.discriminatedUnion('template', [
  z.strictObject({ ...common, template: z.literal('auth.email-verification') }),
  z.strictObject({ ...common, template: z.literal('auth.password-reset') }),
  z.strictObject({ ...common, template: z.literal('auth.magic-link') })
]);

export type AuthEmailPayload = z.output<typeof authEmailPayloadSchema>;
