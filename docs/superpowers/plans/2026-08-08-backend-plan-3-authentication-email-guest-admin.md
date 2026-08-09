# Backend Plan 3: Authentication, Email, Guest Identity, and Admin Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the prototype-only browser identity with durable Better Auth verified email/password and magic-link sessions, queue verification, password-reset, and magic-link email through the PostgreSQL outbox to a provider-neutral SMTP adapter, establish normalized guest identities and audited application roles, provide a safe first-admin command, and add a server-protected admin dashboard shell with user role management.

**Architecture:** Better Auth owns credential, account, verification, rate-limit, and session records through its supported Drizzle adapter. Project-owned `user_roles` and `guest_identities` tables map authenticated users and future guest orders into the existing actor policy. Authentication callbacks durably enqueue versioned email messages; the existing worker renders and sends them through an `EmailTransport` interface backed by Nodemailer. Every request resolves its Better Auth session on the server, maps it to a project actor, and authorizes all admin routes and mutations server-side. The first administrator is bootstrapped by an explicit one-shot service; subsequent grants and revocations run in a locked transaction and append audit events.

**Tech Stack:** Node.js 26.7.0, npm 11.19.0, SvelteKit 2.70.2, Svelte 5.56.8, TypeScript 6.0.3, PostgreSQL 18.4, Drizzle ORM 0.45.2, Better Auth 1.6.26 with its matching Drizzle adapter, Better Auth CLI (`auth`) 1.6.26, Nodemailer 9.0.5, `@types/nodemailer` 8.0.1, Mailpit 1.30.0, Vitest 4.1.10, and Playwright 1.62.1.

---

## Source of truth and boundaries

This plan implements Plan 3 from `docs/superpowers/specs/2026-08-08-bookstore-full-stack-design.md` and consumes the completed Plan 2 contract on `main`.

Preserve these boundaries throughout execution:

- Keep the current storefront, catalog, reader, checkout prototype, and visual language working. Authentication replaces only the fake `localStorage`/`po_session` seam.
- Keep `APPLICATION_MODE=maintenance` in production. Plan 7 deliberately opens and hardens the production application after the intervening backend phases are complete.
- Support email/password registration with email verification, sign-in, sign-out, password reset, and magic-link sign-in. Do not add Google, Apple, or any other OAuth provider.
- Better Auth uses its native scrypt password hashing, signed secure production cookies, origin/CSRF validation, single-use verification records, and PostgreSQL-backed rate limits. Do not add custom password crypto or Redis.
- Password registration requires a short-lived, single-use verification email before password sign-in. Better Auth 1.6 deliberately removes an existing password when a magic link verifies a previously unverified account; verifying password registrations first preserves both sign-in methods instead of exposing that surprising credential-loss path. Guest purchase claiming will independently require a magic link in Plan 6.
- `guest_identities` is identity groundwork only. Do not attach orders, create entitlements, or implement guest purchase claims; Plan 6 owns those transactions.
- Add the protected dashboard shell and audited user-role management. Leave catalog/revision screens and the detailed audit viewer to Plan 4, reader operations to Plan 5, and sales/fee/payout reporting to Plan 6.
- Retain PostgreSQL as the only job/outbox/rate-limit store. No Redis, BullMQ, or separate queue service is justified by this workload.
- Drizzle TypeScript schema remains the model source of truth. Better Auth's matching CLI generates its schema into the project schema directory, then Drizzle Kit generates a reviewed committed SQL migration. Production never runs Better Auth's direct `migrate` command or `drizzle-kit push`.
- All project-owned primary keys are UUIDs, timestamps are PostgreSQL `timestamptz`, and email addresses are trimmed and lowercased before identity matching.
- Never log or audit passwords, session cookies, verification tokens, magic-link URLs, password-reset URLs, SMTP credentials, or authentication secrets.

## Dependency decisions

Registry and official-documentation checks on 2026-08-08 selected these current stable releases:

| Package | Selected | Responsibility |
| --- | --- | --- |
| `better-auth` | 1.6.26 | Server/client auth APIs, native scrypt password support, verification, sessions, reset flow, and magic-link plugin |
| `auth` | 1.6.26 | Exact-version Better Auth schema generator used only during development |
| `nodemailer` | 9.0.5 | Provider-neutral SMTP protocol implementation behind the project adapter |
| `@types/nodemailer` | 8.0.1 | Current published Nodemailer declarations; remove only if Nodemailer begins shipping compatible declarations |

`better-auth@1.6.26` already contains the matching `@better-auth/drizzle-adapter@1.6.26` and exports it from `better-auth/adapters/drizzle`, so do not add a second direct adapter dependency. Its peer ranges accept the repository's SvelteKit 2, Svelte 5, Drizzle ORM 0.45.2, Drizzle Kit 0.31.10, `pg` 8, and Vitest 4 versions. Use the stable 1.6 line; do not adopt the available 1.7 beta or release candidate during this plan.

## Authentication and delivery invariants

- Better Auth is mounted at its default `/api/auth` base path and receives the single configured `ORIGIN` as both `baseURL` and the only trusted browser origin.
- The cookie is HTTP-only and SameSite Lax. It is Secure in production and non-Secure only for local/test HTTP origins. Session lifetime is configurable and database-backed.
- Password registration creates no usable session until its single-use email-verification link is consumed; verification then signs the user in and preserves later password plus magic-link compatibility.
- Magic-link delivery is suppressed for an existing unverified credential account, and the UI offers a rate-limited verification-email resend. This prevents Better Auth's documented unverified-account magic behavior from removing the pending password.
- Better Auth's rate limiter is explicitly enabled in every environment and uses its generated PostgreSQL `rateLimit` model. Sensitive endpoint rules cover password sign-in, reset requests, and magic-link requests.
- A successfully registered user has an idempotent `customer` role record. Session-to-actor mapping still treats a missing customer row as `customer` and repairs it asynchronously so a failed post-create hook cannot lock a real user out.
- The `customer` role is permanent. An admin may add or remove only `admin`; the last remaining administrator cannot be demoted. A PostgreSQL transaction-level advisory lock serializes this invariant.
- First-admin bootstrap is idempotent. It creates the credential account when the normalized email is new, never changes the password of an existing account, adds missing `customer`/`admin` records, and appends a system audit event.
- Each mail request inserts the outbox message and its dispatch job in one application transaction. The worker delivers at least once and uses a stable RFC Message-ID. SMTP cannot atomically commit with PostgreSQL, so a crash after SMTP acceptance but before `deliveredAt` can produce a duplicate; templates must be safe to receive twice.
- Better Auth persists verification state inside its own adapter transaction before calling the configured mail callback. Better Auth 1.6 does not expose that transaction to application code, so the token row and project outbox row cannot share one database transaction without replacing the supported adapter. The callback is awaited and the endpoint reports success only after durable enqueue; an enqueue failure may leave an unused verification row, but it does not tell the user mail was sent. Record this explicit adapter boundary in the runbook rather than claiming cross-library atomicity.

## File map

### Dependencies, configuration, and generated persistence

- `package.json`, `package-lock.json` — exact Better Auth/CLI/Nodemailer dependencies and auth/bootstrap scripts.
- `.env.example` — safe local auth, Mailpit, SMTP, and bootstrap examples; no live secret.
- `src/lib/server/config/read-setting.ts` — optional direct-or-`_FILE` setting support.
- `src/lib/server/config/schema.ts`, `src/lib/server/config/load.ts` — validated auth/rate-limit/SMTP configuration.
- `src/lib/server/db/schema/auth.ts` — Better Auth CLI-generated Drizzle core and rate-limit tables.
- `src/lib/server/db/schema/identity.ts` — project-owned application roles and normalized guest identities.
- `src/lib/server/db/schema/index.ts` — schema barrel used by Drizzle and Better Auth.
- `drizzle/` — one generated, reviewed migration containing auth and application identity tables.

### Email and authentication modules

- `src/lib/server/email/types.ts` — provider-neutral message and transport contracts.
- `src/lib/server/email/payload.ts` — versioned outbox payload validation.
- `src/lib/server/email/templates.ts` — escaped password-reset and magic-link text/HTML rendering.
- `src/lib/server/email/nodemailer.ts` — SMTP adapter construction and bounded timeouts.
- `src/lib/server/email/enqueue.ts` — transaction-backed auth email enqueue helpers.
- `src/lib/server/email/handler.ts` — outbox topic handler.
- `src/lib/server/auth/options.ts` — one Better Auth option factory shared by schema generation, web, tests, and bootstrap.
- `src/lib/server/auth/schema-config.ts` — exact CLI entry point with inert email callbacks.
- `src/lib/server/auth/runtime.ts` — cached web Better Auth instance with durable email and SvelteKit cookies.
- `src/lib/server/auth/identity.ts` — email normalization, role persistence, guest identity foundation, and session actor mapping.
- `src/lib/server/auth/roles.ts` — audited, last-admin-safe role mutations and user listing.
- `src/lib/auth/client.ts` — browser Better Auth Svelte client with the magic-link plugin.

### Runtime, UI, tests, and operations

- `src/hooks.server.ts`, `src/app.d.ts`, `src/routes/+layout.server.ts` — session/actor population and server layout data.
- `src/lib/components/AuthModal.svelte`, `src/lib/components/Header.svelte`, `src/routes/+layout.svelte`, `src/routes/reset-password/+page.svelte` — real auth flows with the prototype presentation retained.
- `src/bootstrap-admin.ts`, `vite.services.config.ts` — one-shot first-admin program and production bundle.
- `src/routes/admin/+layout.server.ts`, `src/routes/admin/+layout.svelte`, `src/routes/admin/+page.svelte` — protected dashboard shell.
- `src/routes/admin/users/+page.server.ts`, `src/routes/admin/users/+page.svelte` — server-authorized role management.
- `compose.dev.yaml`, `compose.prod.yaml`, `compose.test.yaml`, `Dockerfile` — Mailpit/test services, worker SMTP configuration, secrets, and bootstrap tool service.
- `scripts/with-test-database.ts` — optional worker/bootstrap orchestration and dynamic Mailpit ports for E2E.
- `src/lib/server/email/*.test.ts`, `src/lib/server/auth/*.test.ts`, `tests/integration/auth.test.ts`, `tests/integration/email.test.ts`, `tests/integration/identity.test.ts`, `tests/integration/roles.test.ts`, `tests/integration/bootstrap-admin.test.ts`, `tests/e2e/auth.spec.ts`, `tests/e2e/admin.spec.ts` — focused unit, real-PostgreSQL/Mailpit, and browser coverage.
- `docs/authentication-and-email.md`, `docs/runtime-environments.md`, `docs/dependency-decisions.md`, `README.md` — local, production, bootstrap, SMTP, and security runbooks.

