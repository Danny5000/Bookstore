import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const financialRoot = 'src/lib/server/commerce/financial';
const leafPath = `${financialRoot}/projection-authority.ts`;
const rebasePath = `${financialRoot}/rebase.ts`;
const publicAuthorityExports = [
  'FinancialProjectionAuthority',
  'loadFinancialProjectionAuthority',
  'lockFinancialProjectionAuthority',
  'lockFinancialProjectionEnrollment'
] as const;
const ownedAuthorityDeclarations = [
  ...publicAuthorityExports,
  'canonicalFinancialProjectionAuthority'
] as const;
const leafDependencies = [
  '$lib/server/db/transaction',
  './errors',
  'drizzle-orm'
] as const;
const productionConsumers = new Map([
  [`${financialRoot}/rebase.ts`, './projection-authority'],
  [`${financialRoot}/ledger.ts`, './projection-authority'],
  [`${financialRoot}/sources/refund.ts`, '../projection-authority'],
  [`${financialRoot}/sources/dispute.ts`, '../projection-authority'],
  [`${financialRoot}/payouts/repository.ts`, '../projection-authority'],
  [`${financialRoot}/scans/repository.ts`, '../projection-authority'],
  [
    `${financialRoot}/refund-review/corrections.ts`,
    '$lib/server/commerce/financial/projection-authority'
  ],
  [
    `${financialRoot}/refund-review/finalize.ts`,
    '$lib/server/commerce/financial/projection-authority'
  ]
] as const);
const productionAuthorityNames = new Map<string, readonly string[]>([
  [`${financialRoot}/rebase.ts`, [
    'lockFinancialProjectionAuthority',
    'lockFinancialProjectionEnrollment'
  ]],
  [`${financialRoot}/ledger.ts`, [
    'FinancialProjectionAuthority',
    'loadFinancialProjectionAuthority',
    'lockFinancialProjectionAuthority',
    'lockFinancialProjectionEnrollment'
  ]],
  [`${financialRoot}/sources/refund.ts`, ['lockFinancialProjectionEnrollment']],
  [`${financialRoot}/sources/dispute.ts`, ['lockFinancialProjectionEnrollment']],
  [`${financialRoot}/payouts/repository.ts`, ['lockFinancialProjectionEnrollment']],
  [`${financialRoot}/scans/repository.ts`, [
    'lockFinancialProjectionAuthority',
    'lockFinancialProjectionEnrollment'
  ]],
  [`${financialRoot}/refund-review/corrections.ts`, [
    'FinancialProjectionAuthority',
    'loadFinancialProjectionAuthority',
    'lockFinancialProjectionAuthority',
    'lockFinancialProjectionEnrollment'
  ]],
  [`${financialRoot}/refund-review/finalize.ts`, [
    'FinancialProjectionAuthority',
    'loadFinancialProjectionAuthority',
    'lockFinancialProjectionAuthority',
    'lockFinancialProjectionEnrollment'
  ]]
]);
const mockConsumers = new Map([
  [`${financialRoot}/sources/refund.test.ts`, '../projection-authority'],
  [`${financialRoot}/sources/dispute.test.ts`, '../projection-authority'],
  [
    `${financialRoot}/refund-review/corrections.test.ts`,
    '$lib/server/commerce/financial/projection-authority'
  ],
  [
    `${financialRoot}/refund-review/finalize.test.ts`,
    '$lib/server/commerce/financial/projection-authority'
  ]
] as const);
const mockAuthorityNames = new Map<string, readonly string[]>([
  [`${financialRoot}/sources/refund.test.ts`, ['lockFinancialProjectionEnrollment']],
  [`${financialRoot}/sources/dispute.test.ts`, ['lockFinancialProjectionEnrollment']],
  [`${financialRoot}/refund-review/corrections.test.ts`, [
    'loadFinancialProjectionAuthority',
    'lockFinancialProjectionAuthority',
    'lockFinancialProjectionEnrollment'
  ]],
  [`${financialRoot}/refund-review/finalize.test.ts`, [
    'loadFinancialProjectionAuthority',
    'lockFinancialProjectionAuthority',
    'lockFinancialProjectionEnrollment'
  ]]
]);

