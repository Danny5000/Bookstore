import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as jobCatalog from '../src/lib/server/jobs/catalog';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const catalogPath = 'src/lib/server/jobs/catalog.ts';
const productionRoot = 'src';
const compatibilityNames = new Set(Object.keys(jobCatalog).filter((name) =>
  name.endsWith('_JOB') || name.endsWith('_JOB_MAX_ATTEMPTS') ||
  name.endsWith('_COMMAND_MAX_ATTEMPTS')
));
const compatibilityMaximumNames = new Set([...compatibilityNames].filter((name) =>
  name.endsWith('_MAX_ATTEMPTS')
));
const jobKinds: ReadonlySet<string> = new Set(jobCatalog.REGISTERED_JOB_KINDS);

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function isProductionTypeScriptPath(path: string): boolean {
  const normalized = normalizePath(path);
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  const fixture = normalized.endsWith('.test.ts') || normalized.endsWith('.spec.ts') ||
    normalized.endsWith('.fixture.ts') || normalized.includes('/fixtures/') ||
    normalized.includes('/__tests__/') || basename.startsWith('fixture-');
  return normalized.endsWith('.ts') && !normalized.endsWith('.d.ts') && !fixture;
}

function productionTypeScriptFiles(directory: string): string[] {
  const absolute = join(repositoryRoot, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const path = normalizePath(join(directory, entry.name));
    if (entry.isDirectory()) return productionTypeScriptFiles(path);
    return entry.isFile() && isProductionTypeScriptPath(path) ? [path] : [];
  });
}

interface SourceInventory {
  readonly path: string;
  readonly source: string;
  readonly syntax: ts.SourceFile;
}

function sourceInventory(path: string, source: string): SourceInventory {
  return {
    path,
    source,
    syntax: ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  };
}

const productionInventory = productionTypeScriptFiles(productionRoot).map((path) =>
  sourceInventory(path, readFileSync(join(repositoryRoot, path), 'utf8'))
);
const productionInventoryByPath = new Map(productionInventory.map((item) =>
  [item.path, item] as const
));

function syntax(path: string): ts.SourceFile {
  return productionInventoryByPath.get(path)?.syntax ?? sourceInventory(
    path,
    readFileSync(join(repositoryRoot, path), 'utf8')
  ).syntax;
}