## Task 1: Add exact dependencies and the validated auth/SMTP contract

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/lib/server/config/read-setting.ts`
- Modify: `src/lib/server/config/read-setting.test.ts`
- Modify: `src/lib/server/config/schema.ts`
- Modify: `src/lib/server/config/load.ts`
- Modify: `src/lib/server/config/index.test.ts`
- Modify: `.env.example`
- Modify: `docs/dependency-decisions.md`

- [ ] **Step 1: Reconfirm stable package versions and compatibility**

Run:

```powershell
npm view better-auth version peerDependencies dependencies --json
npm view @better-auth/drizzle-adapter version --json
npm view auth version bin --json
npm view nodemailer version engines --json
npm view @types/nodemailer version dependencies --json
```

Expected: the selected stable versions remain `1.6.26`, `1.6.26`, `1.6.26`, `9.0.5`, and `8.0.1`. If a stable release changed, inspect its official release notes and peer requirements, update this plan's dependency table and exact commands, and do not move to a prerelease.

- [ ] **Step 2: Install exact packages and add reproducible scripts**

Run:

```powershell
npm install --save-exact better-auth@1.6.26 nodemailer@9.0.5
npm install --save-dev --save-exact auth@1.6.26 @types/nodemailer@8.0.1
npm ls better-auth @better-auth/drizzle-adapter auth nodemailer @types/nodemailer
```

Add these scripts to `package.json`:

```json
"auth:schema": "node --env-file-if-exists=.env node_modules/auth/dist/index.mjs generate --config ./src/lib/server/auth/schema-config.ts --output ./src/lib/server/db/schema/auth.ts --yes",
"auth:info": "node --env-file-if-exists=.env node_modules/auth/dist/index.mjs info --config ./src/lib/server/auth/schema-config.ts",
"admin:bootstrap:raw": "tsx src/bootstrap-admin.ts",
"admin:bootstrap": "node --env-file-if-exists=.env --import tsx src/bootstrap-admin.ts"
```

Expected: one valid copy of every selected package, the adapter resolves at 1.6.26 through `better-auth`, and npm reports no peer error.

- [ ] **Step 3: Write failing optional-setting tests**

Add cases to `src/lib/server/config/read-setting.test.ts` proving:

```ts
expect(readOptionalSetting({}, 'SMTP_USER', () => '')).toBeUndefined();
expect(readOptionalSetting({ SMTP_USER: 'mailer' }, 'SMTP_USER', () => '')).toBe('mailer');
expect(
  readOptionalSetting({ SMTP_PASSWORD_FILE: '/run/secrets/smtp' }, 'SMTP_PASSWORD', () => ' secret\n')
).toBe('secret');
```

Also assert that setting both `SMTP_PASSWORD` and `SMTP_PASSWORD_FILE` throws the same ambiguity error as required settings, and an empty optional direct value normalizes to `undefined`.

Run:

```powershell
npm run test:unit -- src/lib/server/config/read-setting.test.ts
```

Expected: FAIL because `readOptionalSetting` does not exist.

- [ ] **Step 4: Implement optional direct-or-file loading**

Add this exported function to `src/lib/server/config/read-setting.ts`, reusing its existing ambiguity check and default UTF-8 file reader:

```ts
export function readOptionalSetting(
  source: EnvironmentValues,
  name: string,
  readSecretFile: SecretFileReader = defaultSecretFileReader
): string | undefined {
  const direct = source[name]?.trim();
  const filePath = source[`${name}_FILE`]?.trim();

  if (direct && filePath) {
    throw new ConfigurationError(`Set only one of ${name} or ${name}_FILE`);
  }
  if (direct) return direct;
  if (!filePath) return undefined;

  const value = readSecretFile(filePath).trim();
  return value || undefined;
}
```

Run the focused test again; expected: PASS.

- [ ] **Step 5: Write failing configuration tests**

Extend the valid fixture in `src/lib/server/config/index.test.ts` with:

```ts
AUTH_SECRET: 'test-only-auth-secret-at-least-thirty-two-bytes',
AUTH_SESSION_EXPIRES_SECONDS: '604800',
AUTH_VERIFICATION_EXPIRES_SECONDS: '3600',
AUTH_RESET_EXPIRES_SECONDS: '3600',
AUTH_MAGIC_EXPIRES_SECONDS: '900',
AUTH_RATE_LIMIT_WINDOW_SECONDS: '60',
AUTH_RATE_LIMIT_MAX: '100',
AUTH_LOGIN_RATE_LIMIT_MAX: '5',
AUTH_EMAIL_RATE_LIMIT_MAX: '3',
SMTP_HOST: '127.0.0.1',
SMTP_PORT: '1025',
SMTP_SECURE: 'false',
SMTP_REQUIRE_TLS: 'false',
SMTP_FROM: 'Pale Orbit Press <books@paleorbit.local>',
SMTP_CONNECTION_TIMEOUT_MS: '5000',
SMTP_GREETING_TIMEOUT_MS: '5000',
SMTP_SOCKET_TIMEOUT_MS: '10000'
```

Add tests for these invariants:

- `AUTH_SECRET` is at least 32 characters.
- auth expirations and rate limits parse to integers in their documented ranges.
- `SMTP_SECURE` and `SMTP_REQUIRE_TLS` parse strict `true`/`false` strings; `secure=true` plus `requireTls=true` is rejected.
- `SMTP_USER` and `SMTP_PASSWORD` are both absent or both present.
- production requires SMTP credentials while development/test may use unauthenticated Mailpit.
- production rejects an `http:` origin and development/test accept loopback HTTP.
- the transformed config has `auth` and `smtp` subobjects without retaining raw setting names.

Run:

```powershell
npm run test:unit -- src/lib/server/config/index.test.ts
```

Expected: FAIL because the new settings are not parsed.

- [ ] **Step 6: Extend the configuration schema and loader**

In `src/lib/server/config/schema.ts`, add a strict boolean-string helper, seconds bounds, auth fields, SMTP fields, and these transformed shapes:

```ts
auth: {
  secret: value.AUTH_SECRET,
  sessionExpiresIn: value.AUTH_SESSION_EXPIRES_SECONDS,
  verificationExpiresIn: value.AUTH_VERIFICATION_EXPIRES_SECONDS,
  resetExpiresIn: value.AUTH_RESET_EXPIRES_SECONDS,
  magicExpiresIn: value.AUTH_MAGIC_EXPIRES_SECONDS,
  rateLimit: {
    windowSeconds: value.AUTH_RATE_LIMIT_WINDOW_SECONDS,
    max: value.AUTH_RATE_LIMIT_MAX,
    loginMax: value.AUTH_LOGIN_RATE_LIMIT_MAX,
    emailMax: value.AUTH_EMAIL_RATE_LIMIT_MAX
  }
},
smtp: {
  host: value.SMTP_HOST,
  port: value.SMTP_PORT,
  secure: value.SMTP_SECURE,
  requireTls: value.SMTP_REQUIRE_TLS,
  user: value.SMTP_USER,
  password: value.SMTP_PASSWORD,
  from: value.SMTP_FROM,
  connectionTimeoutMs: value.SMTP_CONNECTION_TIMEOUT_MS,
  greetingTimeoutMs: value.SMTP_GREETING_TIMEOUT_MS,
  socketTimeoutMs: value.SMTP_SOCKET_TIMEOUT_MS
}
```

Export `AuthConfig` and `SmtpConfig` from the transformed application type. In `src/lib/server/config/load.ts`, keep required names in `REQUIRED_SETTINGS`, add `SMTP_USER` and `SMTP_PASSWORD` to `OPTIONAL_SETTINGS`, and build one input object using `readRequiredSetting` and `readOptionalSetting` before parsing.

The production refinements must be exactly:

```ts
if (value.APP_ENV === 'production' && new URL(value.ORIGIN).protocol !== 'https:') {
  context.addIssue({ code: 'custom', path: ['ORIGIN'], message: 'production must use https' });
}
if (Boolean(value.SMTP_USER) !== Boolean(value.SMTP_PASSWORD)) {
  context.addIssue({
    code: 'custom',
    path: ['SMTP_PASSWORD'],
    message: 'SMTP_USER and SMTP_PASSWORD must be configured together'
  });
}
if (value.APP_ENV === 'production' && (!value.SMTP_USER || !value.SMTP_PASSWORD)) {
  context.addIssue({
    code: 'custom',
    path: ['SMTP_USER'],
    message: 'production SMTP credentials are required'
  });
}
```

Run:

```powershell
npm run test:unit -- src/lib/server/config/read-setting.test.ts src/lib/server/config/index.test.ts
```

Expected: PASS.

- [ ] **Step 7: Replace the legacy mail example with safe auth/SMTP values**

Remove `MAIL_API_KEY` and `MAIL_FROM` from `.env.example`. Add:

```dotenv
# Better Auth. Replace this development-only value in every real deployment.
AUTH_SECRET=pale-orbit-local-auth-secret-change-me-2026
AUTH_SESSION_EXPIRES_SECONDS=604800
AUTH_VERIFICATION_EXPIRES_SECONDS=3600
AUTH_RESET_EXPIRES_SECONDS=3600
AUTH_MAGIC_EXPIRES_SECONDS=900
AUTH_RATE_LIMIT_WINDOW_SECONDS=60
AUTH_RATE_LIMIT_MAX=100
AUTH_LOGIN_RATE_LIMIT_MAX=5
AUTH_EMAIL_RATE_LIMIT_MAX=3

# Host-run development uses Mailpit on localhost. Compose overrides SMTP_HOST to `mailpit`.
SMTP_HOST=localhost
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_REQUIRE_TLS=false
SMTP_FROM="Pale Orbit Press <books@paleorbit.local>"
SMTP_CONNECTION_TIMEOUT_MS=5000
SMTP_GREETING_TIMEOUT_MS=5000
SMTP_SOCKET_TIMEOUT_MS=10000
# SMTP_USER and SMTP_PASSWORD are intentionally omitted for local Mailpit.