interface ModuleFacts {
  readonly importSpecifiers: Set<string>;
  readonly importTypeSpecifiers: Set<string>;
  readonly mockSpecifiers: Set<string>;
  readonly mockedNames: ReadonlyMap<string, ReadonlySet<string>>;
  readonly namedImports: ReadonlyMap<string, ReadonlySet<string>>;
  readonly reexportSpecifiers: Set<string>;
  readonly reexportedNames: Set<string>;
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function source(relativePath: string): string {
  const path = join(repositoryRoot, relativePath);
  return existsSync(path) ? readFileSync(path, 'utf8').replace(/\r\n?/gu, '\n') : '';
}

function productionTypeScriptFiles(directory: string): string[] {
  const absoluteDirectory = join(repositoryRoot, directory);
  if (!existsSync(absoluteDirectory)) return [];
  return readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = normalizePath(join(directory, entry.name));
    if (entry.isDirectory()) return productionTypeScriptFiles(relativePath);
    return entry.isFile() && relativePath.endsWith('.ts') &&
        !relativePath.endsWith('.test.ts')
      ? [relativePath]
      : [];
  });
}

function stringLikeText(node: ts.Node | undefined): string | null {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null;
}

function objectLiteralFactoryReturn(node: ts.Expression | undefined): ts.ObjectLiteralExpression | null {
  if (!node || !ts.isArrowFunction(node) || ts.isBlock(node.body)) return null;
  let expression = node.body;
  while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
  return ts.isObjectLiteralExpression(expression) ? expression : null;
}

function propertyNameText(name: ts.PropertyName | undefined): string | null {
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name))
    ? name.text
    : null;
}

function moduleFacts(relativePath: string): ModuleFacts {
  const namedImports = new Map<string, Set<string>>();
  const mockedNames = new Map<string, Set<string>>();
  const addNamedImport = (specifier: string, name: string): void => {
    const names = namedImports.get(specifier) ?? new Set<string>();
    names.add(name);
    namedImports.set(specifier, names);
  };
  const addMockedName = (specifier: string, name: string): void => {
    const names = mockedNames.get(specifier) ?? new Set<string>();
    names.add(name);
    mockedNames.set(specifier, names);
  };
  const facts: ModuleFacts = {
    importSpecifiers: new Set(),
    importTypeSpecifiers: new Set(),
    mockSpecifiers: new Set(),
    mockedNames,
    namedImports,
    reexportSpecifiers: new Set(),
    reexportedNames: new Set()
  };
  const syntax = ts.createSourceFile(
    relativePath,
    source(relativePath),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = stringLikeText(node.moduleSpecifier);
      if (specifier !== null) facts.importSpecifiers.add(specifier);
      const bindings = node.importClause?.namedBindings;
      if (specifier !== null && bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          addNamedImport(specifier, element.propertyName?.text ?? element.name.text);
        }
      }
    } else if (ts.isImportTypeNode(node)) {
      const argument = ts.isLiteralTypeNode(node.argument)
        ? stringLikeText(node.argument.literal)
        : null;
      if (argument !== null) facts.importTypeSpecifiers.add(argument);
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'vi' &&
      node.expression.name.text === 'mock') {
      const specifier = stringLikeText(node.arguments[0]);
      if (specifier !== null) {
        facts.mockSpecifiers.add(specifier);
        const factory = objectLiteralFactoryReturn(node.arguments[1]);
        for (const property of factory?.properties ?? []) {
          if (ts.isSpreadAssignment(property)) continue;
          const name = propertyNameText(property.name);
          if (name !== null) addMockedName(specifier, name);
        }
      }
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) {
        const specifier = stringLikeText(node.moduleSpecifier);
        if (specifier !== null) facts.reexportSpecifiers.add(specifier);
      }
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          facts.reexportedNames.add(element.name.text);
          if (element.propertyName) facts.reexportedNames.add(element.propertyName.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  return facts;
}

