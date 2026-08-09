import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { normalizeGeneratedAuthSchema } from '../src/lib/server/auth/normalize-schema';

const schemaPath = resolve('src/lib/server/db/schema/auth.ts');
const source = await readFile(schemaPath, 'utf8');
const normalized = normalizeGeneratedAuthSchema(source);

if (normalized !== source) {
  await writeFile(schemaPath, normalized, 'utf8');
}