# Used only by the explicit `admin:bootstrap` tool. Choose a unique password locally.
BOOTSTRAP_ADMIN_EMAIL=admin@paleorbit.local
BOOTSTRAP_ADMIN_NAME=Pale Orbit Administrator
BOOTSTRAP_ADMIN_PASSWORD=replace-this-before-running-bootstrap
```

Document the dependency decisions and the stable/prerelease choice in `docs/dependency-decisions.md`.

- [ ] **Step 8: Commit the dependency and configuration slice**

```powershell
git add package.json package-lock.json .env.example src/lib/server/config docs/dependency-decisions.md
git commit -m "build: add authentication and smtp configuration"
```

## Task 2: Build the provider-neutral email path and register it with the worker

**Files:**
- Create: `src/lib/server/email/types.ts`
- Create: `src/lib/server/email/payload.ts`
- Create: `src/lib/server/email/templates.ts`
- Create: `src/lib/server/email/nodemailer.ts`
- Create: `src/lib/server/email/enqueue.ts`
- Create: `src/lib/server/email/handler.ts`
- Create: `src/lib/server/email/templates.test.ts`
- Create: `src/lib/server/email/payload.test.ts`
- Modify: `src/worker.ts`

- [ ] **Step 1: Write failing payload and template tests**

Create unit tests proving:

- only payload version `1` and templates `auth.email-verification`/`auth.password-reset`/`auth.magic-link` are accepted;
- recipient email, stable message ID, HTTPS/loopback-HTTP action URL, display name, and expiry minutes are required and bounded;
- unexpected keys and non-HTTP(S) URLs are rejected;
- HTML escapes recipient-controlled names and URLs;
- rendered output has both text and HTML, a fixed subject per template, and never prints the raw template key.

Run:

```powershell
npm run test:unit -- src/lib/server/email/payload.test.ts src/lib/server/email/templates.test.ts
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 2: Define the transport and versioned payload contract**

Create `src/lib/server/email/types.ts`:

```ts
export interface EmailMessage {
  messageId: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailTransport {
  send(message: EmailMessage, signal: AbortSignal): Promise<void>;
}
```

Create `src/lib/server/email/payload.ts` around a strict Zod discriminated union:

```ts
import { z } from 'zod';

const actionUrl = z.url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol));
const common = {
  version: z.literal(1),
  to: z.string().trim().transform((value) => value.toLowerCase()).pipe(z.email()),
  messageId: z.string().uuid(),
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
```

The implementation may use the repository's exact Zod 4 method spelling if `z.email()` differs from the installed declarations; it must remain a strict discriminated union with the same output type.

- [ ] **Step 3: Render safe, complete templates**

Create `src/lib/server/email/templates.ts` with one non-exported HTML escaping function and:

```ts
export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export function renderAuthEmail(payload: AuthEmailPayload): RenderedEmail {
  const content = {
    'auth.email-verification': {
      purpose: 'verify your email address',
      subject: 'Verify your Pale Orbit email'
    },
    'auth.password-reset': {
      purpose: 'reset your password',
      subject: 'Reset your Pale Orbit password'
    },
    'auth.magic-link': {
      purpose: 'sign in',
      subject: 'Your Pale Orbit sign-in link'
    }
  } as const;
  const { purpose, subject } = content[payload.template];
  const name = escapeHtml(payload.recipientName);
  const url = escapeHtml(payload.actionUrl);

  return {
    subject,
    text: [
      `Hello ${payload.recipientName},`,
      '',
      `Use this link to ${purpose}:`,
      payload.actionUrl,
      '',
      `This single-use link expires in ${payload.expiresInMinutes} minutes.`,
      'If you did not request this, you can ignore this email.'
    ].join('\n'),
    html: `<!doctype html><html><body><p>Hello ${name},</p><p>Use this link to ${escapeHtml(purpose)}:</p><p><a href="${url}">${escapeHtml(subject)}</a></p><p>This single-use link expires in ${payload.expiresInMinutes} minutes.</p><p>If you did not request this, you can ignore this email.</p></body></html>`
  };
}
```

Do not interpolate any unescaped value into HTML.

- [ ] **Step 4: Implement the Nodemailer adapter and durable enqueue helper**

`src/lib/server/email/nodemailer.ts` must create the transporter once from `SmtpConfig`, pass `secure`, `requireTLS`, optional `auth`, `connectionTimeout`, `greetingTimeout`, and `socketTimeout`, and expose only `EmailTransport`. The adapter must pass the signal to Nodemailer's send options if supported by the installed declarations; otherwise race the send promise against the signal and close the transporter only during process shutdown. Never log the message body or recipient.

`src/lib/server/email/enqueue.ts` must export:

```ts
export const AUTH_EMAIL_TOPIC = 'email.auth.v1';

export interface QueueAuthEmailInput {
  template: AuthEmailPayload['template'];
  to: string;
  recipientName: string;
  actionUrl: string;
  expiresInSeconds: number;
}

export async function queueAuthEmail(
  database: Database,
  input: QueueAuthEmailInput
): Promise<void> {
  const payload = authEmailPayloadSchema.parse({
    version: 1,
    template: input.template,
    to: input.to,
    recipientName: input.recipientName,
    actionUrl: input.actionUrl,
    expiresInMinutes: Math.ceil(input.expiresInSeconds / 60),
    messageId: randomUUID()
  });

  await withTransaction(database, async (transaction) => {
    await enqueueOutboxMessage(transaction, {
      topic: AUTH_EMAIL_TOPIC,
      payload,
      maxAttempts: 8
    });
  });
}
```

Zod output must satisfy the existing `JsonObject` contract without `as unknown as`; if necessary, construct an explicitly typed plain object after validation.

- [ ] **Step 5: Create the outbox handler and register it**

Create `src/lib/server/email/handler.ts`:

```ts
export function createAuthEmailHandler(
  transport: EmailTransport,
  from: string
): OutboxTopicHandler {
  return async (rawPayload, signal) => {
    const payload = authEmailPayloadSchema.safeParse(rawPayload);
    if (!payload.success) throw new PermanentJobError('Invalid auth email payload');
    const rendered = renderAuthEmail(payload.data);
    await transport.send(
      { ...rendered, messageId: `<${payload.data.messageId}@paleorbit.local>`, from, to: payload.data.to },
      signal
    );
  };
}
```

Modify `src/worker.ts` so it creates the SMTP transport after config/database construction and registers exactly:

```ts
const topicHandlers = new Map<string, OutboxTopicHandler>([
  [AUTH_EMAIL_TOPIC, createAuthEmailHandler(emailTransport, config.smtp.from)]
]);
```

Close the transport in `finally` through a small optional `close()` lifecycle method or adapter-specific closure owned by the worker; do not add transport lifecycle to the generic send contract.

- [ ] **Step 6: Make unit tests pass and commit**

Run:

```powershell
npm run test:unit -- src/lib/server/email/payload.test.ts src/lib/server/email/templates.test.ts
npm run check
npm run lint
git add src/lib/server/email src/worker.ts
git commit -m "feat: add queued smtp email delivery"
```

Expected: focused tests, Svelte/TypeScript checking, and ESLint pass.

## Task 3: Generate Better Auth persistence and add project identity tables

**Files:**
- Create, then reduce to shared factory use: `src/lib/server/auth/schema-config.ts`
- Create: `src/lib/server/db/schema/auth.ts` (generated)
- Create: `src/lib/server/db/schema/identity.ts`
- Modify: `src/lib/server/db/schema/index.ts`
- Modify: `drizzle/`
- Modify: `tests/integration/setup.ts`
- Create: `tests/integration/schema-auth.test.ts`

- [ ] **Step 1: Create the initial schema-generation configuration**

Create `src/lib/server/auth/schema-config.ts` as a CLI-only Better Auth instance. It must load configuration from `process.env`, create the existing Drizzle client, use `drizzleAdapter(databaseClient.db, { provider: 'pg' })`, and configure exactly the same schema-affecting options the runtime will use:

```ts
export const auth = betterAuth({
  appName: 'Pale Orbit Press',
  baseURL: config.origin,
  secret: config.auth.secret,
  database: drizzleAdapter(databaseClient.db, { provider: 'pg' }),
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    requireEmailVerification: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    resetPasswordTokenExpiresIn: config.auth.resetExpiresIn,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async () => undefined
  },
  emailVerification: {
    expiresIn: config.auth.verificationExpiresIn,
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async () => undefined
  },
  session: { expiresIn: config.auth.sessionExpiresIn },
  rateLimit: {
    enabled: true,
    storage: 'database',
    modelName: 'rateLimit',
    window: config.auth.rateLimit.windowSeconds,
    max: config.auth.rateLimit.max,
    customRules: {
      '/sign-in/email': {
        window: config.auth.rateLimit.windowSeconds,
        max: config.auth.rateLimit.loginMax
      },
      '/request-password-reset': {
        window: config.auth.rateLimit.windowSeconds,
        max: config.auth.rateLimit.emailMax
      },
      '/send-verification-email': {
        window: config.auth.rateLimit.windowSeconds,
        max: config.auth.rateLimit.emailMax
      },
      '/sign-in/magic-link': {
        window: config.auth.rateLimit.windowSeconds,
        max: config.auth.rateLimit.emailMax
      }
    }
  },
  advanced: {
    useSecureCookies: config.environment === 'production',
    database: { generateId: 'uuid' }
  },
  trustedOrigins: [new URL(config.origin).origin],
  telemetry: { enabled: false },
  plugins: [
    magicLink({
      expiresIn: config.auth.magicExpiresIn,
      disableSignUp: false,
      sendMagicLink: async () => undefined
    })
  ]
});
```

Do not disable CSRF or origin checks. The file is not a runtime singleton and must never be imported by browser code.

- [ ] **Step 2: Generate and review Better Auth's Drizzle schema**

Run:

```powershell
npm run auth:schema
git diff -- src/lib/server/db/schema/auth.ts
```

