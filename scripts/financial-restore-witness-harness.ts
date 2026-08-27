import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
export const restoreVerifierWitnessPath = fileURLToPath(
  new URL('./execute-financial-restore-verifier.ts', import.meta.url)
);
const withTestDatabasePath = fileURLToPath(new URL('./with-test-database.ts', import.meta.url));
const databaseRoleProvisionUrl = new URL(
  '../src/lib/server/db/database-role-provision.ts',
  import.meta.url
).href;
export const ownerRestoreVerifierLauncher = `
import { spawnSync } from 'node:child_process';
import { databaseEnvironmentForRole } from ${JSON.stringify(databaseRoleProvisionUrl)};
const [verifierPath, ...verifierArguments] = process.argv.slice(1);
const migrationWebUser = process.env.DATABASE_USER;
const migrationWorkerUser = process.env.DATABASE_WORKER_USER;
const migrationStorageCleanupUser = process.env.DATABASE_STORAGE_CLEANUP_USER;
if (!migrationWebUser || !migrationWorkerUser || !migrationStorageCleanupUser) {
  throw new Error('restore verifier migration identities are required');
}
const ownerEnvironment = databaseEnvironmentForRole(process.env, 'owner');
ownerEnvironment.DATABASE_MIGRATION_WEB_USER = migrationWebUser;
ownerEnvironment.DATABASE_MIGRATION_WORKER_USER = migrationWorkerUser;
ownerEnvironment.DATABASE_MIGRATION_STORAGE_CLEANUP_USER = migrationStorageCleanupUser;
const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', verifierPath, ...verifierArguments],
  { env: ownerEnvironment, stdio: 'inherit' }
);
process.exit(result.status ?? 1);
`;
// Keep the harness itself on direct Node. On Windows, `npx tsx` consumes nested
// child Node flags, while the harness also needs npm_execpath inherited from Vitest.

function directNodeHarnessEnvironment(): NodeJS.ProcessEnv {
  if (process.platform === 'win32' && !process.env.npm_execpath?.trim()) {
    throw new Error('npm_execpath is required for the direct Node test-database harness');
  }
  return process.env;
}

export const financialWitnessHarnessTimeoutMs = 2_400_000;
const financialWitnessCloseGraceMs = 15_000;
export const financialWitnessTestTimeoutMs = 2_700_000;
const testDatabaseProjectPattern = /^pale-orbit-test-[0-9a-f]{16}$/u;
const testStorageDirectoryPattern = /^pale-orbit-test-storage-[A-Za-z0-9_-]+$/u;
const composeTestFilePath = resolve(
  fileURLToPath(new URL('../compose.test.yaml', import.meta.url))
);

type TestDockerResourceKind = 'container' | 'network' | 'volume';

export interface FinancialHarnessDockerResource {
  readonly id: string;
  readonly kind: TestDockerResourceKind;
  readonly labels: Readonly<Record<string, string>>;
}

export interface BoundedFinancialWitnessHarnessResult {
  readonly cleanup: string | null;
  readonly signal: NodeJS.Signals | null;
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly timedOut: boolean;
}

export interface FinancialWitnessHarnessClose {
  readonly signal: NodeJS.Signals | null;
  readonly status: number | null;
}

export async function waitForFinancialWitnessHarnessClose(
  close: Promise<FinancialWitnessHarnessClose>,
  timeoutMs: number
): Promise<FinancialWitnessHarnessClose | null> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      close,
      new Promise<null>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(null), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function identifiers(output: string): string[] {
  return output.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
}

function financialHarnessDockerCommand(
  arguments_: readonly string[],
  timeout = 15_000
): string {
  const result = spawnSync('docker', [...arguments_], {
    cwd: new URL('.', root),
    encoding: 'utf8',
    timeout
  });
  if (result.status !== 0) {
    const detail = `${result.stdout}${result.stderr}`.trim();
    throw new Error(
      `docker ${arguments_.join(' ')} exited with ${result.status ?? 'no status'}${
        detail ? `: ${detail}` : ''
      }`
    );
  }
  return result.stdout.trim();
}

function financialHarnessResourceIds(
  kind: TestDockerResourceKind,
  project?: string
): string[] {
  const filter = project
    ? `label=com.docker.compose.project=${project}`
    : 'label=com.docker.compose.project';
  const arguments_ = kind === 'container'
    ? ['ps', '--all', '--quiet', '--filter', filter]
    : [kind, 'ls', '--quiet', '--filter', filter];
  return identifiers(financialHarnessDockerCommand(arguments_));
}

