import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Database } from './client';

export async function migrateDatabase(
  database: Database,
  migrationsFolder = 'drizzle'
): Promise<void> {
  await migrate(database, { migrationsFolder });
}