Expected: the generated file defines the Better Auth `user`, `session`, `account`, `verification`, and database-backed `rateLimit` models plus the relations required by the selected adapter. IDs are PostgreSQL UUIDs because `advanced.database.generateId` is `uuid`. Foreign keys, token uniqueness, email uniqueness, session expiry, and rate-limit fields are present.

Do not hand-edit generated declarations merely to match project naming style. If a requirement is missing, fix `schema-config.ts`, regenerate, and review again.

- [ ] **Step 3: Add project-owned identity schema**

Create `src/lib/server/db/schema/identity.ts`:

```ts
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core';
import { user } from './auth';

export const applicationRole = pgEnum('application_role', ['customer', 'admin']);

export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: applicationRole('role').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).defaultNow().notNull(),
    grantedByUserId: uuid('granted_by_user_id').references(() => user.id, {
      onDelete: 'set null'
    })
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.role], name: 'user_roles_pk' }),
    index('user_roles_role_idx').on(table.role, table.userId)
  ]
);

export const guestIdentities = pgTable(
  'guest_identities',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').notNull(),
    claimedByUserId: uuid('claimed_by_user_id').references(() => user.id, {
      onDelete: 'restrict'
    }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull()
  },
  (table) => [
    uniqueIndex('guest_identities_email_unique').on(table.email),
    index('guest_identities_claimed_user_idx').on(table.claimedByUserId),
    check('guest_identities_email_normalized', sql`${table.email} = lower(btrim(${table.email}))`),
    check(
      'guest_identities_claim_state_consistent',
      sql`(${table.claimedByUserId} is null) = (${table.claimedAt} is null)`
    )
  ]
);

export type UserRoleRow = typeof userRoles.$inferSelect;
export type GuestIdentityRow = typeof guestIdentities.$inferSelect;
```

Export `./auth` and `./identity` from `src/lib/server/db/schema/index.ts`.

- [ ] **Step 4: Generate one reviewed Drizzle migration**

Run:

```powershell
npm run db:generate -- --name=authentication_identity
npm run db:check
git diff -- drizzle src/lib/server/db/schema
```

Expected: one new migration and snapshot create Better Auth's five models, `application_role`, `user_roles`, and `guest_identities`; UUID and foreign-key types agree; all existing Plan 2 tables remain unchanged.

Inspect generated SQL for these exact properties:

- auth user email and session token are unique;
- account and verification records have their Better Auth-required uniqueness/indexes;
- rate-limit key lookup is indexed or uniquely constrained as generated;
- all project timestamps are `timestamp with time zone`;
- deleting an auth user cascades its role rows but cannot silently delete a claimed guest identity;
- guest email normalization and claim-state checks exist.

- [ ] **Step 5: Write failing real-database schema tests**

Update `tests/integration/setup.ts` to truncate the generated auth tables, `user_roles`, and `guest_identities` along with the Plan 2 tables. Quote any generated camel-case table name such as `"rateLimit"` exactly.

Create `tests/integration/schema-auth.test.ts` that asserts:

- a generated UUID can be inserted and returned from every auth table through the real schema;
- duplicate normalized guest emails fail;
- non-normalized guest emails fail the database check;
- partial guest claim state fails;
- duplicate `(userId, role)` pairs fail;
- user deletion cascades roles and a user referenced by a claimed guest cannot be deleted.

Run:

```powershell
npm run test:integration -- tests/integration/schema-auth.test.ts
```

Expected: PASS after the migration applies to a fresh disposable PostgreSQL container.

- [ ] **Step 6: Commit generated and project schema together**

```powershell
git add src/lib/server/auth/schema-config.ts src/lib/server/db/schema drizzle tests/integration/setup.ts tests/integration/schema-auth.test.ts
git commit -m "feat: add authentication identity schema"
```

## Task 4: Implement identity normalization, session actors, guest groundwork, and safe role changes

**Files:**
- Create: `src/lib/server/auth/identity.ts`
- Create: `src/lib/server/auth/identity.test.ts`
- Create: `src/lib/server/auth/roles.ts`
- Modify: `src/lib/types/auth.ts`
- Modify: `src/lib/server/auth/admin-policy.ts`
- Modify: `src/lib/server/auth/admin-policy.test.ts`
- Create: `tests/integration/identity.test.ts`
- Create: `tests/integration/roles.test.ts`

- [ ] **Step 1: Write failing normalization and policy tests**

Create `src/lib/server/auth/identity.test.ts` for `normalizeEmailAddress`:

```ts
expect(normalizeEmailAddress('  Reader@Example.COM ')).toBe('reader@example.com');
expect(() => normalizeEmailAddress('not-an-email')).toThrow('Invalid email address');
expect(() => normalizeEmailAddress('')).toThrow('Invalid email address');
```

Extend `admin-policy.test.ts` so `roles.manage` and `admin.access` are accepted capabilities and are denied to anonymous, guest, system, and customer actors but accepted for an admin actor.

Run the focused unit tests. Expected: FAIL.

- [ ] **Step 2: Put the role type in a neutral module and add identity primitives**

Move the existing `ApplicationRole` union from `admin-policy.ts` into `src/lib/types/auth.ts`, export it there, and import it into the server policy and identity modules. This prevents later browser-facing session types from importing a server module. Change `AdminCapability` to:

```ts
export type AdminCapability =
  | 'admin.access'
  | 'catalog.manage'
  | 'roles.manage'
  | 'audit.read'
  | 'jobs.retry';
```

In `src/lib/server/auth/identity.ts`, implement and export:

```ts
export function normalizeEmailAddress(value: string): string;
export async function ensureCustomerRole(database: DatabaseExecutor, userId: string): Promise<void>;
export async function listRolesForUser(
  database: DatabaseExecutor,
  userId: string
): Promise<readonly ApplicationRole[]>;
export async function actorForUser(
  database: Database,
  userId: string
): Promise<Extract<Actor, { type: 'user' }>>;
export async function findOrCreateGuestIdentity(
  database: Database,
  email: string
): Promise<GuestIdentityRow>;
export async function canSendMagicLink(
  database: Database,
  email: string
): Promise<boolean>;
```

Use Zod's email validation after trim/lowercase. `ensureCustomerRole` inserts `(userId, 'customer')` with `onConflictDoNothing`. `listRolesForUser` always returns `customer` for a valid auth user, even if the repair row is temporarily absent, and returns roles in deterministic `customer`, `admin` order. `actorForUser` calls `ensureCustomerRole` before returning. `findOrCreateGuestIdentity` uses `insert ... on conflict (email) do update set updated_at = guest_identities.updated_at returning ...` or an equivalent race-safe single-statement upsert that does not change claim state. `canSendMagicLink` returns `false` only when the normalized email belongs to an unverified auth user with a `credential` provider account; unknown, verified, and non-credential identities return `true` without exposing their state to the caller.

Do not put order-claim logic in this module.

- [ ] **Step 3: Write failing integration tests for identity behavior**

Create `tests/integration/identity.test.ts` using a small helper that inserts an auth user. Assert:

- `ensureCustomerRole` is idempotent;
- `actorForUser` returns the customer role and repairs a missing row;
- concurrent `findOrCreateGuestIdentity` calls for differently cased/spaced versions of one email return the same UUID;
- an already-claimed identity is returned without clearing or changing claim fields.
- `canSendMagicLink` suppresses only an unverified credential user and permits a verified credential user.

Run:

```powershell
npm run test:integration -- tests/integration/identity.test.ts
```

Expected: PASS once the identity implementation is complete.

- [ ] **Step 4: Write failing role-service integration tests**

Create `tests/integration/roles.test.ts` covering:

- an anonymous/customer actor cannot grant admin;
- an admin can grant admin to a customer exactly once;
- a successful grant and revocation append `auth.role.granted`/`auth.role.revoked` in the same transaction with redacted before/after role arrays;
- a failed transaction leaves neither the role mutation nor its audit event;
- a non-last admin can be demoted;
- the last admin cannot be demoted;
- two concurrent attempts to demote the final two admins cannot both succeed;
- the customer role cannot be removed through the service.

Expected failure: `roles.ts` does not exist.

- [ ] **Step 5: Implement serialized, audited admin-role changes**

Create `src/lib/server/auth/roles.ts` with these public contracts:

```ts
export class LastAdministratorError extends Error {
  readonly code = 'last_administrator';
}

export interface SetAdminRoleInput {
  actor: Actor;
  targetUserId: string;
  enabled: boolean;
  correlationId: string;
}

export interface UserWithRoles {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: Date;
  roles: readonly ApplicationRole[];
}

export async function setAdminRole(
  database: Database,
  input: SetAdminRoleInput
): Promise<readonly ApplicationRole[]>;

export async function listUsersWithRoles(database: Database): Promise<UserWithRoles[]>;
```

`setAdminRole` must call `requireCapability(input.actor, 'roles.manage')` before opening the transaction. Inside one `withTransaction` callback:

1. execute `select pg_advisory_xact_lock(hashtext('pale-orbit:user-roles:admin'))`;
2. verify the target auth user exists;
3. load the target's current roles;
4. for a grant, insert `admin` with `grantedByUserId=input.actor.id` and `onConflictDoNothing`;
5. for a revocation, count current admin rows under the advisory lock and throw `LastAdministratorError` when the target is an admin and the count is one;
6. delete only the target's `admin` row when allowed;
7. append `auth.role.granted` or `auth.role.revoked`, resource type `user`, target user ID, and before/after role arrays only when state actually changed;
8. return the deterministic role list.

An idempotent no-op returns current roles without appending a misleading event. `listUsersWithRoles` may issue two bounded queries and group in TypeScript; avoid N+1 queries.

- [ ] **Step 6: Run identity/policy/role tests and commit**

```powershell
npm run test:unit -- src/lib/server/auth/identity.test.ts src/lib/server/auth/admin-policy.test.ts
npm run test:integration -- tests/integration/identity.test.ts tests/integration/roles.test.ts
npm run check
npm run lint
git add src/lib/server/auth tests/integration
git commit -m "feat: add guest identity and audited roles"
```

## Task 5: Create the shared Better Auth server, durable callbacks, and integration coverage

**Files:**
- Create: `src/lib/server/auth/options.ts`
- Create: `src/lib/server/auth/runtime.ts`
- Modify: `src/lib/server/auth/schema-config.ts`
- Create: `tests/integration/auth.test.ts`
- Create: `tests/integration/email.test.ts`
- Modify: `compose.test.yaml`
- Modify: `scripts/with-test-database.ts`
- Modify: `playwright.config.ts`