function declarationOwners(): string[] {
  const owners: string[] = [];
  for (const { path, syntax: syntaxFile } of productionInventory) {
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        const initializer = node.initializer && ts.isAsExpression(node.initializer)
          ? node.initializer.expression
          : node.initializer;
        const literal = initializer && ts.isStringLiteral(initializer) ? initializer.text : null;
        if (compatibilityNames.has(node.name.text) || (literal !== null && jobKinds.has(literal))) {
          owners.push(`${path}:${node.name.text}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(syntaxFile);
  }
  return owners.sort();
}

function exactKindLiteralOwnersInSource(path: string, source: string): string[] {
  return exactKindLiteralOwnersInItem(sourceInventory(path, source));
}

function exactKindLiteralOwnersInItem(item: SourceInventory): string[] {
  const owners: string[] = [];
  const { path, syntax: syntaxFile } = item;
  const visit = (node: ts.Node): void => {
    const exactString = ts.isStringLiteral(node) && jobKinds.has(node.text)
      ? [node.text]
      : [];
    const exactTemplate = ts.isNoSubstitutionTemplateLiteral(node) && jobKinds.has(node.text)
      ? [node.text]
      : [];
    const templateKinds = ts.isTemplateLiteralToken(node)
      ? [...jobKinds].filter((kind) =>
          node.text.includes(`'${kind}'`) || node.text.includes(`"${kind}"`)
        )
      : [];
    for (const kind of new Set([...exactString, ...exactTemplate, ...templateKinds])) {
      const position = syntaxFile.getLineAndCharacterOfPosition(node.getStart(syntaxFile));
      owners.push(`${path}:${position.line + 1}:${kind}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(syntaxFile);
  return owners;
}

function exactKindLiteralOwners(): string[] {
  const owners: string[] = [];
  for (const item of productionInventory) {
    const { path } = item;
    if (path === catalogPath) continue;
    owners.push(...exactKindLiteralOwnersInItem(item));
  }
  return owners.sort();
}

type ImportBinding =
  | { readonly kind: 'named'; readonly modulePath?: string; readonly exportName: string }
  | { readonly kind: 'namespace'; readonly modulePath?: string };

function resolveModulePath(
  importerPath: string,
  specifier: string,
  inventoryByPath: ReadonlyMap<string, SourceInventory>
): string | undefined {
  let base: string;
  if (specifier.startsWith('$lib/')) {
    base = `src/lib/${specifier.slice('$lib/'.length)}`;
  } else if (specifier.startsWith('.')) {
    base = normalizePath(join(dirname(importerPath), specifier));
  } else {
    return undefined;
  }
  const candidates = [base, `${base}.ts`, `${base}/index.ts`];
  return candidates.find((candidate) => candidate === catalogPath || inventoryByPath.has(candidate));
}

function importBindings(
  item: SourceInventory,
  inventoryByPath: ReadonlyMap<string, SourceInventory>
): ReadonlyMap<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>();
  for (const statement of item.syntax.statements) {
    if (!ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const modulePath = resolveModulePath(item.path, statement.moduleSpecifier.text, inventoryByPath);
    const clause = statement.importClause;
    if (clause?.name) {
      bindings.set(clause.name.text, { kind: 'named', modulePath, exportName: 'default' });
    }
    const namedBindings = clause?.namedBindings;
    if (namedBindings && ts.isNamespaceImport(namedBindings)) {
      bindings.set(namedBindings.name.text, { kind: 'namespace', modulePath });
    } else if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        bindings.set(element.name.text, {
          kind: 'named',
          modulePath,
          exportName: element.propertyName?.text ?? element.name.text
        });
      }
    }
  }
  return bindings;
}

function exportResolvesToCatalogMaximum(
  modulePath: string | undefined,
  exportName: string,
  inventoryByPath: ReadonlyMap<string, SourceInventory>,
  resolving: ReadonlySet<string> = new Set()
): boolean {
  if (modulePath === undefined) return false;
  if (modulePath === catalogPath) return compatibilityMaximumNames.has(exportName);
  const key = `${modulePath}:${exportName}`;
  if (resolving.has(key)) return false;
  const item = inventoryByPath.get(modulePath);
  if (!item) return false;
  const next = new Set(resolving);
  next.add(key);
  const imports = importBindings(item, inventoryByPath);
  const importedExpressionResolves = (expression: ts.Expression): boolean => {
    if (ts.isIdentifier(expression)) {
      const binding = imports.get(expression.text);
      return binding?.kind === 'named' && exportResolvesToCatalogMaximum(
        binding.modulePath, binding.exportName, inventoryByPath, next
      );
    }
    if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
      const binding = imports.get(expression.expression.text);
      return binding?.kind === 'namespace' && exportResolvesToCatalogMaximum(
        binding.modulePath, expression.name.text, inventoryByPath, next
      );
    }
    return false;
  };

  for (const statement of item.syntax.statements) {
    if (ts.isExportDeclaration(statement)) {
      const targetPath = ts.isStringLiteral(statement.moduleSpecifier)
        ? resolveModulePath(item.path, statement.moduleSpecifier.text, inventoryByPath)
        : undefined;
      if (!statement.exportClause) {
        if (targetPath && exportResolvesToCatalogMaximum(
          targetPath, exportName, inventoryByPath, next
        )) return true;
        continue;
      }
      if (!ts.isNamedExports(statement.exportClause)) continue;
      for (const element of statement.exportClause.elements) {
        if (element.name.text !== exportName) continue;
        const sourceName = element.propertyName?.text ?? element.name.text;
        if (targetPath) {
          if (exportResolvesToCatalogMaximum(targetPath, sourceName, inventoryByPath, next)) {
            return true;
          }
        } else {
          const binding = imports.get(sourceName);
          if (binding?.kind === 'named' && exportResolvesToCatalogMaximum(
            binding.modulePath, binding.exportName, inventoryByPath, next
          )) return true;
        }
      }
    }
    if (ts.isVariableStatement(statement) && statement.modifiers?.some(
      ({ kind }) => kind === ts.SyntaxKind.ExportKeyword
    )) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === exportName &&
          declaration.initializer && importedExpressionResolves(declaration.initializer)) return true;
      }
    }
  }
  return false;
}

function numericMaxOwnersInInventory(inventory: readonly SourceInventory[]): string[] {
  const inventoryByPath = new Map(inventory.map((item) => [item.path, item] as const));
  return inventory.flatMap((item) => numericMaxOwnersInItem(item, inventoryByPath)).sort();
}

