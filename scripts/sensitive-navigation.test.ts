import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as mailpit from '../tests/e2e/mailpit';

type SensitiveNavigator = <Result>(
  page: { goto(url: string): Promise<Result> },
  actionUrl: string
) => Promise<Result>;

const e2eRoot = fileURLToPath(new URL('../tests/e2e/', import.meta.url));
const firstHttpLinkAssignment =
  /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*firstHttpLink\s*\(/gu;

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function firstHttpLinkVariables(source: string): string[] {
  return [...source.matchAll(firstHttpLinkAssignment)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined);
}

function directSensitiveNavigations(source: string): string[] {
  const direct = source.match(/\.goto\s*\(\s*firstHttpLink\s*\(/u)
    ? ['firstHttpLink(...)']
    : [];
  for (const name of firstHttpLinkVariables(source)) {
    const escaped = escapeRegularExpression(name);
    if (new RegExp(`\\.goto\\s*\\(\\s*${escaped}\\s*(?:,|\\))`, 'u').test(source)) {
      direct.push(name);
    }
  }
  return direct;
}

function usesSanitizedNavigation(source: string, name: string): boolean {
  const escaped = escapeRegularExpression(name);
  return new RegExp(
    `navigateSensitiveAction\\s*\\(\\s*[^,\\n]+,\\s*${escaped}\\s*\\)`,
    'u'
  ).test(source);
}

describe('sensitive Playwright navigation', () => {
  it('rethrows navigation failures without the action URL, token, or original cause', async () => {
    const navigate = (mailpit as typeof mailpit & {
      navigateSensitiveAction?: SensitiveNavigator;
    }).navigateSensitiveAction;

    expect(navigate).toBeTypeOf('function');
    if (!navigate) return;

    const actionUrl = 'http://127.0.0.1:4173/api/auth/action?token=private-one-use-token';
    const original = new Error(`page.goto failed at ${actionUrl}`);
    let failure: unknown;
    try {
      await navigate({ goto: async () => { throw original; } }, actionUrl);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('Sensitive action navigation failed');
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(String(failure)).not.toContain(actionUrl);
    expect(String(failure)).not.toContain('private-one-use-token');
    expect(failure).not.toBe(original);
  });

  it('routes every one-use email action through the sanitized helper', async () => {
    const files = (await readdir(e2eRoot, { recursive: true }))
      .filter((file) => file.endsWith('.ts'))
      .sort();
    for (const file of files) {
      const source = await readFile(join(e2eRoot, file), 'utf8');
      const variables = firstHttpLinkVariables(source);
      expect(directSensitiveNavigations(source), file).toEqual([]);
      for (const variable of variables) {
        expect(usesSanitizedNavigation(source, variable), `${file}:${variable}`).toBe(true);
      }
    }
  });

  it('detects direct navigation for arbitrary firstHttpLink variable names', () => {
    const futureAction = `
      const recoveryUrl = firstHttpLink(message);
      await page.goto(recoveryUrl);
    `;

    expect(directSensitiveNavigations(futureAction)).toEqual(['recoveryUrl']);
  });
});