- [ ] **Step 1: Start disposable Mailpit with dynamic loopback ports**

Add a `mailpit` service to `compose.test.yaml` using the same pinned image and health check as development. Publish container ports 1025 and 8025 to Docker-assigned ports on `127.0.0.1`; do not use fixed test ports.

In `scripts/with-test-database.ts`, capture both ports after Compose is healthy and add this complete test configuration:

```ts
AUTH_SECRET: 'test-only-auth-secret-at-least-thirty-two-bytes',
AUTH_SESSION_EXPIRES_SECONDS: '3600',
AUTH_VERIFICATION_EXPIRES_SECONDS: '600',
AUTH_RESET_EXPIRES_SECONDS: '600',
AUTH_MAGIC_EXPIRES_SECONDS: '600',
AUTH_RATE_LIMIT_WINDOW_SECONDS: '60',
AUTH_RATE_LIMIT_MAX: '100',
AUTH_LOGIN_RATE_LIMIT_MAX: '5',
AUTH_EMAIL_RATE_LIMIT_MAX: '3',
SMTP_HOST: '127.0.0.1',
SMTP_PORT: smtpPort,
SMTP_SECURE: 'false',
SMTP_REQUIRE_TLS: 'false',
SMTP_FROM: 'Pale Orbit Test <books@paleorbit.test>',
SMTP_CONNECTION_TIMEOUT_MS: '5000',
SMTP_GREETING_TIMEOUT_MS: '5000',
SMTP_SOCKET_TIMEOUT_MS: '10000',
MAILPIT_HTTP_URL: `http://127.0.0.1:${mailpitHttpPort}`
```

Pass the same fields through `playwright.config.ts`'s web server environment. `MAILPIT_HTTP_URL` is test orchestration data and must not enter `ApplicationConfig`.

- [ ] **Step 2: Write failing Better Auth integration tests**

Create `tests/integration/auth.test.ts`. Construct a test auth instance from the forthcoming shared factory, issue real `Request` objects to `auth.handler`, and verify:

- `POST /api/auth/sign-up/email` creates UUID-backed user/account records, an idempotent customer role, a verification record, and a pending verification-email outbox/job pair, but no usable session before verification;
- consuming the verification link once creates a session, its second use fails, and the resulting cookie is HTTP-only, SameSite Lax, and not Secure for the HTTP test origin;
- sign-out invalidates the session;
- email/password sign-in accepts the registered password and rejects a wrong password without exposing whether an arbitrary address exists;
- configured login rate limiting returns 429 after the configured bound from one test IP;
- reset requests and eligible magic requests insert Better Auth verification state and a pending `email.auth.v1` outbox/job pair;
- requesting magic for an existing unverified credential account produces no magic email, a verification resend produces a verification email under the same database-backed email rate bound, and completing verification preserves password sign-in;
- URLs saved inside the outbox point back to the configured test origin and the correct auth flow;
- consuming a reset token once succeeds, its second use fails, and all prior sessions are revoked;
- consuming a magic link once signs in and its second use fails.

Use a unique email and source IP per rate-limit test. Do not query or print credential hashes or verification token values outside the narrow assertion that obtains a link from the queued test message.

Run the focused integration file. Expected: FAIL because the shared server does not exist.

- [ ] **Step 3: Implement one shared Better Auth option factory**

Create `src/lib/server/auth/options.ts`. Its dependencies are:

```ts
export interface AuthServerDependencies {
  database: Database;
  config: Pick<ApplicationConfig, 'environment' | 'origin' | 'auth'>;
  queueVerificationEmail(input: QueueAuthEmailInput): Promise<void>;
  queueResetEmail(input: QueueAuthEmailInput): Promise<void>;
  queueMagicEmail(input: QueueAuthEmailInput): Promise<void>;
  canSendMagicLink(email: string): Promise<boolean>;
  onUserCreated(userId: string): Promise<void>;
  additionalPlugins?: readonly BetterAuthPlugin[];
}
```

Export `createAuthServer(dependencies)` and construct `betterAuth` with the Task 3 options, plus:

```ts
database: drizzleAdapter(dependencies.database, {
  provider: 'pg',
  schema
}),
databaseHooks: {
  user: {
    create: {
      before: async (candidate) => ({
        data: { ...candidate, email: normalizeEmailAddress(candidate.email) }
      }),
      after: async (created) => dependencies.onUserCreated(created.id)
    }
  }
},
emailVerification: {
  expiresIn: dependencies.config.auth.verificationExpiresIn,
  sendOnSignUp: true,
  autoSignInAfterVerification: true,
  sendVerificationEmail: async ({ user, url }) => {
    await dependencies.queueVerificationEmail({
      template: 'auth.email-verification',
      to: normalizeEmailAddress(user.email),
      recipientName: user.name || user.email,
      actionUrl: url,
      expiresInSeconds: dependencies.config.auth.verificationExpiresIn
    });
  }
},
emailAndPassword: {
  // retain every Task 3 option
  sendResetPassword: async ({ user, url }) => {
    await dependencies.queueResetEmail({
      template: 'auth.password-reset',
      to: normalizeEmailAddress(user.email),
      recipientName: user.name || user.email,
      actionUrl: url,
      expiresInSeconds: dependencies.config.auth.resetExpiresIn
    });
  }
},
plugins: [
  magicLink({
    expiresIn: dependencies.config.auth.magicExpiresIn,
    disableSignUp: false,
    sendMagicLink: async ({ email, url }) => {
      if (!(await dependencies.canSendMagicLink(email))) return;
      await dependencies.queueMagicEmail({
        template: 'auth.magic-link',
        to: normalizeEmailAddress(email),
        recipientName: email,
        actionUrl: url,
        expiresInSeconds: dependencies.config.auth.magicExpiresIn
      });
    }
  }),
  ...(dependencies.additionalPlugins ?? [])
]
```

Use the package's exported plugin type; if its exact name differs, infer the array element type from `BetterAuthOptions['plugins']` without introducing `any`. Do not use experimental joins in this plan.

- [ ] **Step 4: Build the web runtime and reduce schema config to the factory**

Create `src/lib/server/auth/runtime.ts` as a cached singleton. It must obtain application config and database runtime, pass callbacks that call `queueAuthEmail(database, input)`, pass `canSendMagicLink(database, email)`, pass `ensureCustomerRole(database, userId)`, and add `sveltekitCookies(getRequestEvent)` as the final plugin.

Replace the duplicated options in `schema-config.ts` with `createAuthServer`, inert email callbacks, `canSendMagicLink: async () => true`, and an inert user-created callback. Do not include `sveltekitCookies` in the CLI instance.

Run:

```powershell
npm run auth:schema
git diff --exit-code -- src/lib/server/db/schema/auth.ts
```

Expected: no schema diff. A diff means the temporary generator and shared runtime options drifted; resolve it before continuing.

- [ ] **Step 5: Add a real SMTP/Outbox/Mailpit integration test**

Create `tests/integration/email.test.ts` that:

1. calls `queueAuthEmail` with a unique recipient;
2. claims and invokes the existing outbox dispatch job using `createAuthEmailHandler` and the real Nodemailer adapter;
3. polls `${MAILPIT_HTTP_URL}/view/latest.txt?query=to:<encoded recipient>` for up to five seconds;
4. asserts the subject/purpose, expiry, and action link are present;
5. asserts the outbox record is delivered;
6. invokes the handler again for the already-delivered message and proves Mailpit still has one matching message.

Also use Mailpit chaos or a stub transport integration boundary to prove a transient SMTP error records a safe generic failure and leaves the job retryable without leaking the recipient or body.

- [ ] **Step 6: Run integration gates and commit**

```powershell
npm run test:integration -- tests/integration/auth.test.ts tests/integration/email.test.ts
npm run auth:info
npm run db:check
npm run check
npm run lint
git add compose.test.yaml scripts/with-test-database.ts playwright.config.ts src/lib/server/auth tests/integration
git commit -m "feat: integrate better auth and durable email"
```

Expected: Better Auth integration and real SMTP delivery pass against disposable PostgreSQL and Mailpit, schema generation is stable, and static gates pass.

## Task 6: Add the explicit, idempotent first-administrator tool

**Files:**
- Create: `src/lib/server/auth/bootstrap-config.ts`
- Create: `src/lib/server/auth/bootstrap-admin.ts`
- Create: `src/lib/server/auth/bootstrap-admin.test.ts`
- Create: `tests/integration/bootstrap-admin.test.ts`
- Create: `src/bootstrap-admin.ts`
- Modify: `vite.services.config.ts`
- Modify: `Dockerfile`

- [ ] **Step 1: Write failing bootstrap configuration tests**

In `bootstrap-config.ts`, the eventual public contract is:

```ts
export interface BootstrapAdminConfig {
  email: string;
  name: string;
  password: string;
}

export function loadBootstrapAdminConfig(
  source: EnvironmentValues,
  readSecretFile?: SecretFileReader
): BootstrapAdminConfig;
```

Write tests first proving email is normalized, name is trimmed/nonempty, password length is 12–128, `_FILE` is supported for the password, direct-plus-file is rejected, and no bootstrap setting is part of ordinary `ApplicationConfig`.

Run the focused unit test. Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement narrow bootstrap configuration**

Implement the loader with `readRequiredSetting` for `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_NAME`, and `BOOTSTRAP_ADMIN_PASSWORD`, then a strict Zod schema. This loader is called only by the bootstrap entry point. Web, worker, and migration processes must not require or receive the bootstrap password.

- [ ] **Step 3: Write failing bootstrap-service integration tests**

Create tests for a `bootstrapFirstAdministrator` service that prove:

- a new normalized email creates one email-verified Better Auth user/credential account plus customer/admin roles without sending bootstrap mail;
- an existing verified email receives missing roles without changing its password hash;
- an existing unverified email is refused without granting admin, and the safe error tells the operator to verify the account first;
- a second identical run makes no durable change and does not add a duplicate success event;
- the successful first change appends `auth.admin.bootstrapped` with system actor `bootstrap-admin`, user resource ID, no email/password/token in audit details, and the caller's correlation ID;
- a forced audit failure rolls back role grants (but does not claim that Better Auth's separately committed new user was rolled back).

Run the test. Expected: FAIL because the service does not exist.

- [ ] **Step 4: Implement the bootstrap service**

Create `src/lib/server/auth/bootstrap-admin.ts`:

```ts
export interface BootstrapFirstAdministratorInput {
  auth: ReturnType<typeof createAuthServer>;
  database: Database;
  email: string;
  name: string;
  password: string;
  correlationId: string;
}