function financialHarnessExactResourceIds(
  kind: TestDockerResourceKind,
  name: string
): string[] {
  const filter = kind === 'container' ? `name=^/${name}$` : `name=^${name}$`;
  const arguments_ = kind === 'container'
    ? ['ps', '--all', '--quiet', '--filter', filter]
    : [kind, 'ls', '--quiet', '--filter', filter];
  return identifiers(financialHarnessDockerCommand(arguments_));
}

function financialHarnessResourceLabels(
  kind: TestDockerResourceKind,
  id: string
): Readonly<Record<string, string>> {
  const labels = kind === 'container' ? '.Config.Labels' : '.Labels';
  const serialized = financialHarnessDockerCommand([
    kind,
    'inspect',
    '--format',
    `{{ json ${labels} }}`,
    id
  ]);
  const parsed = JSON.parse(serialized) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`invalid Docker labels for ${kind} ${id}`);
  }
  return parsed as Record<string, string>;
}

function financialHarnessDockerSnapshot(): Map<string, FinancialHarnessDockerResource> {
  const resources = new Map<string, FinancialHarnessDockerResource>();
  for (const kind of ['container', 'network', 'volume'] as const) {
    for (const id of financialHarnessResourceIds(kind)) {
      resources.set(`${kind}:${id}`, {
        id,
        kind,
        labels: financialHarnessResourceLabels(kind, id)
      });
    }
  }
  return resources;
}

function testStorageDirectories(): Set<string> {
  const temporaryRoot = resolve(tmpdir());
  return new Set(
    readdirSync(tmpdir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && testStorageDirectoryPattern.test(entry.name))
      .map((entry) => resolve(temporaryRoot, entry.name))
  );
}

export function exactNewFinancialHarnessProject(
  baseline: ReadonlyMap<string, FinancialHarnessDockerResource>,
  current: ReadonlyMap<string, FinancialHarnessDockerResource>
): string {
  const newProjects = new Set<string>();
  for (const [key, resource] of current) {
    if (baseline.has(key)) continue;
    const project = resource.labels['com.docker.compose.project'];
    if (project && testDatabaseProjectPattern.test(project)) newProjects.add(project);
  }
  if (newProjects.size !== 1) {
    throw new Error(
      `expected exactly one new test project, found ${newProjects.size}: ${
        [...newProjects].join(', ')
      }`
    );
  }
  return [...newProjects][0]!;
}

export function exactNewFinancialHarnessStorageDirectory(
  baseline: ReadonlySet<string>,
  current: ReadonlySet<string>
): string | null {
  const added = [...current].filter((path) => !baseline.has(path));
  if (added.length > 1) {
    throw new Error(`refusing ambiguous new test storage directories: ${added.join(', ')}`);
  }
  return added[0] ?? null;
}

function dockerLabelsFingerprint(labels: Readonly<Record<string, string>>): string {
  return JSON.stringify(Object.entries(labels).sort(([left], [right]) =>
    left.localeCompare(right, 'en')
  ));
}