function numericMaxOwnersInItem(
  item: SourceInventory,
  inventoryByPath: ReadonlyMap<string, SourceInventory>
): string[] {
  const { path, syntax: syntaxFile } = item;
  const owners: string[] = [];
  const imports = importBindings(item, inventoryByPath);
  const localInitializers = new Map<string, ts.Expression[]>();
  const destructuredImports = new Map<string, {
    readonly modulePath?: string;
    readonly property?: string;
    readonly defaultInitializer?: ts.Expression;
    readonly failClosed: boolean;
  }>();
  const unwrap = (expression: ts.Expression): ts.Expression => {
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression) || ts.isNonNullExpression(expression)) {
      return unwrap(expression.expression);
    }
    return expression;
  };
  const recordFailClosedBindings = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      destructuredImports.set(name.text, { failClosed: true });
      return;
    }
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue;
      recordFailClosedBindings(element.name);
    }
  };
  const bindingProperty = (name: ts.PropertyName | undefined): string | undefined =>
    name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
      ? name.text
      : undefined;
  const recordNamespaceDestructure = (
    name: ts.BindingName,
    binding: Extract<ImportBinding, { readonly kind: 'namespace' }>
  ): void => {
    if (ts.isArrayBindingPattern(name)) {
      recordFailClosedBindings(name);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isIdentifier(element.name) || element.dotDotDotToken) {
        recordFailClosedBindings(element.name);
        continue;
      }
      const property = bindingProperty(element.propertyName) ?? element.name.text;
      destructuredImports.set(element.name.text, {
        modulePath: binding.modulePath,
        property,
        defaultInitializer: element.initializer,
        failClosed: property.length === 0
      });
    }
  };
  const collectBindings = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      node.initializer) {
      const initializers = localInitializers.get(node.name.text) ?? [];
      initializers.push(node.initializer);
      localInitializers.set(node.name.text, initializers);
    } else if (ts.isVariableDeclaration(node) && node.initializer &&
      !ts.isIdentifier(node.name)) {
      const initializer = unwrap(node.initializer);
      const binding = ts.isIdentifier(initializer) ? imports.get(initializer.text) : undefined;
      if (binding?.kind === 'namespace') recordNamespaceDestructure(node.name, binding);
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(syntaxFile);

  const importedExpressionAuthority = (node: ts.Expression): boolean | undefined => {
    if (ts.isIdentifier(node)) {
      const binding = imports.get(node.text);
      if (!binding) return undefined;
      return binding.kind !== 'named' || !exportResolvesToCatalogMaximum(
        binding.modulePath, binding.exportName, inventoryByPath
      );
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const binding = imports.get(node.expression.text);
      if (!binding) return undefined;
      return binding.kind !== 'namespace' || !exportResolvesToCatalogMaximum(
        binding.modulePath, node.name.text, inventoryByPath
      );
    }
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const binding = imports.get(node.expression.text);
      if (!binding) return undefined;
      const property = node.argumentExpression && ts.isStringLiteral(node.argumentExpression)
        ? node.argumentExpression.text
        : undefined;
      return binding.kind !== 'namespace' || property === undefined ||
        !exportResolvesToCatalogMaximum(binding.modulePath, property, inventoryByPath);
    }
    return undefined;
  };
  const numericMaximumExpression = (
    node: ts.Expression,
    resolving: ReadonlySet<string> = new Set()
  ): boolean => {
    if (ts.isNumericLiteral(node)) return true;
    if (ts.isIdentifier(node)) {
      if (resolving.has(node.text)) return false;
      const destructured = destructuredImports.get(node.text);
      if (destructured) {
        if (destructured.failClosed || destructured.property === undefined ||
          !exportResolvesToCatalogMaximum(
            destructured.modulePath, destructured.property, inventoryByPath
          )) return true;
        return destructured.defaultInitializer !== undefined &&
          numericMaximumExpression(destructured.defaultInitializer, resolving);
      }
      const initializers = localInitializers.get(node.text);
      if (!initializers) return importedExpressionAuthority(node) ?? false;
      const next = new Set(resolving);
      next.add(node.text);
      return initializers.some((initializer) => numericMaximumExpression(initializer, next));
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) {
      return numericMaximumExpression(node.expression, resolving);
    }
    if (ts.isPrefixUnaryExpression(node)) {
      return numericMaximumExpression(node.operand, resolving);
    }
    if (ts.isBinaryExpression(node)) {
      return numericMaximumExpression(node.left, resolving) ||
        numericMaximumExpression(node.right, resolving);
    }
    if (ts.isConditionalExpression(node)) {
      return numericMaximumExpression(node.whenTrue, resolving) ||
        numericMaximumExpression(node.whenFalse, resolving);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const numericArgument = (node.arguments ?? []).some((argument) =>
        ts.isSpreadElement(argument)
          ? numericMaximumExpression(argument.expression, resolving)
          : numericMaximumExpression(argument, resolving)
      );
      if (numericArgument) return true;
      return importedExpressionAuthority(node.expression) ??
        numericMaximumExpression(node.expression, resolving);
    }
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      return importedExpressionAuthority(node) ?? false;
    }
    return false;
  };
  const propertyName = (name: ts.PropertyName | undefined): string | null =>
    name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : null;
  const visit = (node: ts.Node): void => {
    let authority = false;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
      /(?:^|_)MAX_ATTEMPTS$/u.test(node.name.text)) {
      authority = numericMaximumExpression(node.initializer, new Set([node.name.text]));
    } else if (ts.isPropertyAssignment(node) && propertyName(node.name) === 'maxAttempts' &&
      numericMaximumExpression(node.initializer)) {
      authority = true;
    } else if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'maxAttempts' &&
      numericMaximumExpression(node.name)) {
      authority = true;
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name) &&
      node.name.text === 'maxAttempts' && node.initializer &&
      numericMaximumExpression(node.initializer)) {
      authority = true;
    }
    if (authority) {
      const position = syntaxFile.getLineAndCharacterOfPosition(node.getStart(syntaxFile));
      owners.push(`${path}:${position.line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(syntaxFile);
  return owners;
}

function numericMaxOwnersInSource(path: string, source: string): string[] {
  return numericMaxOwnersInInventory([sourceInventory(path, source)]);
}

function numericMaxOwnersInSources(sources: Readonly<Record<string, string>>): string[] {
  return numericMaxOwnersInInventory(Object.entries(sources).map(([path, source]) =>
    sourceInventory(path, source)
  ));
}

function numericMaxOwners(): string[] {
  return numericMaxOwnersInInventory(productionInventory);
}

describe('production job catalog ownership boundary', () => {
  it('keeps the Plan 7A catalog closed to eleven no-provider rows and two enabled policies', () => {
    expect(jobCatalog.JOB_DEFINITIONS).toHaveLength(11);
    expect(jobCatalog.JOB_DEFINITIONS.every((definition) =>
      definition.providerVerificationRequired === false &&
      definition.providerCallsInPlan7A === false
    )).toBe(true);
    expect(jobCatalog.JOB_DEFINITIONS.filter((definition) =>
      definition.retryPolicyAvailability === 'enabled'
    ).map((definition) => definition.retryPolicyId)).toEqual([
      'rearm_pending_stripe_event',
      'rearm_financial_classification'
    ]);
  });

  it('requires the worker root to consume catalog authority and exhaustive validators directly', () => {
    const worker = readFileSync(join(repositoryRoot, 'src/worker.ts'), 'utf8');
    const workerSyntax = ts.createSourceFile(
      'src/worker.ts',
      worker,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const catalogImports = workerSyntax.statements.filter((statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === '$lib/server/jobs/catalog'
    );

    expect(worker).toContain("from '$lib/server/jobs/catalog'");
    expect(worker).toContain("from '$lib/server/jobs/handler-bindings'");
    expect(worker).toContain('createRegisteredJobHandlerMap');
    expect(worker).toContain('parseRegisteredJobDiagnosticMetadata');
    const catalogNames = [
      'OUTBOX_DISPATCH_JOB',
      'COMMERCE_CLAIM_EMAIL_JOB',
      'COMMERCE_CLAIM_REQUEST_JOB',
      'STRIPE_EVENT_JOB',
      'FINANCIAL_SOURCE_JOB',
      'FINANCIAL_PAYOUT_JOB',
      'FINANCIAL_SCAN_JOB',
      'FINANCIAL_CLASSIFICATION_JOB',
      'FINANCIAL_ADMIN_COMMAND_JOB',
      'INGEST_REVISION_JOB',
      'OPERATIONS_JOB_RETRY_COMMAND_JOB',
      'parseRegisteredJobDiagnosticMetadata'
    ];
    expect(catalogImports).toHaveLength(1);
    const namedBindings = catalogImports[0]?.importClause?.namedBindings;
    expect(namedBindings && ts.isNamedImports(namedBindings)).toBe(true);
    expect(namedBindings && ts.isNamedImports(namedBindings)
      ? namedBindings.elements.map((element) => ({
        imported: element.propertyName?.text ?? element.name.text,
        local: element.name.text
      })).sort((left, right) => left.local.localeCompare(right.local))
      : []).toEqual(catalogNames.map((name) => ({ imported: name, local: name }))
        .sort((left, right) => left.local.localeCompare(right.local)));
    for (const kindName of catalogNames) {
      expect(worker, kindName).toMatch(
        new RegExp(`\\b${kindName}\\b`, 'u')
      );
    }
  });

  it('detects exact no-substitution templates without rejecting prefixed dedupe templates', () => {
    const kind = jobCatalog.REGISTERED_JOB_KINDS[0];
    expect(exactKindLiteralOwnersInSource(
      'src/probe.ts',
      `const KIND = \`${kind}\`;\nconst DEDUPE = \`${kind}:item:1\`;`
    )).toEqual([`src/probe.ts:1:${kind}`]);
  });

  it('traces numeric aliases and defaults used as maximum authorities', () => {
    expect(numericMaxOwnersInSource('src/probe.ts', [
      'const RETRY_LIMIT = 4 * 2;',
      'const RETRY_LIMIT_ALIAS = RETRY_LIMIT;',
      'function enqueue(maxAttempts = RETRY_LIMIT_ALIAS) { return maxAttempts; }',
      'const spec = { maxAttempts: RETRY_LIMIT_ALIAS };'
    ].join('\n'))).toEqual(['src/probe.ts:3', 'src/probe.ts:4']);
  });

  it('allows imported catalog maxima and runtime object-field propagation through aliases', () => {
    expect(numericMaxOwnersInSource('src/lib/server/jobs/probe.ts', [
      'import { OUTBOX_DISPATCH_JOB_MAX_ATTEMPTS as CATALOG_MAX } from \'./catalog\';',
      "import * as catalog from './catalog';",
      'const CATALOG_ALIAS = CATALOG_MAX;',
      'const RUNTIME_ALIAS = input.maxAttempts;',
      'const catalogSpec = { maxAttempts: CATALOG_ALIAS };',
      'const namespaceSpec = { maxAttempts: catalog.OUTBOX_DISPATCH_JOB_MAX_ATTEMPTS };',
      'const runtimeSpec = { maxAttempts: RUNTIME_ALIAS };'
    ].join('\n'))).toEqual([]);
  });

  it('allows a catalog maximum through an explicit re-export alias', () => {
    expect(numericMaxOwnersInSources({
      'src/lib/server/retry-values.ts': [
        'export { OUTBOX_DISPATCH_JOB_MAX_ATTEMPTS as RETRIES }',
        "  from './jobs/catalog';"
      ].join('\n'),
      'src/lib/server/consumer.ts': [
        "import { RETRIES } from './retry-values';",
        'const spec = { maxAttempts: RETRIES };'
      ].join('\n')
    })).toEqual([]);
  });

  it('detects a non-catalog named imported maximum authority', () => {
    expect(numericMaxOwnersInSources({
      'src/retry-values.ts': 'export const RETRIES = 8;',
      'src/consumer.ts': [
        "import { RETRIES } from './retry-values';",
        'const spec = { maxAttempts: RETRIES };'
      ].join('\n')
    })).toEqual(['src/consumer.ts:2']);
  });

  it('detects namespace and named-alias imported maximum authorities', () => {
    expect(numericMaxOwnersInSources({
      'src/retry-values.ts': 'export const RETRIES = 8;',
      'src/consumer.ts': [
        "import * as retryValues from './retry-values';",
        'const namespaceSpec = { maxAttempts: retryValues.RETRIES };',
        "import { RETRIES as IMPORTED_RETRIES } from './retry-values';",
        'const aliasSpec = { maxAttempts: IMPORTED_RETRIES };'
      ].join('\n')
    })).toEqual(['src/consumer.ts:2', 'src/consumer.ts:4']);
  });

  it('detects a maximum destructured from a non-catalog namespace import', () => {
    expect(numericMaxOwnersInSources({
      'src/retry-values.ts': 'export const RETRIES = 8;',
      'src/consumer.ts': [
        "import * as values from './retry-values';",
        "import * as unresolvedValues from 'unresolved-package';",
        'const { RETRIES } = values;',
        'const RETRY_ALIAS = RETRIES;',
        'const directSpec = { maxAttempts: RETRIES };',
        'const aliasSpec = { maxAttempts: RETRY_ALIAS };',
        'const { RETRIES: UNKNOWN_RETRIES } = unresolvedValues;',
        'const unresolvedSpec = { maxAttempts: UNKNOWN_RETRIES };'
      ].join('\n')
    })).toEqual(['src/consumer.ts:5', 'src/consumer.ts:6', 'src/consumer.ts:8']);
  });

  it('allows shorthand and aliased destructuring from the direct catalog namespace', () => {
    expect(numericMaxOwnersInSource('src/lib/server/jobs/probe.ts', [
      "import * as catalog from './catalog';",
      'const { OUTBOX_DISPATCH_JOB_MAX_ATTEMPTS } = catalog;',
      'const { OUTBOX_DISPATCH_JOB_MAX_ATTEMPTS: CATALOG_MAX } = catalog;',
      'const { OUTBOX_DISPATCH_JOB_MAX_ATTEMPTS: DEFAULTED_MAX = input.maxAttempts } = catalog;',
      'const shorthandSpec = { maxAttempts: OUTBOX_DISPATCH_JOB_MAX_ATTEMPTS };',
      'const aliasSpec = { maxAttempts: CATALOG_MAX };',
      'const defaultedSpec = { maxAttempts: DEFAULTED_MAX };'
    ].join('\n'))).toEqual([]);
  });

  it('detects imported calls with numeric arguments and zero arguments', () => {
    expect(numericMaxOwnersInSources({
      'src/retry-values.ts': 'export const retryLimit = () => 8;',
      'src/consumer.ts': [
        "import { retryLimit } from './retry-values';",
        "import * as retryValues from './retry-values';",
        'const argumentSpec = { maxAttempts: retryLimit(8) };',
        'const returnSpec = { maxAttempts: retryLimit() };',
        'const importedCallAlias = retryLimit;',
        'const aliasSpec = { maxAttempts: importedCallAlias() };',
        'const namespaceCallSpec = { maxAttempts: retryValues.retryLimit() };'
      ].join('\n')
    })).toEqual([
      'src/consumer.ts:3',
      'src/consumer.ts:4',
      'src/consumer.ts:6',
      'src/consumer.ts:7'
    ]);
  });

  it('excludes established fixture basenames from production scanning', () => {
    expect(isProductionTypeScriptPath('src/testing/fixture-gateway.ts')).toBe(false);
    expect(isProductionTypeScriptPath('src/testing/fixture-financial.ts')).toBe(false);
    expect(isProductionTypeScriptPath('src/testing/financial-gateway.ts')).toBe(true);
  });

  it('builds one unique module-scope source and AST inventory', () => {
    expect(productionInventory).toHaveLength(productionInventoryByPath.size);
    for (const item of productionInventory) {
      expect(productionInventoryByPath.get(item.path)?.source).toBe(item.source);
      expect(productionInventoryByPath.get(item.path)?.syntax).toBe(item.syntax);
    }
  });

  it('gives compatibility kind and maximum declarations one production owner', () => {
    expect(declarationOwners()).toEqual([...compatibilityNames]
      .sort()
      .map((name) => `${catalogPath}:${name}`));
  });

  it('keeps production max-attempt number literals in the catalog only', () => {
    const owners = numericMaxOwners();
    expect(owners.every((owner) => owner.startsWith(`${catalogPath}:`)),
      owners.join('\n')).toBe(true);
  });

  it('keeps exact production kind literals in the catalog only', () => {
    expect(exactKindLiteralOwners()).toEqual([]);
  });

  it('keeps the catalog dependency-light', () => {
    const forbidden = [
      '/handler', '/runner', '/worker', '/repository', '/service', '/route',
      '/db/client', '/gateway', '.svelte'
    ];
    const imports: string[] = [];
    for (const statement of syntax(catalogPath).statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        imports.push(statement.moduleSpecifier.text);
      }
    }
    for (const specifier of imports) {
      expect(forbidden.some((fragment) => specifier.includes(fragment)), specifier).toBe(false);
    }
  });
});