export interface BootstrapFirstAdministratorResult {
  userId: string;
  createdUser: boolean;
  grantedAdmin: boolean;
}

export async function bootstrapFirstAdministrator(
  input: BootstrapFirstAdministratorInput
): Promise<BootstrapFirstAdministratorResult>;
```

Normalize the email and look up the generated `user` table first. If absent, call `auth.api.signUpEmail({ body: { email, name, password } })` on the bootstrap auth instance whose verification callback is inert; if present, never call a password-changing API. Refuse a pre-existing unverified account with a typed safe error before granting roles. Then open a transaction, take the same admin-role advisory lock as normal role changes, mark only a newly bootstrap-created user email-verified, add customer/admin with conflict-ignore semantics, and append the system audit event only when admin was newly granted. The runbook directs an operator with a pre-existing unverified account to complete a normal magic-link verification, reset a password if desired, and rerun bootstrap.

Do not accept a bootstrap password on the command line, and do not print it, its hash, the auth response, or environment contents.

- [ ] **Step 5: Create the process entry point and production bundle**

Create `src/bootstrap-admin.ts` as a thin process owner:

1. load ordinary application config and narrow bootstrap config from `process.env` (the ordinary config currently validates auth, database, jobs, and SMTP even though bootstrap sends no mail);
2. create a database client;
3. create a Better Auth server without SvelteKit cookies and with inert email callbacks;
4. call `bootstrapFirstAdministrator` with `crypto.randomUUID()` correlation ID;
5. log only `{ userId, createdUser, grantedAdmin }`;
6. set a nonzero exit code on error with only the error name/safe message;
7. always close the database client.

Add `bootstrap-admin: 'src/bootstrap-admin.ts'` to the existing service-build entries in `vite.services.config.ts`. Confirm the runtime stage already copies the whole `build/services` directory; modify `Dockerfile` only if that bundle would otherwise be omitted.

- [ ] **Step 6: Verify and commit the tool**

```powershell
npm run test:unit -- src/lib/server/auth/bootstrap-admin.test.ts
npm run test:integration -- tests/integration/bootstrap-admin.test.ts
npm run build:services
Test-Path build/services/bootstrap-admin.js
git add src/lib/server/auth src/bootstrap-admin.ts vite.services.config.ts Dockerfile tests/integration/bootstrap-admin.test.ts
git commit -m "feat: add first administrator bootstrap tool"
```

Expected: tests pass and the production service bundle exists.

## Task 7: Replace the prototype session with server-resolved Better Auth flows

**Files:**
- Modify: `src/hooks.server.ts`
- Modify: `src/app.d.ts`
- Modify: `src/lib/types/auth.ts`
- Create: `src/lib/auth/client.ts`
- Delete: `src/lib/stores/session.svelte.ts`
- Create: `src/routes/+layout.server.ts`
- Modify: `src/routes/+layout.svelte`
- Modify: `src/lib/components/Header.svelte`
- Modify: `src/lib/components/AuthModal.svelte`
- Create: `src/routes/reset-password/+page.svelte`

- [ ] **Step 1: Define narrow application session types**

Replace the prototype type with serializable project types:

```ts
export interface SessionUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  roles: readonly ApplicationRole[];
}

export interface SessionRecord {
  id: string;
  userId: string;
  expiresAt: Date;
}
```

Retain the neutral `ApplicationRole` export introduced in Task 4. Do not duplicate the union or import a server module into browser code.

Update `src/app.d.ts`:

```ts
interface Locals {
  user: SessionUser | null;
  session: SessionRecord | null;
  actor: Actor;
}
```

- [ ] **Step 2: Mount Better Auth and populate locals server-side**

Refactor `src/hooks.server.ts` so `init` still validates config and initializes the database, while every request starts with null session/user and anonymous actor. Preserve the existing maintenance response before doing session work. When not building:

```ts
const auth = getAuthServer();
const resolved = await auth.api.getSession({ headers: event.request.headers });

if (resolved) {
  const actor = await actorForUser(getDatabaseClient().db, resolved.user.id);
  event.locals.user = {
    id: resolved.user.id,
    name: resolved.user.name,
    email: resolved.user.email,
    emailVerified: resolved.user.emailVerified,
    roles: actor.roles
  };
  event.locals.session = {
    id: resolved.session.id,
    userId: resolved.session.userId,
    expiresAt: resolved.session.expiresAt
  };
  event.locals.actor = actor;
}