export function assertFinancialHarnessProjectOwned(
  project: string,
  baseline: ReadonlyMap<string, FinancialHarnessDockerResource>
): void {
  if (!testDatabaseProjectPattern.test(project)) {
    throw new Error(`refusing invalid test database project ${project}`);
  }
  const projectResources = (['container', 'network', 'volume'] as const).flatMap(
    (kind) => financialHarnessResourceIds(kind, project).map((id) => ({ id, kind }))
  );
  if (projectResources.length === 0) {
    throw new Error(`refusing empty test database project snapshot for ${project}`);
  }
  for (const { id, kind } of projectResources) {
    const key = `${kind}:${id}`;
    if (baseline.has(key)) {
      throw new Error(`refusing baseline ${kind} ${id} while cleaning ${project}`);
    }
    const labels = financialHarnessResourceLabels(kind, id);
    if (labels['com.docker.compose.project'] !== project) {
      throw new Error(`refusing foreign ${kind} ${id} while cleaning ${project}`);
    }
  }
  const exactResources: ReadonlyArray<readonly [TestDockerResourceKind, string]> = [
    ['container', `${project}-postgres-1`],
    ['container', `${project}-mailpit-1`],
    ['network', `${project}_default`]
  ];
  for (const [kind, name] of exactResources) {
    const ids = financialHarnessExactResourceIds(kind, name);
    if (ids.length > 1) {
      throw new Error(`expected at most one exact-name ${kind} ${name}, found ${ids.length}`);
    }
    for (const id of ids) {
      const key = `${kind}:${id}`;
      if (baseline.has(key)) {
        throw new Error(`refusing baseline exact-name ${kind} ${name}`);
      }
      const labels = financialHarnessResourceLabels(kind, id);
      if (labels['com.docker.compose.project'] !== project) {
        throw new Error(`refusing foreign exact-name ${kind} ${name}`);
      }
      if (kind === 'container') {
        const configFiles = labels['com.docker.compose.project.config_files']
          ?.split(',')
          .map((value) => value.trim())
          .filter(Boolean) ?? [];
        if (
          configFiles.length !== 1 ||
          resolve(configFiles[0]!) !== composeTestFilePath
        ) {
          throw new Error(
            `refusing ${kind} ${name} with unexpected Compose config path ${
              configFiles.join(', ') || '<missing>'
            }`
          );
        }
      }
    }
  }
}

function cleanupTimedOutFinancialWitnessHarness(
  baselineResources: ReadonlyMap<string, FinancialHarnessDockerResource>,
  baselineStorageDirectories: ReadonlySet<string>,
  harnessOutput: string
): string {
  const cleanupActions: string[] = [];
  const cleanupFailures: string[] = [];
  try {
    const currentResources = financialHarnessDockerSnapshot();
    const project = exactNewFinancialHarnessProject(baselineResources, currentResources);
    const outputProjects = new Set(
      harnessOutput.match(/pale-orbit-test-[0-9a-f]{16}/gu) ?? []
    );
    if (
      outputProjects.size > 0 &&
      !outputProjects.has(project)
    ) {
      throw new Error(
        `new test project ${project} is absent from the supervised harness output`
      );
    }
    assertFinancialHarnessProjectOwned(project, baselineResources);
    financialHarnessDockerCommand([
      'compose',
      '--project-name',
      project,
      '--file',
      composeTestFilePath,
      'down', '--volumes', '--remove-orphans'
    ], 60_000);
    const remaining = (['container', 'network', 'volume'] as const)
      .flatMap((kind) => financialHarnessResourceIds(kind, project));
    if (remaining.length > 0) {
      throw new Error(`test project ${project} remained after timeout cleanup`);
    }
    for (const [kind, name] of [
      ['container', `${project}-postgres-1`],
      ['container', `${project}-mailpit-1`],
      ['network', `${project}_default`]
    ] as const) {
      if (financialHarnessExactResourceIds(kind, name).length > 0) {
        throw new Error(`exact-name ${kind} ${name} remained after timeout cleanup`);
      }
    }
    const afterCleanup = financialHarnessDockerSnapshot();
    for (const [key, baselineResource] of baselineResources) {
      const survivingResource = afterCleanup.get(key);
      if (
        !survivingResource ||
        dockerLabelsFingerprint(survivingResource.labels) !==
          dockerLabelsFingerprint(baselineResource.labels)
      ) {
        throw new Error(`baseline Docker resource ${key} changed during timeout cleanup`);
      }
    }
    cleanupActions.push(`removed exact Compose project ${project}`);
  } catch (error) {
    cleanupFailures.push(error instanceof Error ? error.message : String(error));
  }

  try {
    const storagePath = exactNewFinancialHarnessStorageDirectory(
      baselineStorageDirectories,
      testStorageDirectories()
    );
    if (storagePath) {
      const temporaryRoot = resolve(tmpdir());
      const storageDirectory = storagePath.slice(temporaryRoot.length + 1);
      if (
        dirname(storagePath) !== temporaryRoot ||
        !testStorageDirectoryPattern.test(storageDirectory)
      ) {
        throw new Error(`refusing unexpected test storage path ${storagePath}`);
      }
      rmSync(storagePath, { force: true, recursive: true });
      if (existsSync(storagePath)) {
        throw new Error(`test storage directory ${storagePath} remained after timeout cleanup`);
      }
      cleanupActions.push(`removed exact test storage directory ${storageDirectory}`);
    }
  } catch (error) {
    cleanupFailures.push(error instanceof Error ? error.message : String(error));
  }

  if (cleanupFailures.length > 0) {
    throw new Error(`financial witness timeout cleanup failed: ${cleanupFailures.join('; ')}`);
  }
  return cleanupActions.length > 0
    ? cleanupActions.join('; ')
    : 'no new exact test resources remained';
}

