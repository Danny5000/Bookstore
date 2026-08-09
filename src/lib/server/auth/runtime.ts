import { getRequestEvent } from '$app/server';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { getApplicationConfig } from '$lib/server/config';
import { getDatabaseClient } from '$lib/server/db/runtime';
import { queueAuthEmail } from '$lib/server/email/enqueue';
import { canSendMagicLink, ensureCustomerRole } from './identity';
import { createAuthServer } from './options';

let authServer: ReturnType<typeof createAuthServer> | undefined;

export function getAuthServer(): ReturnType<typeof createAuthServer> {
  if (authServer) return authServer;
  const config = getApplicationConfig();
  const database = getDatabaseClient().db;
  authServer = createAuthServer({
    database,
    config,
    queueVerificationEmail: (input) => queueAuthEmail(database, input),
    queueResetEmail: (input) => queueAuthEmail(database, input),
    queueMagicEmail: (input) => queueAuthEmail(database, input),
    canSendMagicLink: (email) => canSendMagicLink(database, email),
    onUserCreated: (userId) => ensureCustomerRole(database, userId),
    additionalPlugins: [sveltekitCookies(getRequestEvent)]
  });
  return authServer;
}
