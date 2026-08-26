import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PlaywrightTestConfig } from "@playwright/test";
import * as ts from "typescript";
import { loadEnv } from "vite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withoutStripeProviderSecrets } from "./test-environment";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const isolatedTestStorageRoot = join(
  resolve(tmpdir()),
  `pale-orbit-test-storage-config-${randomUUID()}`,
);
const financialHarnessPath = resolve(
  repositoryRoot,
  "tests/e2e/financial-harness.ts",
);
const requiredFinancialE2ESources = {
  financialHarness: financialHarnessPath,
  refundReviewJourney: resolve(
    repositoryRoot,
    "tests/e2e/refund-review.spec.ts",
  ),
  salesReportingJourney: resolve(
    repositoryRoot,
    "tests/e2e/sales-reporting.spec.ts",
  ),
} as const;

const isolatedEnvironment = {
  APP_ENV: "test",
  PALE_ORBIT_TEST_PROJECT: "pale-orbit-test-0123456789abcdef",
  DATABASE_HOST: "127.0.0.1",
  DATABASE_PORT: "55432",
  DATABASE_NAME: "pale_orbit_test",
  DATABASE_URL: "postgresql://private-owner-url",
  DATABASE_OWNER_USER: "pale_orbit_test",
  DATABASE_OWNER_USER_FILE: "/run/secrets/owner-user",
  DATABASE_OWNER_PASSWORD: "private-owner-password",
  DATABASE_OWNER_PASSWORD_FILE: "/run/secrets/owner-password",
  DATABASE_USER: "pale_orbit_test_web",
  DATABASE_USER_FILE: "/run/secrets/web-user",
  DATABASE_PASSWORD: "private-web-password",
  DATABASE_PASSWORD_FILE: "/run/secrets/web-password",
  DATABASE_WORKER_USER: "pale_orbit_test_worker",
  DATABASE_WORKER_USER_FILE: "/run/secrets/worker-user",
  DATABASE_WORKER_PASSWORD: "private-worker-password",
  DATABASE_WORKER_PASSWORD_FILE: "/run/secrets/worker-password",
  DATABASE_STORAGE_CLEANUP_USER: "pale_orbit_test_storage_cleanup",
  DATABASE_STORAGE_CLEANUP_USER_FILE: "/run/secrets/cleanup-user",
  DATABASE_STORAGE_CLEANUP_PASSWORD: "private-cleanup-password",
  DATABASE_STORAGE_CLEANUP_PASSWORD_FILE: "/run/secrets/cleanup-password",
  DATABASE_MIGRATION_WEB_USER: "private-migration-web-user",
  DATABASE_MIGRATION_WORKER_USER: "private-migration-worker-user",
  DATABASE_MIGRATION_STORAGE_CLEANUP_USER: "private-migration-cleanup-user",
  AUTH_SECRET: "private-runner-auth-secret-at-least-thirty-two-bytes",
  AUTH_SECRET_FILE: "/run/secrets/auth-secret",
  BOOTSTRAP_ADMIN_EMAIL: "private-bootstrap@example.test",
  BOOTSTRAP_ADMIN_EMAIL_FILE: "/run/secrets/bootstrap-email",
  BOOTSTRAP_ADMIN_NAME: "Private Bootstrap Administrator",
  BOOTSTRAP_ADMIN_NAME_FILE: "/run/secrets/bootstrap-name",
  BOOTSTRAP_ADMIN_PASSWORD: "private-bootstrap-password",
  BOOTSTRAP_ADMIN_PASSWORD_FILE: "/run/secrets/bootstrap-password",
  SMTP_USER: "private-smtp-user",
  SMTP_USER_FILE: "/run/secrets/smtp-user",
  SMTP_PASSWORD: "private-smtp-password",
  SMTP_PASSWORD_FILE: "/run/secrets/smtp-password",
  STRIPE_SECRET_KEY: "sk_test_private",
  STRIPE_SECRET_KEY_FILE: "/run/secrets/stripe-key",
  STRIPE_WEBHOOK_SECRET: "whsec_private",
  STRIPE_WEBHOOK_SECRET_FILE: "/run/secrets/stripe-webhook",
  WORKER_READY_FILE: join(isolatedTestStorageRoot, "worker.ready"),
  WORKER_READY_FILE_FILE: "/run/secrets/worker-ready-file",
  WORKER_CONCURRENCY: "1",
  WORKER_CONCURRENCY_FILE: "/run/secrets/worker-concurrency",
  WORKER_HEARTBEAT_INTERVAL_MS: "1000",
  WORKER_HEARTBEAT_INTERVAL_MS_FILE: "/run/secrets/worker-heartbeat-interval",
  WORKER_HEARTBEAT_MAX_AGE_MS: "4000",
  WORKER_HEARTBEAT_MAX_AGE_MS_FILE: "/run/secrets/worker-heartbeat-max-age",
  PGPASSWORD: "private-postgres-password",
  PGPASSFILE: "/run/secrets/pgpass",
  POSTGRES_PASSWORD: "private-container-password",
  POSTGRES_PASSWORD_FILE: "/run/secrets/postgres-password",
  PRIVATE_TEST_PROCESS_TOKEN: "private-test-process-token",
} as const;

function serverConfigEnvironmentResult(environment: NodeJS.ProcessEnv) {
  const viteConfigUrl = pathToFileURL(
    resolve(repositoryRoot, "vite.config.ts"),
  ).href;
  const svelteConfigUrl = pathToFileURL(
    resolve(repositoryRoot, "svelte.config.js"),
  ).href;
  const script = `
    const [{ default: viteConfig }, { default: svelteConfig }] = await Promise.all([
      import(${JSON.stringify(viteConfigUrl)}),
      import(${JSON.stringify(svelteConfigUrl)})
    ]);
    process.stdout.write(JSON.stringify({
      viteEnvDir: viteConfig.envDir ?? null,
      svelteEnvDir: svelteConfig.kit?.env?.dir ?? null
    }));
  `;
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: Object.fromEntries(
        Object.entries(environment).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function oneWebServer(
  configuration: PlaywrightTestConfig,
): NonNullable<PlaywrightTestConfig["webServer"]> {
  const webServer = configuration.webServer;
  if (!webServer || Array.isArray(webServer))
    throw new Error("Expected one Playwright web server");
  return webServer;
}

function effectiveWebEnvironment(
  configuration: PlaywrightTestConfig,
): NodeJS.ProcessEnv {
  const webServer = oneWebServer(configuration);
  return Object.fromEntries(
    Object.entries({ ...process.env, ...webServer.env }).filter(
      (entry) => entry[1] !== undefined,
    ),
  );
}

function isAtOrWithinPath(parent: string, candidate: string): boolean {
  const relationship = relative(parent, candidate);
  return (
    relationship === "" ||
    (relationship !== ".." &&
      !relationship.startsWith(`..${sep}`) &&
      !isAbsolute(relationship))
  );
}

function matchesModuleBoundary(candidate: string, boundary: string): boolean {
  if (isAbsolute(candidate) && isAbsolute(boundary)) {
    return isAtOrWithinPath(boundary, candidate);
  }
  return candidate === boundary || candidate.startsWith(`${boundary}/`);
}

function localModuleIdentity(importer: string, specifier: string): string {
  const withoutExtension = (path: string): string =>
    path
      .replace(/(?:[.]d)?[.](?:[cm]?[jt]s)$/u, "")
      .replace(/[\\/]index$/u, "");
  if (specifier.startsWith("$lib/")) {
    return withoutExtension(
      resolve(repositoryRoot, "src/lib", specifier.slice("$lib/".length)),
    );
  }
  if (specifier.startsWith(".")) {
    return withoutExtension(resolve(dirname(importer), specifier));
  }
  return specifier;
}

function sourceFacts(
  path: string,
  contents: string,
): {
  readonly calledNames: ReadonlySet<string>;
  readonly exportedNames: ReadonlySet<string>;
  readonly importedModules: ReadonlySet<string>;
  readonly importedValueNames: ReadonlyMap<string, ReadonlySet<string>>;
  readonly referencedNames: ReadonlySet<string>;
} {
  const syntax = ts.createSourceFile(
    path,
    contents,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const calledNames = new Set<string>();
  const exportedNames = new Set<string>();
  const importedModules = new Set<string>();
  const importedValueNames = new Map<string, Set<string>>();
  const referencedNames = new Set<string>();

  const addImportedValue = (module: string, name: string): void => {
    const names = importedValueNames.get(module) ?? new Set<string>();
    names.add(name);
    importedValueNames.set(module, names);
  };
  const isExported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts
      .getModifiers(node)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
      false);
  const addBindingNames = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      exportedNames.add(name.text);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) addBindingNames(element.name);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) referencedNames.add(node.text);

    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const module = localModuleIdentity(path, node.moduleSpecifier.text);
      importedModules.add(module);
      const clause = node.importClause;
      if (clause !== undefined && !clause.isTypeOnly) {
        if (clause.name !== undefined) addImportedValue(module, "default");
        const bindings = clause.namedBindings;
        if (bindings !== undefined && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if (!element.isTypeOnly)
              addImportedValue(
                module,
                element.propertyName?.text ?? element.name.text,
              );
          }
        }
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      importedModules.add(localModuleIdentity(path, node.moduleSpecifier.text));
    } else if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression))
        calledNames.add(node.expression.text);
      if (ts.isPropertyAccessExpression(node.expression))
        calledNames.add(node.expression.name.text);
      const argument = node.arguments[0];
      if (
        argument !== undefined &&
        ts.isStringLiteralLike(argument) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) &&
            node.expression.text === "require"))
      ) {
        importedModules.add(localModuleIdentity(path, argument.text));
      }
    }

    if (
      isExported(node) &&
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name !== undefined
    ) {
      exportedNames.add(node.name.text);
    }
    if (isExported(node) && ts.isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations)
        addBindingNames(declaration.name);
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  return {
    calledNames,
    exportedNames,
    importedModules,
    importedValueNames,
    referencedNames,
  };
}