return svelteKitHandler({ event, resolve, auth, building });
```

Import `building` from `$app/environment`. When `building` is true, avoid touching runtime environment/database state and let SvelteKit resolve route analysis safely. Remove all reads of `po_session`.

- [ ] **Step 3: Send the initial session through server layout data**

Create `src/routes/+layout.server.ts`:

```ts
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => ({ user: locals.user });
```

Use the generated `LayoutData` type in `+layout.svelte` props and pass `data.user` to the header. Never send the session record or cookie/token to browser layout data.

- [ ] **Step 4: Create the Svelte Better Auth client**

Create `src/lib/auth/client.ts`:

```ts
import { createAuthClient } from 'better-auth/svelte';
import { magicLinkClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  plugins: [magicLinkClient()]
});
```

Do not set a second hard-coded base URL; same-origin `/api/auth` is the browser contract.

- [ ] **Step 5: Replace the fake modal with five real flows**

Rewrite `AuthModal.svelte` with modes `signin`, `register`, `verify-request`, `magic`, and `reset-request`. Keep the existing modal dimensions, typography, scrim dismissal, inputs, error/success styling, and keyboard-accessible native form behavior. Remove both OAuth buttons, the `oauth` function, fake comments, and the session store import.

The form actions must normalize the email in the browser and call exactly:

```ts
await authClient.signIn.email({ email, password, rememberMe: true });
await authClient.signUp.email({ email, password, name, callbackURL: '/library' });
await authClient.sendVerificationEmail({ email, callbackURL: '/library' });
await authClient.signIn.magicLink({ email, callbackURL: '/library' });
await authClient.requestPasswordReset({ email, redirectTo: '/reset-password' });
```

For registration, require a trimmed display name and matching password confirmation with a minimum length of 12. A successful registration stays signed out and shows a generic “check your email to finish registration” state with a route to resend verification. Verification, reset, and magic requests all show a generic sent state that does not reveal whether the email exists and do not claim a session exists before a link is followed. Explain non-specifically that password accounts must finish verification before magic-link sign-in; the server suppression remains authoritative. Disable submission while pending and render Better Auth's safe error message for password sign-in/registration without dumping response objects. On immediate password sign-in success, close and call an `onauthenticated` callback so the layout can refresh via `invalidateAll()`; verification and magic links refresh through their full-page redirects.

- [ ] **Step 6: Make the header session-aware and add sign-out**

Update `Header.svelte` to accept the SSR `user` prop, create `const liveSession = authClient.useSession()`, and derive the active user from the live session when available with SSR data as the initial fallback. The account control must:

- open the modal when signed out;
- show the normalized email when signed in;
- expose a separate `Sign out` button that awaits `authClient.signOut()` and then calls `invalidateAll()`;
- show an `Admin` navigation link only when the SSR application user roles include `admin` (authorization still remains server-side).

Delete `src/lib/stores/session.svelte.ts` and remove every import of it. Do not migrate the old `paleorbit.session` localStorage value; it becomes inert and may be removed manually.

- [ ] **Step 7: Add the reset-password page**

Create `src/routes/reset-password/+page.svelte`. Read `token` and `error` from the `$page.url.searchParams`, render an invalid/expired state when appropriate, require a 12-character matching new password and confirmation, then call:

```ts
await authClient.resetPassword({ token, newPassword });
```

On success, clear password fields and show a link that opens or returns to sign-in. Never write the token to logs, localStorage, analytics, or visible error text.

- [ ] **Step 8: Run static/unit gates and commit**

```powershell
rg -n "po_session|paleorbit\.session|stores/session|Continue with Google|Continue with Apple|signIn\('" src
npm run test:unit
npm run check
npm run lint
git add src/hooks.server.ts src/app.d.ts src/lib/types/auth.ts src/lib/auth src/lib/components src/lib/stores/session.svelte.ts src/routes
git commit -m "feat: replace prototype authentication flows"
```

Expected: the scope scan returns no prototype session or OAuth UI seam, and all gates pass.

## Task 8: Add the server-protected admin shell and audited role-management screen

**Files:**
- Create: `src/routes/admin/+layout.server.ts`
- Create: `src/routes/admin/+layout.svelte`
- Create: `src/routes/admin/+page.svelte`
- Create: `src/routes/admin/users/+page.server.ts`
- Create: `src/routes/admin/users/+page.svelte`
- Create: `src/routes/admin/users/page-server.test.ts`

- [ ] **Step 1: Write failing server-load/action tests**

Test the route modules directly with typed minimal events or through SvelteKit request integration. Prove:

- no session redirects to `/?auth=required`;
- a customer session receives 403;
- an admin session loads every admin route;
- forged form submission by a customer fails even if the browser control would be hidden;
- invalid/missing/non-UUID `userId` and invalid enabled values return 400;
- `LastAdministratorError` returns a non-sensitive 409 form failure;
- a successful action calls `setAdminRole` with the session actor and a correlation ID, then returns updated users.

Run the focused test. Expected: FAIL because the admin routes do not exist.

- [ ] **Step 2: Protect the whole route tree in the server layout**

Create `src/routes/admin/+layout.server.ts`:

```ts
import { error, redirect } from '@sveltejs/kit';
import { requireCapability, AuthorizationError } from '$lib/server/auth/admin-policy';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
  try {
    requireCapability(locals.actor, 'admin.access');
  } catch (cause) {
    if (cause instanceof AuthorizationError && cause.status === 401) {
      redirect(303, '/?auth=required');
    }
    error(403, 'Forbidden');
  }
  return { user: locals.user };
};
```

Do not depend on a client-side role check.

- [ ] **Step 3: Build the dashboard shell without future data**

Create an admin layout with navigation for `Overview`, `Users`, `Catalog`, `Audit`, and `Sales`. Only `Overview` and `Users` are active in Plan 3. Label Catalog/Audit/Sales as upcoming and do not create fake metrics or prototype financial data.

The overview page should state the current phase and link to Users. Reuse project CSS variables and responsive patterns; do not introduce a component framework.

- [ ] **Step 4: Implement server-side role management**

In `src/routes/admin/users/+page.server.ts`:

- `load` calls `requireCapability(locals.actor, 'roles.manage')` and `listUsersWithRoles`;
- the `setAdmin` action validates a strict object `{ userId: z.string().uuid(), enabled: z.enum(['true', 'false']) }`;
- correlation ID is a validated incoming `x-request-id` no longer than 200 characters, otherwise `crypto.randomUUID()`;
- the action calls `setAdminRole`, catches known authorization/not-found/last-admin errors into 401/403/404/409 safe failures, and rethrows unknown errors;
- it never trusts actor/user/role fields submitted by the browser.

Build the page as an accessible table/list with name, email, verified status, current roles, and a native POST form for grant/revoke. Disable the current administrator's revoke button only when the load data shows there is one admin, while still relying on the service invariant for safety.

- [ ] **Step 5: Run route, integration, and static gates; commit**

```powershell
npm run test:unit -- src/routes/admin/users/page-server.test.ts
npm run test:integration -- tests/integration/roles.test.ts
npm run check
npm run lint
git add src/routes/admin src/lib/components/Header.svelte
git commit -m "feat: add protected admin role management"
```

Expected: all admin access and mutation tests pass; anonymous/customer requests cannot reach protected data or actions.

## Task 9: Exercise complete browser auth flows with PostgreSQL, the worker, and Mailpit

**Files:**
- Modify: `package.json`
- Modify: `scripts/with-test-database.ts`
- Create: `tests/e2e/mailpit.ts`
- Create: `tests/e2e/auth.spec.ts`
- Create: `tests/e2e/admin.spec.ts`

- [ ] **Step 1: Extend the disposable test orchestrator with explicit opt-in services**

Teach `scripts/with-test-database.ts` to consume leading `--worker` and `--bootstrap-admin` flags before the child command. Keep integration tests worker-free by default.

When `--bootstrap-admin` is present, add these test-only values to the child environment and run `npm run admin:bootstrap:raw` once after migrations:

```ts
BOOTSTRAP_ADMIN_EMAIL: 'admin@paleorbit.test',
BOOTSTRAP_ADMIN_NAME: 'Test Administrator',
BOOTSTRAP_ADMIN_PASSWORD: 'test-admin-password-2026',
```

When `--worker` is present, spawn the worker directly with the current Node executable and `['--import', 'tsx', 'src/worker.ts']`, pass the same environment, and synchronously wait up to 15 seconds for the unique `WORKER_READY_FILE`. Fail immediately if the child exits first. In the outer `finally`, request worker termination, wait briefly for graceful shutdown, force-terminate only that known child if necessary, and then run the existing exact Compose `down --volumes --remove-orphans`. Do not use a broad process-name kill.

Update scripts:

```json
"test:e2e": "tsx scripts/with-test-database.ts --worker --bootstrap-admin npm run test:e2e:raw",
"test:e2e:headed:raw": "playwright test --headed",
"test:e2e:headed": "tsx scripts/with-test-database.ts --worker --bootstrap-admin npm run test:e2e:headed:raw",
"test:database": "npm run test:integration && npm run test:e2e"
```

Remove `test:database:raw` if nothing else references it. Running integration and E2E in separate disposable projects prevents the background worker from racing job-claiming integration tests.

- [ ] **Step 2: Create a bounded Mailpit browser-test helper**

Create `tests/e2e/mailpit.ts` with:

```ts
export async function waitForLatestTextEmail(
  recipient: string,
  timeoutMs = 10_000
): Promise<string> {
  const base = process.env.MAILPIT_HTTP_URL;
  if (!base) throw new Error('MAILPIT_HTTP_URL is required');
  const deadline = Date.now() + timeoutMs;
  const query = new URLSearchParams({ query: `to:${recipient}` });

  while (Date.now() < deadline) {
    const response = await fetch(`${base}/view/latest.txt?${query}`);
    if (response.ok) return response.text();
    if (response.status !== 404) throw new Error(`Mailpit returned ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for test email to ${recipient}`);
}

export function firstHttpLink(message: string): string {
  const link = message.match(/https?:\/\/[^\s<>]+/)?.[0];
  if (!link) throw new Error('Test email did not contain a link');
  return link;
}
```

The helper may mention the unique test recipient in an assertion error but must never print the email body/link/token.

- [ ] **Step 3: Write the end-to-end customer authentication journey**

Create `tests/e2e/auth.spec.ts` using a unique `crypto.randomUUID()` email. Through visible UI only:

1. open the modal, register with display name and a 12+ character password;
2. confirm the generic verification-sent state and that the header remains signed out, then exercise the verification resend control;
3. read the verification mail from Mailpit, navigate to its link, and confirm the redirected header shows the email;
4. revisit the verification URL in a clean context and confirm its single-use token is rejected;
5. sign out and confirm the sign-in control returns, then sign in with the password;
6. sign out, request a password reset, and confirm the generic success text;
7. read the reset mail from Mailpit, navigate to its link, set a new password, and prove the old password fails/new password succeeds;
8. sign out, request a magic link for the same verified account, read it from Mailpit, navigate to it, and confirm an authenticated header;
9. revisit the same magic-link URL in a clean context and confirm it is rejected as invalid/expired;
10. sign out and prove the new password still works after magic-link use;
11. confirm no Google/Apple/social-auth controls exist.

Keep this journey serial because it intentionally mutates one account. Do not inspect application database tables from Playwright.

- [ ] **Step 4: Write admin authorization and role-management browser tests**

Create `tests/e2e/admin.spec.ts`:

- anonymous navigation to `/admin` redirects to the public page with the auth-required marker;
- a newly registered and email-verified customer receives a 403 at `/admin` even if it directly posts the role form;
- the bootstrapped administrator can sign in, see the dashboard and users screen, grant the customer admin, and see the updated role;
- after the customer signs in again, `/admin` is available;
- the UI and server reject an attempt to remove the only remaining administrator in a setup that reaches that state.

Use separate browser contexts for the customer and administrator. Do not make tests depend on file ordering; create or locate their own uniquely named customer.

- [ ] **Step 5: Run the browser and full database gates; commit**

```powershell
npm run test:e2e
npm run test:database
npm run check
npm run lint
git add package.json package-lock.json scripts/with-test-database.ts tests/e2e
git commit -m "test: cover authentication and admin access"
```

Expected: Chromium completes password, reset, magic, and admin journeys; the worker delivers queued messages to disposable Mailpit; all containers and temporary volumes are removed afterward.

## Task 10: Wire development/production services, secrets, runbooks, and final verification

**Files:**
- Modify: `compose.dev.yaml`
- Modify: `compose.prod.yaml`
- Modify: `Dockerfile` if required by Task 6 verification
- Create: `docs/authentication-and-email.md`
- Modify: `docs/runtime-environments.md`
- Modify: `docs/database-and-workers.md`
- Modify: `README.md`
- Modify: `docs/dependency-decisions.md`

- [ ] **Step 1: Complete development Compose wiring**

For `app`, `worker`, and `migrate` in `compose.dev.yaml`, add:

```yaml
SMTP_HOST: mailpit
```

Make the worker depend on healthy Mailpit as well as PostgreSQL. Add a `bootstrap-admin` service in the `tools` profile using the development target, `npm run admin:bootstrap:raw`, the `.env` file, `DATABASE_HOST=postgres`, `SMTP_HOST=mailpit`, source/node_modules mounts, healthy PostgreSQL dependency, and `restart: "no"`.

Validate:

```powershell
$env:DEV_ENV_FILE = '.env.example'
try {
  docker compose --env-file .env.example --file compose.dev.yaml config --quiet
  docker compose --env-file .env.example --file compose.dev.yaml --profile tools config --quiet
} finally {
  Remove-Item Env:DEV_ENV_FILE -ErrorAction SilentlyContinue
}
```

- [ ] **Step 2: Add production auth/SMTP settings and process-backed secrets**

For `app`, `worker`, and `migrate` in `compose.prod.yaml`, add non-secret environment inputs for auth durations/rate limits and SMTP host/port/security/user/from/timeouts, plus:

```yaml
AUTH_SECRET_FILE: /run/secrets/auth_secret
SMTP_PASSWORD_FILE: /run/secrets/smtp_password
```

Mount `auth_secret` and `smtp_password` alongside `database_password`. Use required Compose interpolation for `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_FROM`, `SMTP_SECURE`, and `SMTP_REQUIRE_TLS`; use documented defaults only for numeric lifetime/timeout/rate-limit values.

Add a one-shot `bootstrap-admin` tools-profile service using the same immutable image and `node build/services/bootstrap-admin.js`. It receives the same validated database/auth/SMTP/job settings as the other application processes, mounts `database_password`, `auth_secret`, and `smtp_password`, plus `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_NAME`, and:

```yaml
BOOTSTRAP_ADMIN_PASSWORD_FILE: /run/secrets/bootstrap_admin_password
```

It depends only on healthy PostgreSQL, uses `no-new-privileges`, and never restarts. Ordinary app/worker/migrate services must not mount `bootstrap_admin_password`.

Define production secrets from the invoking process, not a file:

```yaml
secrets:
  database_password:
    environment: DATABASE_PASSWORD
  auth_secret:
    environment: AUTH_SECRET
  smtp_password:
    environment: SMTP_PASSWORD
  bootstrap_admin_password:
    environment: BOOTSTRAP_ADMIN_PASSWORD
```

Production still has no Mailpit service and no `env_file` entry.

- [ ] **Step 3: Validate both Compose topologies**

Run with disposable process values:

```powershell
$values = @{
  APP_IMAGE = 'pale-orbit:plan3'; ORIGIN = 'https://books.example.com';
  SITE_ADDRESS = 'books.example.com'; DATABASE_NAME = 'pale_orbit';
  DATABASE_USER = 'pale_orbit'; DATABASE_PASSWORD = 'validation-db-password';
  AUTH_SECRET = 'validation-auth-secret-at-least-thirty-two-bytes';
  SMTP_HOST = 'smtp.example.com'; SMTP_PORT = '587'; SMTP_USER = 'mailer';
  SMTP_PASSWORD = 'validation-smtp-password'; SMTP_FROM = 'Pale Orbit <books@example.com>';
  SMTP_SECURE = 'false'; SMTP_REQUIRE_TLS = 'true';
  BOOTSTRAP_ADMIN_EMAIL = 'admin@example.com'; BOOTSTRAP_ADMIN_NAME = 'Administrator';
  BOOTSTRAP_ADMIN_PASSWORD = 'validation-admin-password'
}
$values.GetEnumerator() | ForEach-Object { Set-Item "Env:$($_.Key)" $_.Value }
try {
  docker compose --file compose.prod.yaml config --quiet
  docker compose --file compose.prod.yaml --profile tools config --quiet
} finally {
  $values.Keys | ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
}
```

Expected: both configurations validate without a production `.env` file.

- [ ] **Step 4: Write the authentication and email runbook**

Create `docs/authentication-and-email.md` documenting:

- architecture and ownership of Better Auth versus project roles/guests;
- how to generate an auth secret (`openssl rand -base64 32`) without committing it;
- exact host and Compose migration/start/bootstrap commands;
- Mailpit URL and how to test registration verification, reset, and magic links;
- first-admin idempotency and the fact that an existing account's password is not changed;
- role grant/revoke and last-admin protection;
- SMTP security modes (`secure=true` for implicit TLS, otherwise `requireTls=true` for mandatory STARTTLS);
- production process environment and Compose-secret conversion;
- session/cookie/origin/rate-limit behavior;
- why magic-link delivery is suppressed until a pending password registration is verified, and how to resend verification;
- at-least-once SMTP duplicate window;
- the Better Auth token/outbox transaction boundary stated in this plan;
- safe troubleshooting using outbox/job status without printing message payloads or tokens;
- how to rerun failed email jobs only after Plan 7 adds controlled admin retry tooling.

Update `docs/runtime-environments.md`, `docs/database-and-workers.md`, and `README.md` with:

```powershell
# Host-run
npm run db:migrate
npm run admin:bootstrap
npm run dev
npm run worker:watch

# Fully containerized development
docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm migrate
docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm bootstrap-admin
docker compose --env-file .env --file compose.dev.yaml up --build --wait
```

For production, document exporting values into the deployment process, then running migration, bootstrap once, and startup. Never show real credentials or suggest a production `.env` file.

- [ ] **Step 5: Run the complete clean application gate**

Ensure no existing dev server owns 4173, then run:

```powershell
npm ci
npm run auth:schema
git diff --exit-code -- src/lib/server/db/schema/auth.ts
npm run db:check
npm run verify
npm ls --depth=0
npm audit --audit-level=high
npm outdated --json
```

Expected:

- the exact Better Auth CLI regenerates a byte-for-byte unchanged schema;
- Drizzle schema/migrations are consistent;
- Svelte/TypeScript checking and ESLint pass;
- all unit tests pass without Docker;
- disposable PostgreSQL/Mailpit integration tests pass;
- Chromium passes registration verification, sign-in/out, reset, magic, and admin journeys with the real worker;
- web, worker, migration, and bootstrap-admin bundles build;
- the dependency tree has no peer conflict;
- no unaccepted high/critical advisory remains;
- every outdated result is either intentionally pinned and documented with a compatibility/removal condition or updated within scope.

- [ ] **Step 6: Build and smoke the containerized development stack**

Use an ignored `.env` derived from `.env.example` with a changed bootstrap password, then run:

```powershell
docker compose --env-file .env --file compose.dev.yaml down --remove-orphans
docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm migrate
docker compose --env-file .env --file compose.dev.yaml --profile tools run --rm bootstrap-admin
docker compose --env-file .env --file compose.dev.yaml up --build --detach --wait

Invoke-WebRequest http://localhost:5173/health/live -UseBasicParsing
Invoke-WebRequest http://localhost:5173/health/ready -UseBasicParsing
Invoke-WebRequest http://localhost:8025/api/v1/info -UseBasicParsing
docker compose --env-file .env --file compose.dev.yaml ps
docker compose --env-file .env --file compose.dev.yaml logs --tail 100 app worker
```

Manually complete one sign-in plus one reset or magic-link flow through Mailpit, then stop without deleting developer data:

```powershell
docker compose --env-file .env --file compose.dev.yaml down
```

- [ ] **Step 7: Build the production image and inspect scope/hygiene**

```powershell
docker build --tag pale-orbit:plan3 --target runtime .
docker run --rm pale-orbit:plan3 test -f build/services/bootstrap-admin.js
rg -n "po_session|paleorbit\.session|MAIL_API_KEY|Continue with Google|Continue with Apple" src .env.example compose*.yaml docs
rg -n "redis|bullmq|ioredis|@aws-sdk|signIn\.social|socialProviders" package.json src
rg -n "password|token|secret|actionUrl" src/lib/server/audit src/lib/server/auth src/lib/server/email
git diff --check
git status --short
```

Expected:

- runtime image contains every service bundle and runs as `node`;
- prototype auth/OAuth/legacy mail scans return no match except historical plan/spec documentation where explicitly expected;
- Redis/S3/social-auth scope scan returns no runtime dependency or implementation;
- the sensitive-field scan shows only validated configuration, redaction keys, and intentional email construction—not logs or audit payloads;
- no `.env`, generated report, worker-ready file, Mailpit data, or database volume is tracked.

- [ ] **Step 8: Commit operations documentation and final verification state**

```powershell
git add compose.dev.yaml compose.prod.yaml Dockerfile README.md docs/authentication-and-email.md docs/runtime-environments.md docs/database-and-workers.md docs/dependency-decisions.md
git commit -m "docs: document authentication and email operations"
git status --short
```

Expected: final status is clean.

## Plan 3 completion contract

Plan 3 is complete only when all of the following are true:

- [ ] Better Auth 1.6.26, its exact CLI, Nodemailer, and declarations are locked, compatible, reproducible, and documented; there is no unexplained high/critical advisory.
- [ ] Better Auth's generated Drizzle schema is reproducible and includes UUID-backed user/account/session/verification plus PostgreSQL rate-limit persistence.
- [ ] Application roles and guest identities use constrained project-owned tables, normalized emails, UUIDs, UTC timestamps, and safe foreign keys.
- [ ] Email/password registration requires single-use email verification, then sign-in/sign-out uses Better Auth's native scrypt credentials and database sessions; prototype localStorage/cookie identity is gone.
- [ ] Registration verification, password-reset, and magic-link requests create short-lived, single-use verification state and durably enqueue versioned email before reporting success.
- [ ] An unverified credential account cannot receive a magic link that would remove its pending password; verification resend is available and rate-limited.
- [ ] The worker validates, renders, and sends queued messages through the provider-neutral SMTP contract; Mailpit integration tests prove delivery and replay suppression.
- [ ] Secure production cookies, HTTP-only/SameSite behavior, trusted-origin/CSRF checks, session expiry, and PostgreSQL-backed endpoint rate limits are configured and tested.
- [ ] Every authenticated user maps to a project actor with a durable customer role, and role absence is safely repaired.
- [ ] Guest identities can be created/found race-safely by normalized email, but no order claiming or entitlement work has leaked from Plan 6.
- [ ] First-admin bootstrap is explicit, password-from-environment/secret only, idempotent, bundled into the immutable image, and audited without exposing sensitive values.
- [ ] Later admin grants/revocations require an existing admin, are transactionally audited, serialize last-admin protection, and cannot remove the customer role.
- [ ] Every `/admin` route/action performs server-side authorization; anonymous and customer access attempts are covered, and role management works through the dashboard.
- [ ] The dashboard shows no fabricated catalog, audit, job, sales, fee, or payout data owned by later phases.
- [ ] Unit, real-PostgreSQL/Mailpit integration, Playwright, schema-generation, migration, Compose, image, dependency, and hygiene gates all pass.
- [ ] Development uses `.env` plus Mailpit; production uses invoking-process values converted to Compose secrets and contains no production `.env` or Mailpit service.
- [ ] Production remains intentionally in maintenance mode.

## Plan 4 handoff

Plan 4 may begin after this contract passes and the branch is reviewed. It should reuse the authenticated session actor, server-side admin capability checks, protected dashboard layout, role model, worker/outbox registration pattern, audit transactions, configuration/secret loader, disposable service harness, and immutable service image. It will add the provider-neutral storage interface, local private volume, explicit unimplemented S3 adapter, secure EPUB/CBZ ingestion, immutable retained revisions, private review, preview boundaries, publication/replacement/withdrawal/rollback, and the first detailed admin audit views. It must not weaken the last-admin, session, email, or maintenance-mode guarantees established here.

## Authoritative references

- [Better Auth SvelteKit integration](https://better-auth.com/docs/integrations/svelte-kit)
- [Better Auth Drizzle adapter](https://better-auth.com/docs/adapters/drizzle)
- [Better Auth CLI](https://better-auth.com/docs/concepts/cli)
- [Better Auth email/password authentication](https://better-auth.com/docs/authentication/email-password)
- [Better Auth magic-link plugin](https://better-auth.com/docs/plugins/magic-link)
- [Better Auth database and UUID generation](https://better-auth.com/docs/concepts/database)
- [Better Auth database-backed rate limits](https://better-auth.com/docs/concepts/rate-limit)
- [Nodemailer SMTP transport](https://nodemailer.com/smtp)
- [Mailpit integration testing](https://mailpit.axllent.org/docs/integration/)
- [Mailpit API](https://mailpit.axllent.org/docs/api-v1/)
- [SvelteKit hooks](https://svelte.dev/docs/kit/hooks)
- [SvelteKit form actions](https://svelte.dev/docs/kit/form-actions)
- [PostgreSQL advisory locks](https://www.postgresql.org/docs/18/explicit-locking.html#ADVISORY-LOCKS)
- [Docker Compose secrets](https://docs.docker.com/reference/compose-file/secrets/)
