import { existsSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { loadApplicationConfig } from '$lib/server/config/load';
import * as schema from '$lib/server/db/schema';
import { createAuthServer } from './options';

const environmentFile = existsSync('.env') ? '.env' : '.env.example';
process.loadEnvFile(environmentFile);

const config = loadApplicationConfig(process.env);
const pool = new Pool({
  host: config.database.host,
  port: config.database.port,
  database: config.database.name,
  user: config.database.user,
  password: config.database.password,
  max: 1,
  allowExitOnIdle: true
});
const database = drizzle({ client: pool, schema });

export const auth = createAuthServer({
  database,
  config,
  queueVerificationEmail: async () => undefined,
  queueResetEmail: async () => undefined,
  queueMagicEmail: async () => undefined,
  canSendMagicLink: async () => true,
  onUserCreated: async () => undefined
});