describe("Playwright commerce fixture isolation", () => {
  let configuration: PlaywrightTestConfig;

  beforeAll(async () => {
    await mkdir(isolatedTestStorageRoot);
    for (const [name, value] of Object.entries(isolatedEnvironment))
      vi.stubEnv(name, value);
    configuration = (await import("../playwright.config")).default;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(isolatedTestStorageRoot, { recursive: true, force: true });
  });

  it("does not retain sensitive browser traces, screenshots, or videos", () => {
    expect(configuration.use).toMatchObject({
      trace: "off",
      screenshot: "off",
      video: "off",
    });
  });

  it("runs financial journeys serially in one fresh browser worker and web process", () => {
    expect(configuration.fullyParallel).toBe(false);
    expect(configuration.workers).toBe(1);
    expect(oneWebServer(configuration).reuseExistingServer).toBe(false);
  });

  it("keeps harness credentials in the test runner but removes them from the web process", () => {
    for (const [name, value] of Object.entries(isolatedEnvironment)) {
      expect(
        process.env[name],
        `${name} must remain available to the Playwright test runner`,
      ).toBe(value);
    }

    const webEnvironment = effectiveWebEnvironment(configuration);
    expect(webEnvironment).toMatchObject({
      APP_ENV: "test",
      DATABASE_USER: isolatedEnvironment.DATABASE_USER,
      DATABASE_PASSWORD: isolatedEnvironment.DATABASE_PASSWORD,
      STRIPE_ENABLED: "false",
      STRIPE_TEST_FIXTURE_MODE: "true",
    });
    expect(webEnvironment.AUTH_SECRET).not.toBe(
      isolatedEnvironment.AUTH_SECRET,
    );
    for (const name of [
      "PALE_ORBIT_TEST_PROJECT",
      "DATABASE_URL",
      "DATABASE_OWNER_USER",
      "DATABASE_OWNER_USER_FILE",
      "DATABASE_OWNER_PASSWORD",
      "DATABASE_OWNER_PASSWORD_FILE",
      "DATABASE_USER_FILE",
      "DATABASE_PASSWORD_FILE",
      "DATABASE_WORKER_USER",
      "DATABASE_WORKER_USER_FILE",
      "DATABASE_WORKER_PASSWORD",
      "DATABASE_WORKER_PASSWORD_FILE",
      "DATABASE_STORAGE_CLEANUP_USER",
      "DATABASE_STORAGE_CLEANUP_USER_FILE",
      "DATABASE_STORAGE_CLEANUP_PASSWORD",
      "DATABASE_STORAGE_CLEANUP_PASSWORD_FILE",
      "DATABASE_MIGRATION_WEB_USER",
      "DATABASE_MIGRATION_WORKER_USER",
      "DATABASE_MIGRATION_STORAGE_CLEANUP_USER",
      "AUTH_SECRET_FILE",
      "BOOTSTRAP_ADMIN_EMAIL",
      "BOOTSTRAP_ADMIN_EMAIL_FILE",
      "BOOTSTRAP_ADMIN_NAME",
      "BOOTSTRAP_ADMIN_NAME_FILE",
      "BOOTSTRAP_ADMIN_PASSWORD",
      "BOOTSTRAP_ADMIN_PASSWORD_FILE",
      "SMTP_USER",
      "SMTP_USER_FILE",
      "SMTP_PASSWORD",
      "SMTP_PASSWORD_FILE",
      "STRIPE_SECRET_KEY",
      "STRIPE_SECRET_KEY_FILE",
      "STRIPE_WEBHOOK_SECRET",
      "STRIPE_WEBHOOK_SECRET_FILE",
      "WORKER_READY_FILE",
      "WORKER_READY_FILE_FILE",
      "WORKER_CONCURRENCY",
      "WORKER_CONCURRENCY_FILE",
      "WORKER_HEARTBEAT_INTERVAL_MS",
      "WORKER_HEARTBEAT_INTERVAL_MS_FILE",
      "WORKER_HEARTBEAT_MAX_AGE_MS",
      "WORKER_HEARTBEAT_MAX_AGE_MS_FILE",
      "PGPASSWORD",
      "PGPASSFILE",
      "POSTGRES_PASSWORD",
      "POSTGRES_PASSWORD_FILE",
      "PRIVATE_TEST_PROCESS_TOKEN",
    ] as const) {
      expect(
        webEnvironment,
        `${name} must not reach the Playwright web process`,
      ).not.toHaveProperty(name);
    }
  });

  it("uses the fixture gateway with Stripe disabled and no provider secrets", () => {
    const webEnvironment = effectiveWebEnvironment(configuration);
    expect(webEnvironment).toMatchObject({
      APP_ENV: "test",
      STRIPE_ENABLED: "false",
      STRIPE_TEST_FIXTURE_MODE: "true",
    });
    expect(webEnvironment).not.toHaveProperty("STRIPE_SECRET_KEY");
    expect(webEnvironment).not.toHaveProperty("STRIPE_WEBHOOK_SECRET");
  });

  it("starts the E2E worker in fixture mode without enabling integration fixtures", async () => {
    const source = await readFile(
      new URL("./with-test-database.ts", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(
      /STRIPE_TEST_FIXTURE_MODE:\s*withWorker\s*\?\s*'true'\s*:\s*'false'/u,
    );
  });

  it("isolates both server dotenv loaders inside one owned empty E2E directory", async () => {
    const fixtureRoot = await mkdtemp(
      join(resolve(tmpdir()), "pale-orbit-e2e-env-fixture-"),
    );
    const ownedRoot = await mkdtemp(
      join(resolve(tmpdir()), "pale-orbit-test-storage-config-case-"),
    );
    const nonemptyDirectory = join(ownedRoot, "dotenv-empty");
    const outsideDirectory = await mkdtemp(
      join(resolve(tmpdir()), "pale-orbit-e2e-outside-"),
    );
    try {
      const webServer = oneWebServer(configuration);
      expect(webServer).toMatchObject({
        command:
          "npm run build:web && npm run preview -- --host 127.0.0.1 --port 4173 --strictPort",
        url: "http://127.0.0.1:4173/health/live",
        reuseExistingServer: false,
        timeout: 240_000,
      });
      await writeFile(
        join(fixtureRoot, ".env"),
        "PALE_ORBIT_E2E_SENTINEL_ENV=private-env-sentinel\n",
        "utf8",
      );
      await writeFile(
        join(fixtureRoot, ".env.local"),
        "PALE_ORBIT_E2E_SENTINEL_LOCAL=private-local-sentinel\n",
        "utf8",
      );
      await mkdir(nonemptyDirectory);
      await writeFile(join(nonemptyDirectory, "not-empty"), "occupied", "utf8");

      const webEnvironment = effectiveWebEnvironment(configuration);
      expect(webEnvironment.PALE_ORBIT_E2E_ENV_ISOLATION).toBe("1");
      const emptyEnvironmentDirectory =
        webEnvironment.PALE_ORBIT_E2E_EMPTY_ENV_DIR;
      expect(emptyEnvironmentDirectory).toBeDefined();
      expect(isAbsolute(emptyEnvironmentDirectory!)).toBe(true);
      expect(
        isAtOrWithinPath(isolatedTestStorageRoot, emptyEnvironmentDirectory!),
      ).toBe(true);

      const effective = serverConfigEnvironmentResult(webEnvironment);
      expect(effective.status, effective.stderr).toBe(0);
      const directories = JSON.parse(effective.stdout) as {
        viteEnvDir: string | null;
        svelteEnvDir: string | null;
      };
      expect(directories).toEqual({
        viteEnvDir: emptyEnvironmentDirectory,
        svelteEnvDir: emptyEnvironmentDirectory,
      });

      const sentinelEnvironment = loadEnv("test", fixtureRoot, "");
      expect(sentinelEnvironment).toMatchObject({
        PALE_ORBIT_E2E_SENTINEL_ENV: "private-env-sentinel",
        PALE_ORBIT_E2E_SENTINEL_LOCAL: "private-local-sentinel",
      });
      expect(loadEnv("test", emptyEnvironmentDirectory!, "")).not.toMatchObject(
        {
          PALE_ORBIT_E2E_SENTINEL_ENV: expect.anything(),
          PALE_ORBIT_E2E_SENTINEL_LOCAL: expect.anything(),
        },
      );

      const normalEnvironment = {
        ...webEnvironment,
        PALE_ORBIT_E2E_ENV_ISOLATION: undefined,
        PALE_ORBIT_E2E_EMPTY_ENV_DIR: undefined,
      };
      const normal = serverConfigEnvironmentResult(normalEnvironment);
      expect(normal.status, normal.stderr).toBe(0);
      expect(JSON.parse(normal.stdout)).toEqual({
        viteEnvDir: null,
        svelteEnvDir: null,
      });

      const invalidEnvironments: NodeJS.ProcessEnv[] = [
        {
          ...webEnvironment,
          PALE_ORBIT_E2E_EMPTY_ENV_DIR: undefined,
        },
        {
          ...webEnvironment,
          PALE_ORBIT_E2E_EMPTY_ENV_DIR: "relative-empty-env",
        },
        {
          ...webEnvironment,
          PALE_ORBIT_E2E_ENV_ISOLATION: "true",
        },
        {
          ...webEnvironment,
          PALE_ORBIT_E2E_EMPTY_ENV_DIR: nonemptyDirectory,
        },
        {
          ...webEnvironment,
          PALE_ORBIT_E2E_EMPTY_ENV_DIR: outsideDirectory,
        },
      ];
      for (const invalidEnvironment of invalidEnvironments) {
        const invalid = serverConfigEnvironmentResult(invalidEnvironment);
        expect(invalid.status, invalid.stdout).not.toBe(0);
        expect(invalid.stderr).not.toContain("private-env-sentinel");
        expect(invalid.stderr).not.toContain("private-local-sentinel");
      }
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
      await rm(ownedRoot, { recursive: true, force: true });
      await rm(outsideDirectory, { recursive: true, force: true });
    }
  }, 120_000);

  it("removes direct and file-based Stripe secrets from every child environment", () => {
    expect(
      withoutStripeProviderSecrets({
        PATH: "safe-path",
        STRIPE_SECRET_KEY: "sk_test_private",
        STRIPE_SECRET_KEY_FILE: "/run/secrets/stripe-key",
        STRIPE_WEBHOOK_SECRET: "whsec_private",
        STRIPE_WEBHOOK_SECRET_FILE: "/run/secrets/stripe-webhook",
      }),
    ).toEqual({ PATH: "safe-path" });
  });

  it("requires the reusable financial harness and both financial browser journeys", async () => {
    const presence = await Promise.all(
      Object.entries(requiredFinancialE2ESources).map(async ([name, path]) => {
        try {
          await readFile(path, "utf8");
          return [name, true] as const;
        } catch (error: unknown) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            return [name, false] as const;
          }
          throw error;
        }
      }),
    );
    expect(Object.fromEntries(presence)).toEqual({
      financialHarness: true,
      refundReviewJourney: true,
      salesReportingJourney: true,
    });
  });

  it("keeps the financial harness on the spawned-worker control boundary", async () => {
    const source = await readFile(financialHarnessPath, "utf8");
    const facts = sourceFacts(financialHarnessPath, source);
    const workerControlModule = localModuleIdentity(
      financialHarnessPath,
      "$lib/server/jobs/test-worker-control",
    );
    const forbiddenModuleRoots = [
      "$lib/server/commerce/financial/admin-commands/executors",
      "$lib/server/commerce/financial/admin-commands/handler",
      "$lib/server/commerce/financial/refund-review/corrections",
      "$lib/server/commerce/financial/refund-review/drafts",
      "$lib/server/commerce/financial/refund-review/finalize",
      "$lib/server/commerce/financial/refund-review/recovery",
      "$lib/server/commerce/stripe/runtime",
      "$lib/server/commerce/stripe/runtime-core",
      "$lib/server/commerce/stripe/sdk-gateway",
      "stripe",
    ].map((specifier) => localModuleIdentity(financialHarnessPath, specifier));
    const routeRoot = resolve(repositoryRoot, "src/routes");

    expect([...facts.importedModules]).toContain(workerControlModule);
    expect([
      ...(facts.importedValueNames.get(workerControlModule) ?? []),
    ]).toContain("createTestWorkerControlHarness");
    expect(
      [...facts.importedModules].filter((module) =>
        forbiddenModuleRoots.some((boundary) =>
          matchesModuleBoundary(module, boundary),
        ),
      ),
    ).toEqual([]);
    expect(
      [...facts.importedModules].filter(
        (module) => isAbsolute(module) && isAtOrWithinPath(routeRoot, module),
      ),
    ).toEqual([]);

    const forbiddenRouteExports = new Set([
      "DELETE",
      "GET",
      "HEAD",
      "OPTIONS",
      "PATCH",
      "POST",
      "PUT",
      "actions",
      "fallback",
    ]);
    expect(
      [...facts.exportedNames].filter((name) =>
        forbiddenRouteExports.has(name),
      ),
    ).toEqual([]);

    const forbiddenDirectValues = new Set([
      "financialAdminCommands",
      "financialAdminJobClaims",
    ]);
    expect(
      [...facts.referencedNames].filter((name) =>
        forbiddenDirectValues.has(name),
      ),
    ).toEqual([]);

    const forbiddenExecutableSeams = new Set([
      "createFinancialAdminCommandExecutors",
      "createFinancialAdminCommandHandler",
      "createStripeSdkGateway",
      "createStripeWorkerRuntime",
      "executeAdministrativeRecoveryActivate",
      "executeAdministrativeRecoveryDeactivate",
      "executeRefundAllocationFinalize",
      "executeRefundDraftDiscard",
      "executeRefundDraftSave",
      "executeReportingCorrectionCreate",
    ]);
    expect(
      [...facts.calledNames].filter((name) =>
        forbiddenExecutableSeams.has(name),
      ),
    ).toEqual([]);
  });

  it("bounds and matches privacy-first financial audit evidence exactly", async () => {
    const {
      assertPrivacyFirstFinancialAuditSignatures,
      cloneBoundedFinancialAuditProjection,
      requireCompleteFinancialAuditCommandSelection,
      requireExactFinancialAuditSignatures,
      requireOptionalFinancialReconciliationAuditCardinality,
    } = await import("../tests/e2e/financial-harness");
    const harnessSource = await readFile(financialHarnessPath, "utf8");
    const refundSource = await readFile(
      requiredFinancialE2ESources.refundReviewJourney,
      "utf8",
    );

    const collisionRecord = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(collisionRecord, "__proto__", {
      enumerable: true,
      value: "private proto audit value",
    });
    collisionRecord["left|right"] = "private delimiter audit value";
    const cloned = cloneBoundedFinancialAuditProjection([
      {
        requestMetadata: null,
        before: null,
        after: collisionRecord,
      },
    ]);
    expect(JSON.stringify(cloned)).toContain("private proto audit value");
    expect(JSON.stringify(cloned)).toContain("private delimiter audit value");

    const accessor = {};
    Object.defineProperty(accessor, "private", {
      enumerable: true,
      get: () => "private accessor audit value",
    });
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const sparse = new Array(2);
    sparse[1] = "private sparse audit value";
    let tooDeep: unknown = "private deep audit value";
    for (let index = 0; index < 18; index += 1) {
      tooDeep = { child: tooDeep };
    }
    const tooManyNodes = Array.from({ length: 4_096 }, () =>
      Array.from({ length: 17 }, () => null),
    );
    const tooManyBytes = Array.from({ length: 160 }, () => "x".repeat(16_000));
    for (const invalid of [
      accessor,
      cyclic,
      sparse,
      new Date("2026-08-23T00:00:00.000Z"),
      tooDeep,
      "x".repeat(16_385),
      Array.from({ length: 4_097 }, () => null),
      tooManyNodes,
      tooManyBytes,
    ]) {
      expect(() => cloneBoundedFinancialAuditProjection([invalid])).toThrow(
        "Financial audit evidence bound or shape failure",
      );
    }

    const expectedSignature = {
      action: "financial.refund_draft.created",
      outcome: "succeeded",
      resourceType: "refund_allocation_draft",
      resourceId: "00000000-0000-4000-8000-000000000641",
      correlationId: "left|right",
      actorType: "user",
      actorId: "00000000-0000-4000-8000-000000000642",
    } as const;
    expect(() =>
      requireExactFinancialAuditSignatures(
        [expectedSignature],
        [expectedSignature],
      ),
    ).not.toThrow();
    for (const [actual, expected] of [
      [[expectedSignature, expectedSignature], [expectedSignature]],
      [[expectedSignature], [expectedSignature, expectedSignature]],
      [
        [{ ...expectedSignature, correlationId: "left" }],
        [{ ...expectedSignature, correlationId: "left|right" }],
      ],
      [
        [{ ...expectedSignature, action: "financial.unknown" }],
        [expectedSignature],
      ],
    ] as const) {
      expect(() =>
        requireExactFinancialAuditSignatures(actual, expected),
      ).toThrow("Financial audit evidence did not match its expected multiset");
    }

    let projectedPrivateRows = false;
    expect(() =>
      assertPrivacyFirstFinancialAuditSignatures({
        boundedRawRows: [{ privateCanary: "private audit canary" }],
        privateValues: ["private audit canary"],
        expected: [expectedSignature],
        projectActual: () => {
          projectedPrivateRows = true;
          return [{ ...expectedSignature, action: "financial.unknown" }];
        },
      }),
    ).toThrow("Sensitive commerce data detected on financial audit");
    expect(projectedPrivateRows).toBe(false);
    expect(() =>
      requireCompleteFinancialAuditCommandSelection(
        [expectedSignature.resourceId],
        [expectedSignature.resourceId],
      ),
    ).not.toThrow();
    for (const selected of [
      [],
      [expectedSignature.resourceId, expectedSignature.resourceId],
      ["00000000-0000-4000-8000-000000000643"],
    ]) {
      expect(() =>
        requireCompleteFinancialAuditCommandSelection(selected, [
          expectedSignature.resourceId,
        ]),
      ).toThrow(
        "Financial audit command selection did not cover retained evidence",
      );
    }

    expect(
      requireOptionalFinancialReconciliationAuditCardinality({
        eventCount: 0,
        exactCount: 0,
      }),
    ).toBe(false);
    expect(
      requireOptionalFinancialReconciliationAuditCardinality({
        eventCount: 1,
        exactCount: 1,
      }),
    ).toBe(true);
    for (const invalid of [
      { eventCount: 1, exactCount: 0 },
      { eventCount: 2, exactCount: 2 },
      { eventCount: 0, exactCount: 1 },
      { eventCount: -1, exactCount: -1 },
      { eventCount: 0.5, exactCount: 0 },
    ]) {
      expect(() =>
        requireOptionalFinancialReconciliationAuditCardinality(invalid),
      ).toThrow("Financial reconciliation audit cardinality was invalid");
    }

    expect(harnessSource).toMatch(
      /requestMetadata:\s*auditEvents\.requestMetadata/u,
    );
    expect(harnessSource).toMatch(/before:\s*auditEvents\.before/u);
    expect(harnessSource).toMatch(/after:\s*auditEvents\.after/u);
    expect(harnessSource).toMatch(/\.limit\(MAX_AUDIT_EVIDENCE_ROWS \+ 1\)/u);
    expect(harnessSource).toMatch(/pg_column_size/u);
    expect(harnessSource).toMatch(/octet_length/u);
    const auditReaderSource = harnessSource.slice(
      harnessSource.indexOf("async function readAuditEvidence"),
      harnessSource.indexOf("async function readEmailEvidence"),
    );
    expect(auditReaderSource).toMatch(
      /assertPrivacyFirstFinancialAuditSignatures\(\{\s*boundedRawRows/u,
    );
    expect(auditReaderSource).toMatch(/expectedResourceIds/u);
    expect(auditReaderSource).toMatch(
      /selectedCommands\.map\(\(command\) => command\.commandId\)/u,
    );
    expect(auditReaderSource).toMatch(/scalarsCharacterBounded/u);
    expect(auditReaderSource).toMatch(/actorIdBytes/u);
    const scalarCharacterBoundsSource = auditReaderSource.slice(
      auditReaderSource.indexOf("scalarsCharacterBounded"),
      auditReaderSource.indexOf("actorIdBytes"),
    );
    expect(scalarCharacterBoundsSource).toMatch(
      /char_length\(\$\{auditEvents\.actorType\}::text\)/u,
    );
    expect(scalarCharacterBoundsSource).toMatch(
      /char_length\(\$\{auditEvents\.outcome\}::text\)/u,
    );
    expect(auditReaderSource).toMatch(
      /actorTypeBytes:\s*sql<number>`octet_length\(\$\{auditEvents\.actorType\}::text\)::integer`/u,
    );
    expect(auditReaderSource).toMatch(
      /outcomeBytes:\s*sql<number>`octet_length\(\$\{auditEvents\.outcome\}::text\)::integer`/u,
    );
    const perFieldByteBoundsSource = auditReaderSource.slice(
      auditReaderSource.indexOf("payloadBounds.some"),
      auditReaderSource.indexOf("const aggregatePayloadBytes"),
    );
    expect(perFieldByteBoundsSource).toMatch(/row\.actorTypeBytes/u);
    expect(perFieldByteBoundsSource).toMatch(/row\.outcomeBytes/u);
    const aggregateByteBoundsSource = auditReaderSource.slice(
      auditReaderSource.indexOf("const aggregatePayloadBytes"),
      auditReaderSource.indexOf("aggregatePayloadBytes >"),
    );
    expect(aggregateByteBoundsSource).toMatch(/row\.actorTypeBytes/u);
    expect(aggregateByteBoundsSource).toMatch(/row\.outcomeBytes/u);
    expect(auditReaderSource).toMatch(
      /aggregatePayloadBytes[\s\S]*MAX_AUDIT_PROJECTION_BYTES/u,
    );
    expect(auditReaderSource).toMatch(
      /isolationLevel:\s*["']repeatable read["']/u,
    );
    expect(auditReaderSource).toMatch(/accessMode:\s*["']read only["']/u);
    expect(harnessSource).toMatch(/payloadExpectations/u);
    expect(harnessSource).not.toMatch(/readonly rawRows:/u);
    expect(harnessSource).not.toMatch(/readonly unclassifiedRows:/u);
    expect(refundSource).not.toMatch(/audit\.rawRows|audit\.unclassifiedRows/u);
  }, 15_000);

  it("waits through terminal invalidation requests and their body tasks", async () => {
    const {
      settleFinancialCaptureOperation,
      waitForFinancialCaptureSettlement,
    } = await import("../tests/e2e/financial-harness");
    let pending = 0;
    let firstBarrier = true;
    const observations: number[] = [];

    await waitForFinancialCaptureSettlement({
      signal: AbortSignal.timeout(1_000),
      pending: () => pending,
      barrier: async () => {
        await Promise.resolve();
        if (firstBarrier) {
          firstBarrier = false;
          pending = 2;
        }
        observations.push(pending);
      },
      pause: async () => {
        pending -= 1;
      },
    });

    expect(observations).toEqual([2, 1, 0, 0]);
    const source = await readFile(financialHarnessPath, "utf8");
    expect(source).toMatch(/page\.on\("request", onCaptureRequest\)/u);
    expect(source).toMatch(
      /page\.on\("requestfinished", onCaptureRequestSettled\)/u,
    );
    expect(source).toMatch(
      /page\.on\("requestfailed", onCaptureRequestSettled\)/u,
    );
    expect(source).toMatch(
      /page\.off\("requestfinished", onCaptureRequestSettled\)/u,
    );
    expect(source).toMatch(
      /page\.off\("requestfailed", onCaptureRequestSettled\)/u,
    );
    expect(source.match(/waitForFinancialCaptureSettlement\(/gu)).toHaveLength(
      3,
    );
    expect(source).toMatch(
      /if \(page\.isClosed\(\)\) \{\s*failures\.push\("capture-settlement-page-closed"\)/u,
    );
    expect(source).not.toMatch(
      /if \(page\.isClosed\(\)\) \{\s*if \(inFlightRequests\.size/u,
    );
    const runCommandStart = source.indexOf("async function runCommand");
    const runCommandSource = source.slice(
      runCommandStart,
      source.indexOf("async function readRefundState", runCommandStart),
    );
    expect(runCommandSource).toMatch(
      /const activeSession = await workerControl\.pause\([\s\S]*await settlePageCaptures\(input\.page\);\s*await input\.submit\(\)/u,
    );
    expect(runCommandSource).toMatch(
      /const refundCommandPath = `\/admin\/sales\/refunds\/\$\{refundId\}`;[\s\S]*const refundCommandRoute = \(url: URL\): boolean =>[\s\S]*url\.origin === origin && url\.pathname === refundCommandPath/u,
    );
    expect(runCommandSource).toMatch(
      /input\.page\.route\(refundCommandRoute, onRoute\)/u,
    );
    expect(runCommandSource).toMatch(
      /input\.page\.unroute\(refundCommandRoute, onRoute\)/u,
    );
    expect(runCommandSource).not.toContain('"**/admin/sales/refunds/**"');
    expect(runCommandSource).toMatch(
      /requestUrl\.pathname === refundCommandPath[\s\S]*request\.resourceType\(\) === "document"[\s\S]*request\.isNavigationRequest\(\)[\s\S]*request\.frame\(\) === input\.page\.mainFrame\(\)/u,
    );
    const submitIndex = runCommandSource.indexOf("await input.submit()");
    const earlyUnrouteIndex = runCommandSource.indexOf(
      "await input.page.unroute(refundCommandRoute, onRoute)",
      submitIndex,
    );
    expect(earlyUnrouteIndex).toBeGreaterThan(submitIndex);
    expect(earlyUnrouteIndex).toBeLessThan(
      runCommandSource.indexOf("commandId = assertCanonicalUuid"),
    );
    const capturePageSource = source.slice(
      source.indexOf("async function capturePage"),
      source.indexOf("async function mainEvidence"),
    );
    expect(source).toMatch(
      /const MAX_FINANCIAL_DURABLE_TOTAL_BYTES = 16 \* 1024 \* 1024/u,
    );
    expect(source).toMatch(
      /const MAX_FINANCIAL_DURABLE_RESOURCE_BYTES = 2 \* 1024 \* 1024/u,
    );
    expect(capturePageSource).toMatch(
      /settleFinancialCaptureOperation\(\{[\s\S]*operation: page\.context\(\)\.newCDPSession\(page\),[\s\S]*disposeLate:/u,
    );
    expect(capturePageSource).toMatch(
      /settleFinancialCaptureOperation\(\{[\s\S]*operation: durableResponseSession\.send\("Network\.enable", \{[\s\S]*maxTotalBufferSize: MAX_FINANCIAL_DURABLE_TOTAL_BYTES,[\s\S]*maxResourceBufferSize: MAX_FINANCIAL_DURABLE_RESOURCE_BYTES,[\s\S]*enableDurableMessages: true/u,
    );
    expect(source).toMatch(
      /async function disposeDurableResponseSession[\s\S]*operation = session\.detach\(\)[\s\S]*settleFinancialCaptureOperation\(\{[\s\S]*operation,/u,
    );

    expect(
      await settleFinancialCaptureOperation({
        operation: Promise.resolve("complete"),
        timeoutMs: 50,
      }),
    ).toEqual({ status: "complete", value: "complete" });
    expect(
      await settleFinancialCaptureOperation({
        operation: Promise.reject(new Error("private failure")),
        timeoutMs: 50,
      }),
    ).toEqual({ status: "failed" });
    let resolveLate: ((value: string) => void) | undefined;
    const lateValues: string[] = [];
    const lateOperation = new Promise<string>((resolve) => {
      resolveLate = resolve;
    });
    expect(
      await settleFinancialCaptureOperation({
        operation: lateOperation,
        timeoutMs: 5,
        disposeLate: async (value) => {
          lateValues.push(value);
          throw new Error("private late disposal failure");
        },
      }),
    ).toEqual({ status: "timeout" });
    resolveLate?.("late-session");
    await vi.waitFor(() => expect(lateValues).toEqual(["late-session"]));
    await expect(
      settleFinancialCaptureOperation({
        operation: Promise.resolve(undefined),
        timeoutMs: 0,
      }),
    ).rejects.toThrow("Financial capture operation timeout was invalid");
  });

  it("retains bounded request and Location evidence for generic financial redirects", async () => {
    const { projectFinancialNoBodyResponseEvidence } =
      await import("../tests/e2e/financial-harness");
    const { assertCommercePrivacy } =
      await import("../tests/e2e/commerce-privacy");
    const requestCanary = "private-request-query-canary";
    const locationCanary = "private-location-header-canary";
    const evidence = projectFinancialNoBodyResponseEvidence({
      applicationOrigin: "http://127.0.0.1:4173",
      requestUrl: `http://127.0.0.1:4173/admin/sales?value=${requestCanary}`,
      status: 303,
      location: `/admin/sales?value=${locationCanary}#return`,
    });
    expect(evidence).toEqual({
      requestUrl: `/admin/sales?value=${requestCanary}`,
      status: 303,
      location: {
        authority: "same-origin",
        value: `/admin/sales?value=${locationCanary}#return`,
      },
    });
    for (const canary of [requestCanary, locationCanary]) {
      expect(() =>
        assertCommercePrivacy("financial json", evidence, [canary]),
      ).toThrow("Sensitive commerce data detected on financial json");
    }
    for (const invalid of [
      {
        requestUrl: "http://127.0.0.1:4173/claim/complete",
        location: "/library",
      },
      {
        requestUrl: "http://127.0.0.1:4173/admin/sales",
        location: "x".repeat(65_537),
      },
      {
        requestUrl: "http://127.0.0.1:4173/admin/sales",
        location: "http://[malformed",
      },
    ]) {
      expect(() =>
        projectFinancialNoBodyResponseEvidence({
          applicationOrigin: "http://127.0.0.1:4173",
          requestUrl: invalid.requestUrl,
          status: 303,
          location: invalid.location,
        }),
      ).toThrow("Financial no-body response evidence was invalid");
    }
    const source = await readFile(financialHarnessPath, "utf8");
    expect(source).toMatch(/projectFinancialNoBodyResponseEvidence\(\{/u);
  });

  it("validates recovery revocation through a driver-stable boolean", async () => {
    const source = await readFile(financialHarnessPath, "utf8");
    const commandAuditSource = source.slice(
      source.indexOf("async function retainFinancialCommandAudit"),
      source.indexOf("async function createRefundFixture"),
    );
    expect(commandAuditSource).toContain(
      'recovery.revoked_at is not null as "revokedAtPresent"',
    );
    expect(commandAuditSource).toMatch(
      /grant\.revokedAtPresent !== \(expectedState === "revoked"\)/u,
    );
    expect(commandAuditSource).not.toContain("revokedAt instanceof Date");
  });

  it("rejects response bodies beyond the explicit retained byte bound", async () => {
    const { requireBoundedFinancialResponseBody } =
      await import("../tests/e2e/financial-harness");
    const exactAscii = "a".repeat(2 * 1024 * 1024);
    expect(requireBoundedFinancialResponseBody(exactAscii)).toBe(exactAscii);
    for (const invalid of [
      `${exactAscii}a`,
      "é".repeat(1024 * 1024 + 1),
      new Uint8Array(0),
    ]) {
      expect(() => requireBoundedFinancialResponseBody(invalid)).toThrow(
        "Financial response body exceeded its bound",
      );
    }
    const source = await readFile(financialHarnessPath, "utf8");
    const responseTaskStart = source.indexOf("const task = response");
    const responseTaskEnd = source.indexOf(
      "const onDownload",
      responseTaskStart,
    );
    expect(responseTaskStart).toBeGreaterThanOrEqual(0);
    expect(responseTaskEnd).toBeGreaterThan(responseTaskStart);
    const responseTaskSource = source.slice(responseTaskStart, responseTaskEnd);
    const bodyBoundCall = "requireBoundedFinancialResponseBody(rawBody)";
    expect(responseTaskSource.split(bodyBoundCall)).toHaveLength(2);
    const bodyReadIndex = responseTaskSource.indexOf(".text()");
    const bodyBoundIndex = responseTaskSource.indexOf(bodyBoundCall);
    expect(bodyReadIndex).toBeGreaterThanOrEqual(0);
    expect(bodyBoundIndex).toBeGreaterThan(bodyReadIndex);
    for (const consumer of [
      "body.match(",
      "parseInitialFinancialHydration(body)",
      "financialPageDataBody(body)",
      "responses.push(",
    ]) {
      expect(responseTaskSource.indexOf(consumer)).toBeGreaterThan(
        bodyBoundIndex,
      );
    }
    expect(responseTaskSource).toMatch(
      /try \{\s*body = requireBoundedFinancialResponseBody\(rawBody\);\s*\} catch \{\s*failures\.push\("financial-response-body-bound-exceeded"\);\s*return;\s*\}/u,
    );
  });

  it("proves every financial redirect is unambiguously framed as bodyless", async () => {
    const { requireFinancialRedirectBodylessFraming } =
      await import("../tests/e2e/financial-harness");
    const bodyless = {
      headers: [
        { name: "content-length", value: "0" },
        { name: "location", value: "/admin/sales" },
      ],
      sizes: {
        requestBodySize: 512,
        requestHeadersSize: 1_024,
        responseBodySize: 0,
        responseHeadersSize: 768,
      },
    } as const;
    expect(() =>
      requireFinancialRedirectBodylessFraming(bodyless),
    ).not.toThrow();
    for (const invalid of [
      {
        ...bodyless,
        headers: [{ name: "location", value: "/admin/sales" }],
      },
      {
        ...bodyless,
        headers: [
          { name: "content-length", value: "0" },
          { name: "content-length", value: "0" },
        ],
      },
      {
        ...bodyless,
        headers: [{ name: "content-length", value: "1" }],
      },
      {
        ...bodyless,
        headers: [
          { name: "content-length", value: "0" },
          { name: "transfer-encoding", value: "chunked" },
        ],
      },
      {
        ...bodyless,
        headers: [
          { name: "content-length", value: "0" },
          { name: "content-encoding", value: "gzip" },
        ],
      },
      {
        ...bodyless,
        headers: [
          { name: "content-length", value: "0" },
          { name: "trailer", value: "digest" },
        ],
      },
      {
        ...bodyless,
        sizes: { ...bodyless.sizes, responseBodySize: 1 },
      },
      {
        ...bodyless,
        sizes: { ...bodyless.sizes, requestBodySize: -1 },
      },
      {
        ...bodyless,
        sizes: { ...bodyless.sizes, requestHeadersSize: 0.5 },
      },
      {
        ...bodyless,
        sizes: {
          ...bodyless.sizes,
          responseHeadersSize: 2 * 1024 * 1024 + 1,
        },
      },
      {
        headers: bodyless.headers,
        sizes: { ...bodyless.sizes, unexpected: 0 },
      },
    ]) {
      expect(() => requireFinancialRedirectBodylessFraming(invalid)).toThrow(
        "Financial redirect framing evidence was invalid",
      );
    }

    const source = await readFile(financialHarnessPath, "utf8");
    const capturePageSource = source.slice(
      source.indexOf("async function capturePage"),
      source.indexOf("async function mainEvidence"),
    );
    const redirectCaptureSource = capturePageSource.slice(
      capturePageSource.indexOf("const captureRedirectNoBody"),
      capturePageSource.indexOf("const onCaptureRequest"),
    );
    expect(redirectCaptureSource).toMatch(
      /Promise\.all\(\[\s*response\.headersArray\(\),\s*response\.request\(\)\.sizes\(\),?\s*\]\)/u,
    );
    expect(redirectCaptureSource).not.toMatch(/response\.text\(\)/u);
    expect(redirectCaptureSource).toMatch(/responseTasks\.add\(task\)/u);
    expect(redirectCaptureSource).toMatch(
      /failures\.push\("financial-redirect-framing-capture-failed"\)/u,
    );
    expect(
      capturePageSource.match(/captureRedirectNoBody\(response\)/gu),
    ).toHaveLength(3);
    expect(capturePageSource).toMatch(
      /response\.status\(\) !== 304[\s\S]*\[204, 205, 304\]\.includes\(response\.status\(\)\)/u,
    );
  });

  it("registers Sales audit-only canaries and proves both console capture paths", async () => {
    const harnessSource = await readFile(financialHarnessPath, "utf8");
    const salesSource = await readFile(
      requiredFinancialE2ESources.salesReportingJourney,
      "utf8",
    );
    const purchaseSource = harnessSource.slice(
      harnessSource.indexOf("async function createSalesPurchase"),
      harnessSource.indexOf("async function insertSalesAllocationSet"),
    );
    const allocationSource = harnessSource.slice(
      harnessSource.indexOf("async function insertSalesAllocationSet"),
      harnessSource.indexOf("async function createSalesBalanceEvidence"),
    );
    const balanceSource = harnessSource.slice(
      harnessSource.indexOf("async function createSalesBalanceEvidence"),
      harnessSource.indexOf("async function insertSalesPayout"),
    );
    const payoutSource = harnessSource.slice(
      harnessSource.indexOf("async function insertSalesPayout"),
      harnessSource.indexOf("async function publishSalesPayoutMembership"),
    );
    const payoutMembershipSource = harnessSource.slice(
      harnessSource.indexOf("async function publishSalesPayoutMembership"),
      harnessSource.indexOf("async function seedSalesReportingMatrix"),
    );
    const salesSeedSource = harnessSource.slice(
      harnessSource.indexOf("async function seedSalesReportingMatrix"),
      harnessSource.indexOf("function onceSalesCleanup"),
    );

    expect(purchaseSource).toMatch(
      /const checkoutAttemptId = randomUUID\(\)[\s\S]*const privateValues = \[[\s\S]*checkoutAttemptId/u,
    );
    expect(purchaseSource).toMatch(
      /const quoteFingerprintSha256 = `\$\{compactUuid\(\)\}\$\{compactUuid\(\)\}`[\s\S]*const statusTokenSha256 = `\$\{compactUuid\(\)\}\$\{compactUuid\(\)\}`[\s\S]*statusTokenSha256 === quoteFingerprintSha256/u,
    );
    expect(purchaseSource).toMatch(
      /const privateValues = \[[\s\S]*quoteFingerprintSha256,[\s\S]*statusTokenSha256,/u,
    );
    expect(purchaseSource).toMatch(
      /client_checkout_attempt_id,[\s\S]*quote_fingerprint_sha256,[\s\S]*status_token_sha256[\s\S]*values \([^;]*\$6,[\s\S]*\$7, \$8, \$9\)[\s\S]*checkoutAttemptId,[\s\S]*quoteFingerprintSha256,[\s\S]*statusTokenSha256,[\s\S]*input\.paidAt/u,
    );
    expect(purchaseSource).not.toMatch(
      /repeat\(['"]a['"], 64\)|repeat\(['"]b['"], 64\)/u,
    );
    expect(purchaseSource).toMatch(
      /privateValues\.push\(id, lineItemProviderId\)/u,
    );
    expect(allocationSource).toMatch(
      /const allocationIdentity = privateProviderId\("sales_allocation"\)/u,
    );
    expect(allocationSource).toMatch(
      /const tieBreakKey = privateProviderId\("sales_tie"\)[\s\S]*privateValues\.push\(tieBreakKey\)/u,
    );
    expect(allocationSource).not.toMatch(
      /\[\s*allocationSetId,\s*privateProviderId\("sales_allocation"\)/u,
    );
    expect(balanceSource).toMatch(
      /const privateValues = \[\s*balanceTransactionId,\s*providerId,\s*fingerprint,?\s*\]/u,
    );
    expect(balanceSource).toMatch(
      /privateValues\.push\(detailId, detailFingerprint\)/u,
    );
    expect(balanceSource).toMatch(
      /privateValues:\s*\[[\s\S]*\.\.\.grossAllocation\.privateValues[\s\S]*\.\.\.feeAllocation\.privateValues/u,
    );
    expect(salesSeedSource).toMatch(
      /privateValues\.push\(\.\.\.evidence\.privateValues\)/u,
    );
    expect(payoutSource).toMatch(
      /const fingerprint = compactUuid\(\)\.repeat\(2\)/u,
    );
    expect(payoutSource).not.toMatch(
      /\[\s*payoutId,[\s\S]*compactUuid\(\)\.repeat\(2\)/u,
    );
    expect(payoutSource).toMatch(
      /return \{\s*id: payoutId,\s*privateValues: \[fingerprint\],?\s*\}/u,
    );
    expect(payoutMembershipSource).toMatch(/return \[runId\] as const/u);
    expect(salesSeedSource).toMatch(
      /const rememberPayout = [\s\S]*privateValues\.push\(\.\.\.payout\.privateValues\)[\s\S]*return payout\.id/u,
    );
    expect(salesSeedSource).toMatch(
      /privateValues\.push\(\s*\.\.\.\(await publishSalesPayoutMembership\(/u,
    );
    expect(salesSeedSource).toMatch(
      /const withdrawalAllocationIdentity = privateProviderId\(\s*"sales_dispute_presentment"[\s\S]*const reinstatementAllocationIdentity = privateProviderId\(\s*"sales_dispute_presentment"[\s\S]*privateValues\.push\([^;]*withdrawalAllocationIdentity,[^;]*reinstatementAllocationIdentity[^;]*\);/u,
    );
    for (const privateValue of [
      "refundId",
      "refundAllocationId",
      "disputeId",
      "withdrawalAllocationId",
      "pendingRefundId",
      "failureBalanceTransactionId",
      "failureBalanceFingerprint",
      "dummyBalanceTransactionId",
      "dummyFingerprint",
      "supersededAllocationId",
      "inactiveClassificationId",
    ]) {
      expect(salesSeedSource).toMatch(
        new RegExp(
          `privateValues\\.push\\([^;]*\\b${privateValue}\\b[^;]*\\);`,
          "u",
        ),
      );
    }

    expect(
      salesSource.match(/FINANCIAL_CAPTURE_STRUCTURED_CONSOLE_WITNESS/gu),
    ).toHaveLength(2);
    expect(salesSource).toMatch(
      /for \(const consoleWitness of \[[\s\S]*FINANCIAL_CAPTURE_CONSOLE_WITNESS[\s\S]*FINANCIAL_CAPTURE_STRUCTURED_CONSOLE_WITNESS[\s\S]*\]\)[\s\S]*requireCapturedSalesWitness\([\s\S]*normalizedConsole[\s\S]*consoleWitness/u,
    );
  });

  it("keeps Sales range transitions manual and the unfiltered empty witness reversible", async () => {
    const harnessSource = await readFile(financialHarnessPath, "utf8");
    const salesSource = await readFile(
      requiredFinancialE2ESources.salesReportingJourney,
      "utf8",
    );
    const isolatedCohortSource = harnessSource.slice(
      harnessSource.indexOf("async function withIsolatedEmptyDefaultSalesCohort"),
      harnessSource.indexOf("async function seedSalesReportingMatrix"),
    );
    const rangeTransitionSource = salesSource.slice(
      salesSource.indexOf("// BEGIN manual Sales range transition witness."),
      salesSource.indexOf("// END manual Sales range transition witness."),
    );
    const mutationTransactionStart = isolatedCohortSource.indexOf(
      "await inSalesOwnerTransaction(async () => {",
    );
    const mutationCommitMarker = "\n      });";
    const mutationCommitStart = isolatedCohortSource.indexOf(
      mutationCommitMarker,
      mutationTransactionStart,
    );
    const protectedTryStart = isolatedCohortSource.indexOf(
      "\n      try {",
      mutationCommitStart,
    );
    const protectedCatchStart = isolatedCohortSource.indexOf(
      "\n      } catch (reason: unknown) {",
      protectedTryStart,
    );

    expect(isolatedCohortSource).toMatch(/withWorkerClaimBarrier/u);
    expect(isolatedCohortSource).toMatch(/with utc_clock as materialized/u);
    expect(isolatedCohortSource.match(/clock_timestamp\(\)/gu)).toHaveLength(1);
    expect(isolatedCohortSource).toMatch(
      /select distinct orders\.id::text as "orderId",[\s\S]*orders\.paid_at::text as "paidAt"/u,
    );
    expect(isolatedCohortSource).toMatch(
      /set local session_replication_role = replica[\s\S]*update orders[\s\S]*set paid_at/u,
    );
    expect(mutationTransactionStart).toBeGreaterThanOrEqual(0);
    expect(mutationCommitStart).toBeGreaterThan(mutationTransactionStart);
    expect(protectedTryStart).toBeGreaterThan(mutationCommitStart);
    expect(protectedCatchStart).toBeGreaterThan(protectedTryStart);
    expect(
      isolatedCohortSource.slice(
        mutationCommitStart + mutationCommitMarker.length,
        protectedTryStart,
      ),
    ).not.toMatch(/\bawait\b/u);
    expect(
      isolatedCohortSource.slice(protectedTryStart, protectedCatchStart),
    ).toMatch(
      /const remaining = await readDefaultCohort\(\);[\s\S]*Sales default cohort was not isolated[\s\S]*await action\(\)/u,
    );
    expect(isolatedCohortSource).toMatch(
      /catch \(reason: unknown\)[\s\S]*status: "rejected"[\s\S]*\} finally \{[\s\S]*original\."paidAt"/u,
    );
    expect(isolatedCohortSource).toMatch(
      /assertExactSalesCohortRows\([\s\S]*"mutated"[\s\S]*assertExactSalesCohortRows\([\s\S]*"restored"/u,
    );
    expect(isolatedCohortSource).not.toMatch(
      /delete from|truncate|(?:select|returning)[^;]*email/iu,
    );

    expect(salesSource).toMatch(
      /withIsolatedEmptyDefaultSalesCohort\(async \(\) => \{[\s\S]*goto\("\/admin\/sales"\)[\s\S]*waitForSalesFilterHydration[\s\S]*No sales data yet[\s\S]*aria-live[\s\S]*0 matching sales rows\./u,
    );
    expect(salesSource).toMatch(
      /function waitForSalesFilterHydration[\s\S]*new FormDataEvent\("formdata"[\s\S]*!formData\.has\("from"\)[\s\S]*!formData\.has\("to"\)/u,
    );
    expect(salesSource).toMatch(/No sales match these filters/u);
    expect(rangeTransitionSource).toMatch(
      /getByLabel\("Range"\)\.selectOption\("all"\)[\s\S]*getByRole\("button", \{ name: "Apply filters" \}\)\s*\.click\(\)/u,
    );
    expect(rangeTransitionSource).toMatch(
      /getByLabel\("Range"\)\.selectOption\("custom"\)[\s\S]*getByLabel\("From date"\)\s*\.fill[\s\S]*getByLabel\("To date"\)\.fill[\s\S]*getByRole\("button", \{ name: "Apply filters" \}\)\s*\.click\(\)/u,
    );
    expect(rangeTransitionSource).not.toMatch(/applyFilters\(/u);
  });

  it("retains every non-public Sales export-bound backing identifier", async () => {
    const harnessSource = await readFile(financialHarnessPath, "utf8");
    const exportBoundSource = harnessSource.slice(
      harnessSource.indexOf("async function seedSalesExportBound"),
      harnessSource.indexOf("async function close()"),
    );

    expect(exportBoundSource).toMatch(
      /const readSalesExportPrivateValues = async \([\s\S]*expectedOrderCount[\s\S]*expectedItemCount/u,
    );
    expect(exportBoundSource).toMatch(
      /select[\s\S]*o\.id::text as "orderId"[\s\S]*o\.client_checkout_attempt_id::text as "checkoutAttemptId"[\s\S]*p\.id::text as "paymentId"[\s\S]*oi\.id::text as "orderItemId"/u,
    );
    expect(exportBoundSource).toMatch(
      /limit \$2[\s\S]*expectedItemCount \+ 1/u,
    );
    expect(exportBoundSource).toMatch(
      /rows\.length !== expectedItemCount[\s\S]*orderIds\.size !== expectedOrderCount[\s\S]*checkoutAttemptIds\.size !== expectedOrderCount[\s\S]*paymentIds\.size !== expectedOrderCount[\s\S]*orderItemIds\.size !== expectedItemCount/u,
    );
    expect(exportBoundSource).not.toMatch(
      /select[\s\S]*title_id::text as "titleId"/u,
    );
    expect(
      exportBoundSource.match(
        /privateValues:\s*\[[\s\S]*?\.\.\.backingPrivateValues,[\s\S]*?buyerEmail,[\s\S]*?paymentIntentPrefix,[\s\S]*?lineItemPrefix,[\s\S]*?quoteFingerprint,[\s\S]*?statusTokenHash[\s\S]*?\]/gu,
      ),
    ).toHaveLength(2);
  });

  it("retains Refund checkout and digest backing canaries", async () => {
    const harnessSource = await readFile(financialHarnessPath, "utf8");
    const refundFixtureSource = harnessSource.slice(
      harnessSource.indexOf("async function createRefundFixture"),
      harnessSource.indexOf("async function runCommand"),
    );

    expect(refundFixtureSource).toMatch(
      /const clientCheckoutAttemptId = randomUUID\(\)/u,
    );
    expect(refundFixtureSource).toMatch(
      /const quoteFingerprintSha256 = `\$\{compactUuid\(\)\}\$\{compactUuid\(\)\}`/u,
    );
    expect(refundFixtureSource).toMatch(
      /const statusTokenSha256 = `\$\{compactUuid\(\)\}\$\{compactUuid\(\)\}`/u,
    );
    expect(refundFixtureSource).toMatch(
      /const fixturePrivateValues = \[[\s\S]*purchaserUserId === null[\s\S]*purchaserUserId[\s\S]*guestIdentityId === null[\s\S]*guestIdentityId[\s\S]*paymentId,[\s\S]*clientCheckoutAttemptId,[\s\S]*quoteFingerprintSha256,[\s\S]*statusTokenSha256,/u,
    );
    expect(refundFixtureSource).toMatch(
      /clientCheckoutAttemptId,[\s\S]*quoteFingerprintSha256,[\s\S]*statusTokenSha256,/u,
    );
    expect(refundFixtureSource).not.toMatch(
      /clientCheckoutAttemptId: randomUUID\(\)|quoteFingerprintSha256: ["']a["']\.repeat\(64\)|statusTokenSha256: ["']b["']\.repeat\(64\)/u,
    );
    expect(refundFixtureSource).toMatch(
      /const browserPrivateValues = \[\.\.\.fixturePrivateValues\];/u,
    );
  });

  it("registers the claimed account identity once before claim evidence completes", async () => {
    const harnessSource = await readFile(financialHarnessPath, "utf8");
    const claimStateSource = harnessSource.slice(
      harnessSource.indexOf("async function readClaimState"),
      harnessSource.indexOf("async function readRefundState"),
    );

    expect(claimStateSource).toMatch(
      /const claimedByUserId = assertCanonicalUuid\(\s*row\.claimedByUserId,\s*"Financial claimed account ID",?\s*\)/u,
    );
    expect(claimStateSource).toMatch(
      /const stored = refundFixtures\.get\(fixture\.refundId\)[\s\S]*stored === undefined[\s\S]*!stored\.browserPrivateValues\.includes\(claimedByUserId\)[\s\S]*stored\.browserPrivateValues\.push\(claimedByUserId\)[\s\S]*return "claimed"/u,
    );
    expect(claimStateSource).not.toMatch(
      /browserPrivateValues\.push\(row\.claimedByUserId\)/u,
    );
  });

  it("bounds every financial capture task drain", async () => {
    const { drainFinancialCaptureTasks } =
      await import("../tests/e2e/financial-harness");
    expect(
      await drainFinancialCaptureTasks(new Set([Promise.resolve()]), 50),
    ).toBe("complete");
    expect(
      await drainFinancialCaptureTasks(
        new Set([Promise.reject(new Error("private capture rejection"))]),
        50,
      ),
    ).toBe("failed");
    const startedAt = Date.now();
    expect(
      await drainFinancialCaptureTasks(
        new Set([new Promise<void>(() => {})]),
        20,
      ),
    ).toBe("timeout");
    expect(Date.now() - startedAt).toBeLessThan(500);

    const source = await readFile(financialHarnessPath, "utf8");
    expect(source).not.toMatch(/while \(responseTasks\.size > 0\)/u);
    expect(source).not.toMatch(
      /await Promise\.all\(\[\.\.\.capture\.responseTasks\]\)/u,
    );
  });

  it("extracts native POST action data from the validated hydration envelope", async () => {
    const { parseInitialFinancialHydration } =
      await import("../tests/e2e/financial-harness");
    const postDocument = `<script>
      app.start({
        node_ids: [0, 2],
        data: [{"layout":true},{"detail":{"soldAsTitle":"Public title"}}],
        form: {"command":{"commandId":"00000000-0000-4000-8000-000000000701","status":"pending"},"message":"embedded }, error: text"},
        error: null
      });
    </script>`;
    const getDocument = postDocument.replace(
      /form: \{[^\n]+\},/u,
      "form: null,",
    );

    const post = parseInitialFinancialHydration(postDocument);
    expect(post).not.toBeNull();
    expect(JSON.parse(post!.pageData)).toEqual({
      detail: { soldAsTitle: "Public title" },
    });
    expect(JSON.parse(post!.actionData!)).toMatchObject({
      command: {
        commandId: "00000000-0000-4000-8000-000000000701",
        status: "pending",
      },
    });
    expect(parseInitialFinancialHydration(getDocument)).toMatchObject({
      actionData: null,
    });
    expect(
      parseInitialFinancialHydration(
        postDocument.replace(/,\s*error:\s*null/u, ", status: 200"),
      ),
    ).toBeNull();
    const deepLeaf = `${"[".repeat(34)}{"detail":"bounded"}${"]".repeat(34)}`;
    expect(
      parseInitialFinancialHydration(
        postDocument.replace(
          '{"detail":{"soldAsTitle":"Public title"}}',
          deepLeaf,
        ),
      ),
    ).toBeNull();
    const nodeIds = Array.from({ length: 65 }, (_, index) => String(index));
    const nodeData = nodeIds.map((_, index) =>
      index === nodeIds.length - 1 ? '{"detail":"bounded"}' : "null",
    );
    expect(
      parseInitialFinancialHydration(`<script>app.start({
        node_ids: [${nodeIds.join(",")}],
        data: [${nodeData.join(",")}],
        form: null,
        error: null
      });</script>`),
    ).toBeNull();
    expect(
      parseInitialFinancialHydration(
        postDocument.replace(
          '{"detail":{"soldAsTitle":"Public title"}}',
          JSON.stringify("x".repeat(1_048_577)),
        ),
      ),
    ).toBeNull();
    expect(
      parseInitialFinancialHydration(`${"x".repeat(2_097_153)}${postDocument}`),
    ).toBeNull();
    expect(
      parseInitialFinancialHydration(`${postDocument}${postDocument}`),
    ).toBeNull();
  });

  it("rejects hydration form evidence that disagrees with the document method", async () => {
    const { financialDocumentHydrationMethodValid } =
      await import("../tests/e2e/financial-harness");

    expect(financialDocumentHydrationMethodValid("GET", null)).toBe(true);
    expect(
      financialDocumentHydrationMethodValid("POST", '{"command":"pending"}'),
    ).toBe(true);
    expect(
      financialDocumentHydrationMethodValid("GET", '{"private":"stale"}'),
    ).toBe(false);
    expect(financialDocumentHydrationMethodValid("POST", null)).toBe(false);
    expect(financialDocumentHydrationMethodValid("PUT", null)).toBe(false);
  });

  it("rejects malformed or non-null hydration error evidence", async () => {
    const { parseInitialFinancialHydration } =
      await import("../tests/e2e/financial-harness");
    const document = `<script>app.start({
      node_ids: [0],
      data: [{"page":true}],
      form: null,
      error: null
    });</script>`;

    for (const invalidError of [
      `{"message":"private-hydration-error-canary"}`,
      "",
      `[{"nested":true}`,
    ]) {
      expect(
        parseInitialFinancialHydration(
          document.replace("error: null", `error: ${invalidError}`),
        ),
      ).toBeNull();
    }
  });

  it("binds financial commands to an exact refund preparation page", async () => {
    const { financialCommandRefundIdFromPageUrl } =
      await import("../tests/e2e/financial-harness");
    const refundId = "00000000-0000-4000-8000-000000000711";
    const origin = "http://127.0.0.1:4173";
    for (const suffix of [
      "",
      "?/prepareFinalize",
      "?/prepareCorrection",
      "?/prepareRecoveryActivation",
      "?/prepareRecoveryDeactivation",
      "?/prepareFinalize&reviewCursor=bounded_cursor-1",
    ]) {
      expect(
        financialCommandRefundIdFromPageUrl(
          `${origin}/admin/sales/refunds/${refundId}${suffix}`,
          origin,
        ),
      ).toBe(refundId);
    }
    for (const candidate of [
      `${origin}/admin/sales/refunds/${refundId}?/confirmFinalize`,
      `${origin}/admin/sales/refunds/${refundId}?/prepareFinalize&extra=1`,
      `${origin}/admin/sales/refunds/${refundId}?/prepareFinalize&reviewCursor=`,
      `${origin}/admin/sales/refunds/${refundId}?/prepareFinalize&reviewCursor=one&reviewCursor=two`,
      `${origin}/admin/sales/refunds/${refundId}#/prepareFinalize`,
      `https://elsewhere.example.test/admin/sales/refunds/${refundId}`,
    ]) {
      expect(() =>
        financialCommandRefundIdFromPageUrl(candidate, origin),
      ).toThrow("Financial command page identity was invalid");
    }
  });

  it("captures bounded nested console arguments and safe Error fields", async () => {
    const {
      captureFinancialConsoleArguments,
      normalizeFinancialConsoleEvidenceForPrivacy,
      serializeFinancialConsoleValue,
    } = await import("../tests/e2e/financial-harness");
    const nested = serializeFinancialConsoleValue({
      nested: { email: "private-console@example.test" },
    });
    const cause = new Error("private nested cause");
    const aggregateMember = new Error("private aggregate member");
    const aggregate = Object.assign(
      new AggregateError([aggregateMember], "private top-level failure", {
        cause,
      }),
      { diagnostic: "private custom Error field" },
    );
    delete cause.stack;
    delete aggregateMember.stack;
    delete aggregate.stack;
    const error = serializeFinancialConsoleValue(aggregate);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const collisionError = new Error("collision witness");
    delete collisionError.stack;
    Object.defineProperty(collisionError, "__proto__", {
      value: "private proto error field",
    });
    Object.defineProperty(collisionError, Symbol("same"), {
      value: "private first symbol error field",
    });
    Object.defineProperty(collisionError, Symbol("same"), {
      value: "private second symbol error field",
    });
    const collisionEvidence = JSON.stringify(
      serializeFinancialConsoleValue(collisionError),
    );
    const builtins: object[] = [
      [],
      () => {},
      new Date("2026-08-23T00:00:00.000Z"),
      /console-witness/gu,
      new Map([["safe", "value"]]),
      new Set(["safe"]),
      new URL("https://example.test/safe"),
    ];
    const builtinEvidence = builtins.map((value, index) => {
      Object.defineProperty(value, "diagnostic", {
        value: `private builtin field ${index}`,
      });
      Object.defineProperty(value, Symbol("same"), {
        value: `private builtin symbol ${index}`,
      });
      return JSON.stringify(serializeFinancialConsoleValue(value));
    });
    const accessorError = new Error("accessor witness");
    delete accessorError.stack;
    Object.defineProperty(accessorError, "diagnostic", {
      get: () => "private accessor value",
    });
    const typeError = new TypeError("private type error message");
    delete typeError.stack;
    const inheritedNameError = new Error("inherited name witness");
    delete inheritedNameError.stack;
    const inheritedNamePrototype = Object.create(Error.prototype) as object;
    Object.defineProperty(inheritedNamePrototype, "name", {
      value: "PrivateInheritedErrorName",
    });
    Object.setPrototypeOf(inheritedNameError, inheritedNamePrototype);
    const inheritedAccessorError = new Error("inherited accessor witness");
    delete inheritedAccessorError.stack;
    const inheritedAccessorPrototype = Object.create(Error.prototype) as object;
    Object.defineProperty(inheritedAccessorPrototype, "name", {
      get: () => "private inherited accessor name",
    });
    Object.setPrototypeOf(inheritedAccessorError, inheritedAccessorPrototype);

    expect(JSON.stringify(nested)).toContain("private-console@example.test");
    expect(error).toMatchObject({
      ok: true,
      value: {
        type: "Error",
        name: "AggregateError",
        message: "private top-level failure",
        cause: {
          type: "Error",
          name: "Error",
          message: "private nested cause",
        },
      },
    });
    expect(JSON.stringify(error)).toContain("private custom Error field");
    expect(JSON.stringify(error)).toContain("private aggregate member");
    expect(serializeFinancialConsoleValue(cyclic)).toEqual({
      ok: false,
      failure: "cycle",
    });
    expect(collisionEvidence).toContain("private proto error field");
    expect(collisionEvidence).toContain("private first symbol error field");
    expect(collisionEvidence).toContain("private second symbol error field");
    for (const [index, evidence] of builtinEvidence.entries()) {
      expect(evidence).toContain(`private builtin field ${index}`);
      expect(evidence).toContain(`private builtin symbol ${index}`);
    }
    expect(serializeFinancialConsoleValue(accessorError)).toEqual({
      ok: false,
      failure: "accessor",
    });
    expect(serializeFinancialConsoleValue(typeError)).toMatchObject({
      ok: true,
      value: { type: "Error", name: "TypeError" },
    });
    expect(serializeFinancialConsoleValue(inheritedNameError)).toMatchObject({
      ok: true,
      value: { type: "Error", name: "PrivateInheritedErrorName" },
    });
    expect(serializeFinancialConsoleValue(inheritedAccessorError)).toEqual({
      ok: false,
      failure: "accessor",
    });

    const textOnlyMessage = {
      args: vi.fn(() => []),
      type: vi.fn(() => "warning"),
      text: vi.fn(() => "private zero-handle console canary"),
      location: vi.fn(() => ({
        url: "https://books.example.test/private-console-source.js",
        lineNumber: 17,
        columnNumber: 23,
      })),
    };
    const textOnlyEvidence: string[] = [];
    const textOnlyFailures: string[] = [];
    await captureFinancialConsoleArguments(
      textOnlyMessage as never,
      textOnlyEvidence,
      textOnlyFailures,
    );
    expect(textOnlyFailures).toEqual([]);
    expect(textOnlyEvidence.map((entry) => JSON.parse(entry))).toEqual([
      {
        type: "warning",
        text: "private zero-handle console canary",
        location: {
          url: "https://books.example.test/private-console-source.js",
          lineNumber: 17,
          columnNumber: 23,
        },
        arguments: [],
      },
    ]);
    const normalizedConsole = normalizeFinancialConsoleEvidenceForPrivacy(
      [
        JSON.stringify({
          type: "warning",
          text: "http://127.0.0.1:4173/private-text-canary",
          location: {
            url: "http://127.0.0.1:4173/source.js?part=1#frame",
            lineNumber: 17,
            columnNumber: 23,
          },
          arguments: ["http://127.0.0.1:4173/private-argument-canary"],
        }),
        JSON.stringify({
          type: "warning",
          text: "safe",
          location: {
            url: "https://elsewhere.example.test/source.js",
            lineNumber: 1,
            columnNumber: 2,
          },
          arguments: [],
        }),
        JSON.stringify({
          pageError: {
            type: "Error",
            name: "Error",
            message: "http://127.0.0.1:4173/private-page-error-canary",
          },
        }),
      ],
      "http://127.0.0.1:4173",
      "https://books.example.test",
    );
    expect(normalizedConsole).toEqual([
      {
        type: "warning",
        text: "http://127.0.0.1:4173/private-text-canary",
        location: {
          url: "https://books.example.test/source.js?part=1#frame",
          lineNumber: 17,
          columnNumber: 23,
        },
        arguments: ["http://127.0.0.1:4173/private-argument-canary"],
      },
      {
        type: "warning",
        text: "safe",
        location: {
          url: "https://elsewhere.example.test/source.js",
          lineNumber: 1,
          columnNumber: 2,
        },
        arguments: [],
      },
      {
        pageError: {
          type: "Error",
          name: "Error",
          message: "http://127.0.0.1:4173/private-page-error-canary",
        },
      },
    ]);

    for (const [message, detail] of [
      [
        {
          args: vi.fn(() => []),
          type: vi.fn(() => "warning"),
          text: vi.fn(() => {
            throw new Error("private console text read failure");
          }),
          location: vi.fn(() => ({
            url: "https://books.example.test/safe.js",
            lineNumber: 1,
            columnNumber: 1,
          })),
        },
        "text",
      ],
      [
        {
          args: vi.fn(() => []),
          type: vi.fn(() => "warning"),
          text: vi.fn(() => "safe console text"),
          location: vi.fn(() => {
            throw new Error("private console location read failure");
          }),
        },
        "location",
      ],
    ] as const) {
      const evidence: string[] = [];
      const failures: string[] = [];
      await captureFinancialConsoleArguments(
        message as never,
        evidence,
        failures,
      );
      expect(evidence).toEqual([]);
      expect(failures).toEqual([
        "console-message-capture-failed",
        `console-message-capture-detail-${detail}`,
      ]);
    }

    const rejectedHandle = {
      evaluate: vi
        .fn()
        .mockRejectedValue(new Error("private browser evaluation failure")),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    const rejectedMessage = {
      args: vi.fn(() => [rejectedHandle]),
      type: vi.fn(() => "error"),
      text: vi.fn(() => "safe rejected-handle text"),
      location: vi.fn(() => ({
        url: "https://books.example.test/safe.js",
        lineNumber: 1,
        columnNumber: 1,
      })),
    };
    const rejectedEvidence: string[] = [];
    const rejectedFailures: string[] = [];
    await captureFinancialConsoleArguments(
      rejectedMessage as never,
      rejectedEvidence,
      rejectedFailures,
    );
    expect(rejectedEvidence).toEqual([]);
    expect(rejectedFailures).toEqual([
      "console-argument-capture-failed",
      "console-argument-capture-detail-handle-error",
    ]);
    expect(rejectedHandle.evaluate).toHaveBeenCalledOnce();
    expect(rejectedHandle.dispose).toHaveBeenCalledOnce();

    const source = await readFile(financialHarnessPath, "utf8");
    const salesSource = await readFile(
      requiredFinancialE2ESources.salesReportingJourney,
      "utf8",
    );
    expect(source).toMatch(/message\.args\(\)/u);
    expect(source).toMatch(/message\.text\(\)/u);
    expect(source).toMatch(/message\.location\(\)/u);
    expect(source).toMatch(/handle\.dispose\(\)/u);
    expect(source).toMatch(/console-argument-capture-(?:failed|timeout)/u);
    expect(source).toMatch(/console-argument-disposal-(?:failed|timeout)/u);
    expect(source).toMatch(/page\.on\(["']pageerror["']/u);
    expect(source).toMatch(/page-error-observed/u);
    expect(salesSource).toMatch(
      /normalizeFinancialConsoleEvidenceForPrivacy\(/u,
    );
    expect(salesSource).not.toMatch(
      /privacyEvidence\.console\.map\([\s\S]{0,200}replaceAll/u,
    );
  });
});