function terminateFinancialWitnessHarnessProcessTree(processId: number): string | null {
  try {
    if (process.platform === 'win32') {
      const result = spawnSync(
        'taskkill.exe',
        ['/pid', String(processId), '/T', '/F'],
        { encoding: 'utf8', timeout: 30_000, windowsHide: true }
      );
      if (result.status !== 0) {
        return `taskkill exited with ${result.status ?? 'no status'}: ${
          `${result.stdout}${result.stderr}`.trim()
        }`;
      }
      return null;
    }
    process.kill(-processId, 'SIGKILL');
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function runBoundedFinancialWitnessHarness(): Promise<BoundedFinancialWitnessHarnessResult> {
  const baselineResources = financialHarnessDockerSnapshot();
  const baselineStorageDirectories = testStorageDirectories();
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      withTestDatabasePath,
      process.execPath,
      '--import',
      'tsx',
      '--input-type=module',
      '--eval',
      ownerRestoreVerifierLauncher,
      restoreVerifierWitnessPath,
      '--exercise-financial-invariant-witnesses'
    ],
    {
      cwd: new URL('.', root),
      detached: process.platform !== 'win32',
      env: directNodeHarnessEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });

  const close = new Promise<FinancialWitnessHarnessClose>((resolveClose, rejectClose) => {
    child.once('error', rejectClose);
    child.once('close', (status, signal) => resolveClose({ signal, status }));
  });
  const closedBeforeDeadline = await waitForFinancialWitnessHarnessClose(
    close,
    financialWitnessHarnessTimeoutMs
  );
  if (closedBeforeDeadline) {
    return {
      ...closedBeforeDeadline,
      cleanup: null,
      stderr,
      stdout,
      timedOut: false
    };
  }

  const terminationFailures: string[] = [];
  let treeKillSucceeded = false;
  if (child.pid === undefined) {
    terminationFailures.push('supervised harness has no process id');
  } else {
    const treeKillFailure = terminateFinancialWitnessHarnessProcessTree(child.pid);
    if (treeKillFailure) terminationFailures.push(`process-tree kill: ${treeKillFailure}`);
    else treeKillSucceeded = true;
  }
  let closedAfterTermination = await waitForFinancialWitnessHarnessClose(
    close,
    financialWitnessCloseGraceMs
  );
  if (!closedAfterTermination) {
    if (child.pid !== undefined) {
      const retryFailure = terminateFinancialWitnessHarnessProcessTree(child.pid);
      if (retryFailure) terminationFailures.push(`process-tree kill retry: ${retryFailure}`);
      else treeKillSucceeded = true;
    }
    try {
      if (!child.kill('SIGKILL')) {
        terminationFailures.push('direct fallback kill did not signal the harness');
      }
    } catch (error) {
      terminationFailures.push(
        `direct fallback kill: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    closedAfterTermination = await waitForFinancialWitnessHarnessClose(
      close,
      financialWitnessCloseGraceMs
    );
  }

  const refuseTimeoutCleanup = (reason: string): BoundedFinancialWitnessHarnessResult => {
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
    return {
      cleanup: `timeout cleanup refused because ${reason}${
        terminationFailures.length > 0 ? `; ${terminationFailures.join('; ')}` : ''
      }`,
      signal: null,
      status: null,
      stderr,
      stdout,
      timedOut: true
    };
  };
  if (!closedAfterTermination) {
    return refuseTimeoutCleanup('the supervised harness did not close');
  }
  if (!treeKillSucceeded) {
    return refuseTimeoutCleanup('exact process-tree termination was not confirmed');
  }

  let cleanup: string;
  try {
    cleanup = cleanupTimedOutFinancialWitnessHarness(
      baselineResources,
      baselineStorageDirectories,
      `${stdout}${stderr}`
    );
  } catch (error) {
    cleanup = error instanceof Error ? error.message : String(error);
  }
  if (terminationFailures.length > 0) {
    cleanup = `${cleanup}; ${terminationFailures.join('; ')}`;
  }
  return { ...closedAfterTermination, cleanup, stderr, stdout, timedOut: true };
}
