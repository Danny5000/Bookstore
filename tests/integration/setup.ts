import { afterAll } from 'vitest';
import { databaseClient } from './database';

afterAll(async () => {
  await databaseClient.close();
});
