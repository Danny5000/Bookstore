import { Client } from 'pg';

interface E2EDatabase {
  grantEntitlement(email: string, titleId: string): Promise<void>;
  revokeEntitlement(email: string, titleId: string): Promise<void>;
  close(): Promise<void>;
}

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1']);

function configuredClient(): Client {
  const host = process.env.DATABASE_HOST ?? '127.0.0.1';
  const database = process.env.DATABASE_NAME ?? 'pale_orbit_test';
  if (!loopbackHosts.has(host) || !/(?:^|_)test(?:$|_)/u.test(database)) {
    throw new Error(
      `E2E database helpers refuse host=${host} database=${database}; expected a loopback test database`
    );
  }
  return new Client({
    host,
    port: Number(process.env.DATABASE_PORT ?? '5432'),
    database,
    user: process.env.DATABASE_USER ?? 'pale_orbit_test',
    password: process.env.DATABASE_PASSWORD ?? 'pale_orbit_test_only'
  });
}

export async function openE2EDatabase(): Promise<E2EDatabase> {
  const client = configuredClient();
  await client.connect();

  async function userId(email: string): Promise<string> {
    const result = await client.query<{ id: string }>(
      'select id from "user" where lower(email) = lower($1) and email_verified = true',
      [email.trim()]
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error(`No verified E2E user exists for ${email}`);
    return id;
  }

  return {
    async grantEntitlement(email, titleId) {
      const id = await userId(email);
      await client.query(
        `insert into entitlements (user_id, title_id)
         values ($1, $2)
         on conflict (user_id, title_id) do update
         set revoked_at = null, granted_at = clock_timestamp(), updated_at = clock_timestamp()`,
        [id, titleId]
      );
    },
    async revokeEntitlement(email, titleId) {
      const id = await userId(email);
      await client.query(
        `update entitlements
         set revoked_at = clock_timestamp(), updated_at = clock_timestamp()
         where user_id = $1 and title_id = $2 and revoked_at is null`,
        [id, titleId]
      );
    },
    async close() {
      await client.end();
    }
  };
}
