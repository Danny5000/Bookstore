import type { Database } from './client';

type TransactionCallback = Parameters<Database['transaction']>[0];
export type DatabaseTransaction = Parameters<TransactionCallback>[0];
export type DatabaseExecutor = Database | DatabaseTransaction;

export function withTransaction<T>(
  database: Database,
  work: (transaction: DatabaseTransaction) => Promise<T>
): Promise<T> {
  return database.transaction(work);
}
