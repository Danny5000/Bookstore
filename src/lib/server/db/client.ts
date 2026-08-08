import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { DatabaseConfig } from '$lib/server/config/schema';

export type Database = NodePgDatabase;

export interface DatabaseClient {
  readonly db: Database;
  readonly pool: Pool;
  close(): Promise<void>;
}

export function createDatabaseClient(config: DatabaseConfig): DatabaseClient {
  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.name,
    user: config.user,
    password: config.password,
    max: config.poolMax,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    application_name: 'pale-orbit'
  });

  pool.on('error', (error) => {
    console.error('[database] idle client error', { name: error.name });
  });

  return {
    db: drizzle({ client: pool }),
    pool,
    close: () => pool.end()
  };
}
