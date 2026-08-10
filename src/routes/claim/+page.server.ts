import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { requestGuestClaimEmails } from '$lib/server/commerce/claims';
import { getApplicationConfig } from '$lib/server/config';
import { getDatabaseClient } from '$lib/server/db/runtime';
import {
  StrictHttpError,
  assertSameOrigin,
  readBoundedBody
} from '$lib/server/http/strict-json';
import type { Actions } from './$types';

const claimRequestSchema = z.strictObject({
  email: z.string().max(400).refine((value) => z.email().safeParse(value.trim()).success)
});

export const actions: Actions = {
  default: async ({ request, getClientAddress }) => {
    try {
      assertSameOrigin(request);
    } catch (error) {
      if (error instanceof StrictHttpError) return fail(403, { forbidden: true });
      throw error;
    }

    const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim();
    const declaredLength = Number(request.headers.get('content-length'));
    if (
      contentType !== 'application/x-www-form-urlencoded' ||
      (Number.isFinite(declaredLength) && declaredLength > 2048)
    ) return fail(400, { invalid: true });

    let values: Record<string, string>;
    try {
      const bytes = await readBoundedBody(request, { maxBytes: 2048 });
      const encoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const fields = new URLSearchParams(encoded);
      if ([...fields.keys()].some((key) => key !== 'email') || fields.getAll('email').length !== 1) {
        return fail(400, { invalid: true });
      }
      values = { email: fields.get('email') ?? '' };
    } catch {
      return fail(400, { invalid: true });
    }
    const parsed = claimRequestSchema.safeParse(values);
    if (!parsed.success) return fail(400, { invalid: true });

    const config = getApplicationConfig();
    try {
      await requestGuestClaimEmails(getDatabaseClient().db, {
        email: parsed.data.email,
        requestIp: getClientAddress(),
        applicationSecret: config.auth.secret,
        windowSeconds: config.auth.rateLimit.windowSeconds,
        maxAttempts: config.auth.rateLimit.emailMax
      });
      return { sent: true };
    } catch {
      return fail(503, { unavailable: true });
    }
  }
};