function declarationOwners(): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const path of productionTypeScriptFiles(financialRoot)) {
    const syntax = ts.createSourceFile(
      path,
      source(path),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    for (const statement of syntax.statements) {
      if ((ts.isInterfaceDeclaration(statement) || ts.isFunctionDeclaration(statement)) &&
        statement.name) {
        const paths = owners.get(statement.name.text) ?? [];
        paths.push(normalizePath(relative(repositoryRoot, join(repositoryRoot, path))));
        owners.set(statement.name.text, paths.sort());
      }
    }
  }
  return owners;
}

describe('financial projection authority ownership boundary', () => {
  it('gives every owned authority declaration exactly one leaf owner', () => {
    const owners = declarationOwners();

    for (const name of ownedAuthorityDeclarations) {
      expect(owners.get(name) ?? [], name).toEqual([leafPath]);
    }
  });

  it('keeps the authority leaf dependency set exact', () => {
    const facts = moduleFacts(leafPath);
    const dependencies = new Set([
      ...facts.importSpecifiers,
      ...facts.importTypeSpecifiers,
      ...facts.reexportSpecifiers
    ]);

    expect([...dependencies].sort()).toEqual(leafDependencies);
  });

  it('makes every production consumer import the authority leaf directly', () => {
    for (const [path, specifier] of productionConsumers) {
      const facts = moduleFacts(path);
      expect(facts.importSpecifiers, path).toContain(specifier);
      for (const name of productionAuthorityNames.get(path) ?? []) {
        expect(facts.namedImports.get(specifier)?.has(name), `${path}:${name}`).toBe(true);
      }
    }
  });

  it('removes reciprocal replay imports from authority consumers', () => {
    for (const [path, specifier] of [
      [`${financialRoot}/ledger.ts`, './rebase'],
      [`${financialRoot}/sources/refund.ts`, '../rebase'],
      [`${financialRoot}/sources/dispute.ts`, '../rebase']
    ] as const) {
      expect(moduleFacts(path).importSpecifiers, path).not.toContain(specifier);
    }
  });

  it('moves direct consumer test edges off rebase and onto the authority leaf', () => {
    for (const [path, specifier] of mockConsumers) {
      const facts = moduleFacts(path);
      const sourceTest = path.includes('/sources/');
      const rebaseSpecifier = sourceTest
        ? '../rebase'
        : '$lib/server/commerce/financial/rebase';

      expect(facts.mockSpecifiers, path).toContain(specifier);
      for (const name of mockAuthorityNames.get(path) ?? []) {
        expect(facts.mockedNames.get(specifier)?.has(name), `${path}:${name}`).toBe(true);
        if (sourceTest) {
          expect(facts.namedImports.get(specifier)?.has(name), `${path}:${name}:import`).toBe(true);
        }
      }
      if (!sourceTest) expect(facts.importTypeSpecifiers, path).toContain(specifier);
      expect(facts.importSpecifiers, path).not.toContain(rebaseSpecifier);
      expect(facts.importTypeSpecifiers, path).not.toContain(rebaseSpecifier);
      expect(facts.mockSpecifiers, path).not.toContain(rebaseSpecifier);
    }
  });

  it('splits integration lock-order imports across authority and replay owners', () => {
    const facts = moduleFacts('tests/integration/financial-lock-order.test.ts');

    expect(facts.importSpecifiers).toContain(
      '$lib/server/commerce/financial/projection-authority'
    );
    expect(facts.importSpecifiers).toContain('$lib/server/commerce/financial/rebase');
    expect(facts.namedImports.get(
      '$lib/server/commerce/financial/projection-authority'
    )?.has('lockFinancialProjectionAuthority')).toBe(true);
    expect(facts.namedImports.get(
      '$lib/server/commerce/financial/rebase'
    )?.has('replayFinancialClassification')).toBe(true);
    expect(facts.namedImports.get(
      '$lib/server/commerce/financial/rebase'
    )?.has('lockFinancialProjectionAuthority')).not.toBe(true);
  });

  it('keeps rebase from owning or re-exporting authority declarations', () => {
    const facts = moduleFacts(rebasePath);
    const owners = declarationOwners();

    expect(facts.reexportSpecifiers).not.toContain('./projection-authority');
    for (const name of publicAuthorityExports) {
      expect(owners.get(name) ?? [], name).not.toContain(rebasePath);
      expect(facts.reexportedNames, name).not.toContain(name);
    }
  });
});
