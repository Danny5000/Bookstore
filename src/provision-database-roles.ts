import { Pool } from 'pg';
import { ConfigurationError } from '$lib/server/config/read-setting';
import {
  loadDatabaseRoleProvisionConfig,
  provisionDatabaseRoles
} from '$lib/server/db/database-role-provision';

let pool: Pool | undefined;

try {
  const config = loadDatabaseRoleProvisionConfig(process.env);
  pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.ownerUser,
    password: config.ownerPassword,
    max: 1,
    connectionTimeoutMillis: config.connectionTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    application_name: 'pale-orbit-role-provision'
  });
  await provisionDatabaseRoles({
    query: async (text, values) => pool!.query(text, values ? [...values] : undefined)
  }, config);
  console.info('[database-role-provision] complete');
} catch (error: unknown) {
  console.error('[database-role-provision] failed', {
    name: error instanceof Error ? error.name : 'UnknownError',
    message: error instanceof ConfigurationError
      ? error.message
      : 'Database role provision failed'
  });
  process.exitCode = 1;
} finally {
  await pool?.end();
}
