import { randomBytes as nodeRandomBytes } from 'node:crypto';
import {
  lstat as nodeLstat,
  readFile as nodeReadFile,
  realpath as nodeRealpath,
  rename as nodeRename,
  unlink as nodeUnlink,
  writeFile as nodeWriteFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { FinancialAdminPermanentError } from '$lib/server/commerce/financial/admin-commands/errors';
import type { FinancialAdminCommandExecutor } from '$lib/server/commerce/financial/admin-commands/handler';
import type { FinancialAdminCommandKind } from '$lib/types/financial-reporting';

export const TEST_WORKER_CONTROL_REQUEST_BASENAME = 'worker.control.json';
export const TEST_WORKER_CONTROL_ACKNOWLEDGEMENT_BASENAME =
  'worker.control.ack.json';
export const TEST_WORKER_CONTROL_DEADLINE_MS = 5_000;

const REQUEST_TEMP_BASENAME = 'worker.control.tmp';
const ACKNOWLEDGEMENT_TEMP_BASENAME = 'worker.control.ack.tmp';
const CONTROL_POLL_INTERVAL_MS = 10;
const TEST_PROJECT = /^pale-orbit-test-[0-9a-f]{16}$/u;
const NONCE = /^[0-9a-f]{32}$/u;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CANONICAL_PORT = /^[1-9][0-9]{3,4}$/u;
const OWNED_STORAGE_ROOT = /^pale-orbit-test-storage-.+/u;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const FORBIDDEN_WORKER_SETTINGS = [
  'DATABASE_URL',
  'DATABASE_USER',
  'DATABASE_USER_FILE',
  'DATABASE_PASSWORD',
  'DATABASE_PASSWORD_FILE',
  'DATABASE_OWNER_USER',
  'DATABASE_OWNER_USER_FILE',
  'DATABASE_OWNER_PASSWORD',
  'DATABASE_OWNER_PASSWORD_FILE',
  'DATABASE_STORAGE_CLEANUP_USER',
  'DATABASE_STORAGE_CLEANUP_USER_FILE',
  'DATABASE_STORAGE_CLEANUP_PASSWORD',
  'DATABASE_STORAGE_CLEANUP_PASSWORD_FILE'
] as const;

export type TestWorkerControlRequest =
  | { readonly version: 1; readonly nonce: string; readonly phase: 'pause' }
  | {
      readonly version: 1;
      readonly nonce: string;
      readonly phase: 'release';
      readonly failCommandId?: string;
    };

export type TestWorkerControlAcknowledgement = {
  readonly version: 1;
  readonly nonce: string;
  readonly phase: 'paused' | 'released';
};

interface TestWorkerControlStat {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface TestWorkerControlFileSystem {
  lstat(path: string): Promise<TestWorkerControlStat>;
  realpath(path: string): Promise<string>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  writeFile(
    path: string,
    data: string,
    options: { readonly encoding: 'utf8'; readonly flag: 'wx' }
  ): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

interface ControlPaths {
  readonly root: string;
  readonly ready: string;
  readonly request: string;
  readonly acknowledgement: string;
  readonly requestTemp: string;
  readonly acknowledgementTemp: string;
}

interface ControlDependencies {
  readonly fileSystem: TestWorkerControlFileSystem;
  readonly now: () => number;
  readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface WorkerPause {
  readonly nonce: string;
}

interface TestWorkerControlInternal {
  readonly active: boolean;
  decorateFinancialAdminExecutors(
    executors: ReadonlyMap<FinancialAdminCommandKind, FinancialAdminCommandExecutor>
  ): ReadonlyMap<FinancialAdminCommandKind, FinancialAdminCommandExecutor>;
  throwIfFailed(): void;
  preflight(signal: AbortSignal): Promise<WorkerPause | null>;
  finalBarrier(pause: WorkerPause | null, signal: AbortSignal): Promise<void>;
  recordFailure(error: unknown): void;
}

export type TestWorkerControl = Pick<
  TestWorkerControlInternal,
  'active' | 'decorateFinancialAdminExecutors' | 'throwIfFailed'
>;

interface TestWorkerControlSession {
  readonly nonce: string;
  release(input: {
    readonly commandId: string;
    readonly failCommand: boolean;
    readonly signal: AbortSignal;
  }): Promise<void>;
  finish(input: {
    readonly signal: AbortSignal;
    readonly waitForTerminal: (
      commandId: string,
      signal: AbortSignal
    ) => Promise<void>;
  }): Promise<void>;
  cleanup(signal: AbortSignal): Promise<void>;
}

export interface TestWorkerControlHarness {
  pause(signal: AbortSignal): Promise<TestWorkerControlSession>;
}

const nodeFileSystem: TestWorkerControlFileSystem = {
  lstat: (path) => nodeLstat(path),
  realpath: (path) => nodeRealpath(path),
  readFile: (path, encoding) => nodeReadFile(path, encoding),
  writeFile: (path, data, options) => nodeWriteFile(path, data, options),
  rename: (from, to) => nodeRename(from, to),
  unlink: (path) => nodeUnlink(path)
};

const defaultWait = async (
  milliseconds: number,
  signal: AbortSignal
): Promise<void> => {
  await delay(milliseconds, undefined, { signal });
};
const monotonicNow = (): number => performance.now();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function exactOwnKeys(
  value: Record<string, unknown>,
  expected: readonly string[]
): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]);
}

function assertNonce(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !NONCE.test(value)) {
    throw new Error('Test worker control nonce is invalid');
  }
}

function assertCommandId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !CANONICAL_UUID.test(value)) {
    throw new Error('Test worker control command ID is invalid');
  }
}

export function encodeTestWorkerControlRequest(
  request: TestWorkerControlRequest
): string {
  if (!isPlainRecord(request)) {
    throw new Error('Test worker control request is invalid');
  }
  assertNonce(request.nonce);
  if (request.version !== 1) {
    throw new Error('Test worker control request version is invalid');
  }
  if (request.phase === 'pause') {
    if (!exactOwnKeys(request, ['version', 'nonce', 'phase'])) {
      throw new Error('Test worker pause request is not canonical');
    }
    return `{"version":1,"nonce":"${request.nonce}","phase":"pause"}`;
  }
  if (request.phase !== 'release') {
    throw new Error('Test worker control request phase is invalid');
  }
  if (request.failCommandId === undefined) {
    if (!exactOwnKeys(request, ['version', 'nonce', 'phase'])) {
      throw new Error('Test worker release request is not canonical');
    }
    return `{"version":1,"nonce":"${request.nonce}","phase":"release"}`;
  }
  if (!exactOwnKeys(request, [
    'version',
    'nonce',
    'phase',
    'failCommandId'
  ])) {
    throw new Error('Test worker release request is not canonical');
  }
  assertCommandId(request.failCommandId);
  return `{"version":1,"nonce":"${request.nonce}","phase":"release","failCommandId":"${request.failCommandId}"}`;
}

export function decodeTestWorkerControlRequest(
  raw: string
): TestWorkerControlRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Test worker control request JSON is malformed');
  }
  if (!isPlainRecord(parsed)) {
    throw new Error('Test worker control request is invalid');
  }
  const request = parsed as TestWorkerControlRequest;
  const canonical = encodeTestWorkerControlRequest(request);
  if (canonical !== raw) {
    throw new Error('Test worker control request JSON is not canonical');
  }
  return request;
}

export function encodeTestWorkerControlAcknowledgement(
  acknowledgement: TestWorkerControlAcknowledgement
): string {
  if (!isPlainRecord(acknowledgement) ||
    !exactOwnKeys(acknowledgement, ['version', 'nonce', 'phase'])) {
    throw new Error('Test worker control acknowledgement is not canonical');
  }
  assertNonce(acknowledgement.nonce);
  if (acknowledgement.version !== 1 ||
    (acknowledgement.phase !== 'paused' &&
      acknowledgement.phase !== 'released')) {
    throw new Error('Test worker control acknowledgement is invalid');
  }
  return `{"version":1,"nonce":"${acknowledgement.nonce}","phase":"${acknowledgement.phase}"}`;
}

export function decodeTestWorkerControlAcknowledgement(
  raw: string
): TestWorkerControlAcknowledgement {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Test worker control acknowledgement JSON is malformed');
  }
  if (!isPlainRecord(parsed)) {
    throw new Error('Test worker control acknowledgement is invalid');
  }
  const acknowledgement = parsed as TestWorkerControlAcknowledgement;
  const canonical = encodeTestWorkerControlAcknowledgement(acknowledgement);
  if (canonical !== raw) {
    throw new Error('Test worker control acknowledgement JSON is not canonical');
  }
  return acknowledgement;
}

function canonicalPath(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

function pathsFromEnvironment(
  environment: NodeJS.ProcessEnv
): ControlPaths | null {
  const ready = environment.WORKER_READY_FILE;
  if (!ready || !isAbsolute(ready) || basename(ready) !== 'worker.ready') {
    return null;
  }
  const normalizedReady = resolve(ready);
  const lexicallyCanonical = process.platform === 'win32'
    ? ready.toLowerCase() === normalizedReady.toLowerCase()
    : ready === normalizedReady;
  if (!lexicallyCanonical) return null;
  const root = dirname(normalizedReady);
  const temporaryRoot = resolve(tmpdir());
  if (!samePath(dirname(root), temporaryRoot) ||
    !OWNED_STORAGE_ROOT.test(basename(root))) {
    return null;
  }
  if (!samePath(resolve(root, 'worker.ready'), ready)) return null;
  const rootRelative = relative(temporaryRoot, root);
  if (!rootRelative || rootRelative === '..' ||
    rootRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    return null;
  }
  return {
    root,
    ready: normalizedReady,
    request: join(root, TEST_WORKER_CONTROL_REQUEST_BASENAME),
    acknowledgement: join(
      root,
      TEST_WORKER_CONTROL_ACKNOWLEDGEMENT_BASENAME
    ),
    requestTemp: join(root, REQUEST_TEMP_BASENAME),
    acknowledgementTemp: join(root, ACKNOWLEDGEMENT_TEMP_BASENAME)
  };
}

function hasCommonIsolationEnvironment(
  environment: NodeJS.ProcessEnv
): boolean {
  const rawPort = environment.DATABASE_PORT;
  if (!rawPort || !CANONICAL_PORT.test(rawPort)) return false;
  const port = Number(rawPort);
  return environment.APP_ENV === 'test' &&
    TEST_PROJECT.test(environment.PALE_ORBIT_TEST_PROJECT ?? '') &&
    LOOPBACK_HOSTS.has(environment.DATABASE_HOST ?? '') &&
    Number.isSafeInteger(port) && port >= 1_024 && port <= 65_535 &&
    port !== 5_432 &&
    environment.DATABASE_NAME === 'pale_orbit_test' &&
    environment.DATABASE_WORKER_USER === 'pale_orbit_test_worker' &&
    environment.WORKER_CONCURRENCY === '1' &&
    pathsFromEnvironment(environment) !== null;
}

function isWorkerControlEnvironment(
  environment: NodeJS.ProcessEnv,
  concurrency: number
): boolean {
  return concurrency === 1 &&
    hasCommonIsolationEnvironment(environment) &&
    FORBIDDEN_WORKER_SETTINGS.every((name) => environment[name] === undefined);
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === 'object' &&
    'code' in error && error.code === 'ENOENT';
}

function isDisappearedFile(error: unknown): boolean {
  return isMissingFile(error) ||
    (!!error && typeof error === 'object' && 'code' in error &&
      error.code === 'EBADF');
}

function isTransientRenameContention(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error &&
    (error.code === 'EPERM' || error.code === 'EACCES' ||
      error.code === 'EBUSY');
}

function isTemporaryLockContention(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error &&
    error.code === 'EEXIST';
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function isSignalAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted &&
    (error === signal.reason ||
      (error instanceof Error && error.name === 'AbortError'));
}

async function optionalStat(
  fileSystem: TestWorkerControlFileSystem,
  path: string
): Promise<TestWorkerControlStat | null> {
  try {
    return await fileSystem.lstat(path);
  } catch (error: unknown) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function assertDirectoryPath(
  fileSystem: TestWorkerControlFileSystem,
  path: string
): Promise<void> {
  const stat = await fileSystem.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Test worker control root is not a real directory');
  }
  if (!samePath(await fileSystem.realpath(path), path)) {
    throw new Error('Test worker control root resolves outside its owned path');
  }
}

async function assertRegularPath(
  fileSystem: TestWorkerControlFileSystem,
  path: string
): Promise<void> {
  const stat = await fileSystem.lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Test worker control path is not a regular file');
  }
  if (!samePath(await fileSystem.realpath(path), path)) {
    throw new Error('Test worker control path resolves outside its owned path');
  }
}

async function assertOwnedRoot(
  fileSystem: TestWorkerControlFileSystem,
  paths: ControlPaths
): Promise<void> {
  await assertDirectoryPath(fileSystem, paths.root);
  await assertRegularPath(fileSystem, paths.ready);
}

async function readOptionalFile(
  fileSystem: TestWorkerControlFileSystem,
  path: string
): Promise<string | null> {
  const stat = await optionalStat(fileSystem, path);
  if (stat === null) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Test worker control sibling is not a regular file');
  }
  try {
    if (!samePath(await fileSystem.realpath(path), path)) {
      throw new Error('Test worker control sibling resolves outside its owned path');
    }
    return await fileSystem.readFile(path, 'utf8');
  } catch (error: unknown) {
    if (isDisappearedFile(error)) return null;
    throw error;
  }
}

async function assertAbsent(
  fileSystem: TestWorkerControlFileSystem,
  path: string
): Promise<void> {
  if (await optionalStat(fileSystem, path) !== null) {
    throw new Error('Test worker control sibling already exists');
  }
}

async function acquireExclusiveTemp(input: {
  readonly fileSystem: TestWorkerControlFileSystem;
  readonly temp: string;
  readonly contents: string;
  readonly signal: AbortSignal;
  readonly dependencies: ControlDependencies;
}): Promise<void> {
  const deadlineAt = input.dependencies.now() +
    TEST_WORKER_CONTROL_DEADLINE_MS;
  while (true) {
    throwIfAborted(input.signal);
    try {
      await input.fileSystem.writeFile(input.temp, input.contents, {
        encoding: 'utf8',
        flag: 'wx'
      });
      break;
    } catch (error: unknown) {
      if (!isTemporaryLockContention(error)) throw error;
      const remaining = deadlineAt - input.dependencies.now();
      if (remaining <= 0) {
        throw new Error(
          'Test worker control temporary lock deadline expired',
          { cause: error }
        );
      }
      await input.dependencies.wait(
        Math.min(CONTROL_POLL_INTERVAL_MS, remaining),
        input.signal
      );
    }
  }

  try {
    await assertRegularPath(input.fileSystem, input.temp);
  } catch (error: unknown) {
    try {
      await releaseExclusiveTemp(
        input.fileSystem,
        input.temp,
        input.dependencies
      );
    } catch {
      // The validation error remains authoritative and the worker fails closed.
    }
    throw error;
  }
}

async function unlinkWithRetry(input: {
  readonly fileSystem: TestWorkerControlFileSystem;
  readonly path: string;
  readonly signal: AbortSignal;
  readonly dependencies: ControlDependencies;
}): Promise<void> {
  const deadlineAt = input.dependencies.now() +
    TEST_WORKER_CONTROL_DEADLINE_MS;
  while (true) {
    throwIfAborted(input.signal);
    try {
      await input.fileSystem.unlink(input.path);
      return;
    } catch (error: unknown) {
      if (isMissingFile(error)) return;
      if (!isTransientRenameContention(error)) throw error;
      const remaining = deadlineAt - input.dependencies.now();
      if (remaining <= 0) {
        throw new Error(
          'Test worker control unlink deadline expired',
          { cause: error }
        );
      }
      await input.dependencies.wait(
        Math.min(CONTROL_POLL_INTERVAL_MS, remaining),
        input.signal
      );
    }
  }
}

async function releaseExclusiveTemp(
  fileSystem: TestWorkerControlFileSystem,
  temp: string,
  dependencies: ControlDependencies
): Promise<void> {
  await unlinkWithRetry({
    fileSystem,
    path: temp,
    signal: new AbortController().signal,
    dependencies
  });
}

async function atomicWrite(
  fileSystem: TestWorkerControlFileSystem,
  target: string,
  temp: string,
  raw: string,
  mode: 'create' | 'replace',
  expectedTargetRaw: string | null,
  signal: AbortSignal,
  dependencies: ControlDependencies
): Promise<void> {
  await acquireExclusiveTemp({
    fileSystem,
    temp,
    contents: raw,
    signal,
    dependencies
  });
  let ownsTemp = true;
  let operationFailed = false;
  let operationError: unknown;
  try {
    if (mode === 'create') {
      if (expectedTargetRaw !== null) {
        throw new Error('Test worker control create has a predecessor');
      }
      await assertAbsent(fileSystem, target);
    } else {
      if (expectedTargetRaw === null) {
        throw new Error('Test worker control replacement lacks its predecessor');
      }
      const targetRaw = await readOptionalFile(fileSystem, target);
      if (targetRaw !== expectedTargetRaw) {
        throw new Error('Test worker control predecessor changed');
      }
    }
    const renameDeadline = dependencies.now() +
      TEST_WORKER_CONTROL_DEADLINE_MS;
    while (true) {
      throwIfAborted(signal);
      try {
        await fileSystem.rename(temp, target);
        break;
      } catch (error: unknown) {
        if (!isTransientRenameContention(error)) throw error;
        const remaining = renameDeadline - dependencies.now();
        if (remaining <= 0) {
          throw new Error(
            'Test worker control atomic rename deadline expired',
            { cause: error }
          );
        }
        await dependencies.wait(
          Math.min(CONTROL_POLL_INTERVAL_MS, remaining),
          signal
        );
      }
    }
    ownsTemp = false;
  } catch (error: unknown) {
    operationFailed = true;
    operationError = error;
  }
  let cleanupError: unknown;
  if (ownsTemp) {
    try {
      await releaseExclusiveTemp(fileSystem, temp, dependencies);
    } catch (error: unknown) {
      cleanupError = error;
    }
  }
  if (operationFailed) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
}

async function waitForCondition<T>(input: {
  readonly signal: AbortSignal;
  readonly dependencies: ControlDependencies;
  readonly description: string;
  readonly deadlineAt?: number;
  readonly inspect: (deadlineAt: number) => Promise<{ readonly done: false } | {
    readonly done: true;
    readonly value: T;
  }>;
}): Promise<T> {
  const deadlineAt = input.deadlineAt ??
    input.dependencies.now() + TEST_WORKER_CONTROL_DEADLINE_MS;
  while (true) {
    throwIfAborted(input.signal);
    const result = await input.inspect(deadlineAt);
    throwIfAborted(input.signal);
    const remaining = deadlineAt - input.dependencies.now();
    if (result.done && remaining >= 0) return result.value;
    if (remaining <= 0) {
      throw new Error(`Test worker control ${input.description} deadline expired`);
    }
    await input.dependencies.wait(
      Math.min(CONTROL_POLL_INTERVAL_MS, remaining),
      input.signal
    );
  }
}

async function waitForWriter(
  path: string,
  signal: AbortSignal,
  dependencies: ControlDependencies,
  deadlineAt?: number
): Promise<void> {
  if (await optionalStat(dependencies.fileSystem, path) === null) return;
  await waitForCondition({
    signal,
    dependencies,
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
    description: 'atomic publication',
    inspect: async () => ({
      done: await optionalStat(dependencies.fileSystem, path) === null,
      value: undefined
    })
  });
}

async function readStableControlState(
  paths: ControlPaths,
  signal: AbortSignal,
  dependencies: ControlDependencies
): Promise<{
  readonly requestRaw: string | null;
  readonly acknowledgementRaw: string | null;
}> {
  return waitForCondition({
    signal,
    dependencies,
    description: 'stable control-file observation',
    inspect: async (deadlineAt) => {
      await waitForWriter(
        paths.requestTemp,
        signal,
        dependencies,
        deadlineAt
      );
      const firstRequestRaw = await readOptionalFile(
        dependencies.fileSystem,
        paths.request
      );
      await waitForWriter(
        paths.acknowledgementTemp,
        signal,
        dependencies,
        deadlineAt
      );
      const acknowledgementRaw = await readOptionalFile(
        dependencies.fileSystem,
        paths.acknowledgement
      );
      await waitForWriter(
        paths.requestTemp,
        signal,
        dependencies,
        deadlineAt
      );
      const secondRequestRaw = await readOptionalFile(
        dependencies.fileSystem,
        paths.request
      );
      if (firstRequestRaw !== secondRequestRaw) {
        return { done: false } as const;
      }
      return {
        done: true,
        value: { requestRaw: secondRequestRaw, acknowledgementRaw }
      } as const;
    }
  });
}

function acknowledgement(
  nonce: string,
  phase: 'paused' | 'released'
): TestWorkerControlAcknowledgement {
  return { version: 1, nonce, phase };
}

function requestNonce(raw: string): string {
  return decodeTestWorkerControlRequest(raw).nonce;
}

function acknowledgementNonce(raw: string): string {
  return decodeTestWorkerControlAcknowledgement(raw).nonce;
}

export function createTestWorkerControl(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly concurrency: number;
  readonly abortWorker: (reason?: unknown) => void;
  readonly fileSystem?: TestWorkerControlFileSystem;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): TestWorkerControl {
  const paths = pathsFromEnvironment(input.environment);
  const active = paths !== null &&
    isWorkerControlEnvironment(input.environment, input.concurrency);
  const dependencies: ControlDependencies = {
    fileSystem: input.fileSystem ?? nodeFileSystem,
    now: input.now ?? monotonicNow,
    wait: input.wait ?? defaultWait
  };
  const completedNonces = new Set<string>();
  let currentCompletedNonce: string | undefined;
  let currentCompletedRequestRaw: string | undefined;
  let armedFailureCommandId: string | undefined;
  let failure: Error | undefined;

  const recordFailure = (error: unknown): void => {
    if (failure) return;
    failure = error instanceof Error
      ? error
      : new Error('Test worker control failed');
    try {
      input.abortWorker(failure);
    } catch {
      // The first recorded protocol failure remains authoritative.
    }
  };

  const clearCurrentCompletion = (): void => {
    if (currentCompletedRequestRaw !== undefined) {
      const completedRequest = decodeTestWorkerControlRequest(
        currentCompletedRequestRaw
      );
      if (completedRequest.phase === 'release' &&
        completedRequest.failCommandId === armedFailureCommandId) {
        armedFailureCommandId = undefined;
      }
    }
    currentCompletedNonce = undefined;
    currentCompletedRequestRaw = undefined;
  };

  const acknowledgePause = async (
    pauseRaw: string,
    nonce: string,
    signal: AbortSignal
  ): Promise<boolean> => {
    if (paths === null) return false;
    await acquireExclusiveTemp({
      fileSystem: dependencies.fileSystem,
      temp: paths.requestTemp,
      contents: pauseRaw,
      signal,
      dependencies
    });
    let operationFailed = false;
    let operationError: unknown;
    let acknowledged = false;
    try {
      const currentRequestRaw = await readOptionalFile(
        dependencies.fileSystem,
        paths.request
      );
      const currentAcknowledgementRaw = await readOptionalFile(
        dependencies.fileSystem,
        paths.acknowledgement
      );
      if (currentRequestRaw === null && currentAcknowledgementRaw === null) {
        acknowledged = false;
      } else {
        if (currentRequestRaw !== pauseRaw ||
          currentAcknowledgementRaw !== null) {
          throw new Error('Test worker pause changed before acknowledgement');
        }
        clearCurrentCompletion();
        await atomicWrite(
          dependencies.fileSystem,
          paths.acknowledgement,
          paths.acknowledgementTemp,
          encodeTestWorkerControlAcknowledgement(
            acknowledgement(nonce, 'paused')
          ),
          'create',
          null,
          signal,
          dependencies
        );
        acknowledged = true;
      }
    } catch (error: unknown) {
      operationFailed = true;
      operationError = error;
    }
    let releaseError: unknown;
    try {
      await releaseExclusiveTemp(
        dependencies.fileSystem,
        paths.requestTemp,
        dependencies
      );
    } catch (error: unknown) {
      releaseError = error;
    }
    if (operationFailed) throw operationError;
    if (releaseError !== undefined) throw releaseError;
    return acknowledged;
  };

  const inspectState = async (
    signal: AbortSignal
  ): Promise<WorkerPause | null> => {
    if (!active || paths === null) return null;
    throwIfAborted(signal);
    await assertOwnedRoot(dependencies.fileSystem, paths);
    const { requestRaw, acknowledgementRaw } =
      await readStableControlState(paths, signal, dependencies);

    if (requestRaw === null) {
      if (acknowledgementRaw === null) {
        clearCurrentCompletion();
        return null;
      }
      const existingAcknowledgement =
        decodeTestWorkerControlAcknowledgement(acknowledgementRaw);
      if (existingAcknowledgement.phase === 'released' &&
        existingAcknowledgement.nonce === currentCompletedNonce) {
        return null;
      }
      throw new Error('Test worker control acknowledgement is stale');
    }

    const existingRequest = decodeTestWorkerControlRequest(requestRaw);
    if (existingRequest.phase === 'release') {
      if (existingRequest.nonce !== currentCompletedNonce ||
        requestRaw !== currentCompletedRequestRaw) {
        throw new Error('Test worker control release preceded pause acknowledgement');
      }
      if (acknowledgementRaw === null) {
        throw new Error('Test worker control released acknowledgement is missing');
      }
      const existingAcknowledgement =
        decodeTestWorkerControlAcknowledgement(acknowledgementRaw);
      if (existingAcknowledgement.nonce !== existingRequest.nonce ||
        existingAcknowledgement.phase !== 'released') {
        throw new Error('Test worker control released acknowledgement is stale');
      }
      return null;
    }

    if (completedNonces.has(existingRequest.nonce)) {
      throw new Error('Test worker control nonce was already completed');
    }
    if (acknowledgementRaw !== null) {
      throw new Error('Test worker control paused acknowledgement is stale');
    }
    if (!await acknowledgePause(requestRaw, existingRequest.nonce, signal)) {
      return null;
    }
    return { nonce: existingRequest.nonce };
  };

  const completePause = async (
    pause: WorkerPause,
    signal: AbortSignal
  ): Promise<void> => {
    if (!active || paths === null) return;
    const release = await waitForCondition({
      signal,
      dependencies,
      description: 'release request',
      inspect: async (deadlineAt) => {
        await waitForWriter(
          paths.requestTemp,
          signal,
          dependencies,
          deadlineAt
        );
        const requestRaw = await readOptionalFile(
          dependencies.fileSystem,
          paths.request
        );
        const acknowledgementRaw = await readOptionalFile(
          dependencies.fileSystem,
          paths.acknowledgement
        );
        if (acknowledgementRaw === null) {
          throw new Error('Test worker control paused acknowledgement is missing');
        }
        const currentAcknowledgement =
          decodeTestWorkerControlAcknowledgement(acknowledgementRaw);
        if (currentAcknowledgement.nonce !== pause.nonce ||
          currentAcknowledgement.phase !== 'paused') {
          throw new Error('Test worker control paused acknowledgement changed');
        }
        if (requestRaw === null) return { done: false } as const;
        const currentRequest = decodeTestWorkerControlRequest(requestRaw);
        if (currentRequest.nonce !== pause.nonce) {
          throw new Error('Test worker control nonce changed concurrently');
        }
        if (currentRequest.phase === 'pause') {
          return { done: false } as const;
        }
        return { done: true, value: currentRequest } as const;
      }
    });

    const releaseRaw = encodeTestWorkerControlRequest(release);
    await acquireExclusiveTemp({
      fileSystem: dependencies.fileSystem,
      temp: paths.requestTemp,
      contents: releaseRaw,
      signal,
      dependencies
    });
    let operationFailed = false;
    let operationError: unknown;
    try {
      const finalRequestRaw = await readOptionalFile(
        dependencies.fileSystem,
        paths.request
      );
      const finalAcknowledgementRaw = await readOptionalFile(
        dependencies.fileSystem,
        paths.acknowledgement
      );
      const pausedAcknowledgementRaw =
        encodeTestWorkerControlAcknowledgement(
          acknowledgement(pause.nonce, 'paused')
        );
      if (finalRequestRaw !== releaseRaw ||
        finalAcknowledgementRaw !== pausedAcknowledgementRaw) {
        throw new Error('Test worker release changed before acknowledgement');
      }

      if (release.failCommandId !== undefined) {
        if (armedFailureCommandId !== undefined) {
          throw new Error(
            'Test worker control failure injection is already armed'
          );
        }
        armedFailureCommandId = release.failCommandId;
      }
      completedNonces.add(pause.nonce);
      currentCompletedNonce = pause.nonce;
      currentCompletedRequestRaw = releaseRaw;
      await atomicWrite(
        dependencies.fileSystem,
        paths.acknowledgement,
        paths.acknowledgementTemp,
        encodeTestWorkerControlAcknowledgement(
          acknowledgement(pause.nonce, 'released')
        ),
        'replace',
        encodeTestWorkerControlAcknowledgement(
          acknowledgement(pause.nonce, 'paused')
        ),
        signal,
        dependencies
      );
    } catch (error: unknown) {
      completedNonces.delete(pause.nonce);
      currentCompletedNonce = undefined;
      currentCompletedRequestRaw = undefined;
      if (armedFailureCommandId === release.failCommandId) {
        armedFailureCommandId = undefined;
      }
      operationFailed = true;
      operationError = error;
    }
    let releaseLockError: unknown;
    try {
      await releaseExclusiveTemp(
        dependencies.fileSystem,
        paths.requestTemp,
        dependencies
      );
    } catch (error: unknown) {
      releaseLockError = error;
    }
    if (operationFailed) throw operationError;
    if (releaseLockError !== undefined) throw releaseLockError;
  };

  const control: TestWorkerControlInternal = {
    active,
    decorateFinancialAdminExecutors(executors) {
      if (!active) return new Map(executors);
      return new Map(
        [...executors].map(([kind, executor]) => [
          kind,
          async (context, command) => {
            if (armedFailureCommandId === context.commandId) {
              armedFailureCommandId = undefined;
              throw new FinancialAdminPermanentError('command_failed');
            }
            return executor(context, command);
          }
        ])
      );
    },
    throwIfFailed() {
      if (failure) throw failure;
    },
    preflight: inspectState,
    finalBarrier: async (pause, signal) => {
      if (!active) return;
      const observedPause = pause ?? await inspectState(signal);
      if (observedPause) await completePause(observedPause, signal);
    },
    recordFailure
  };
  return control;
}

export async function prepareTestWorkerPoll(input: {
  readonly control: TestWorkerControl;
  readonly signal: AbortSignal;
  readonly maintenance: () => Promise<void>;
}): Promise<void> {
  const control = input.control as TestWorkerControlInternal;
  if (!control.active) {
    await input.maintenance();
    return;
  }

  let pause: WorkerPause | null;
  try {
    pause = await control.preflight(input.signal);
  } catch (error: unknown) {
    if (!isSignalAbort(error, input.signal)) control.recordFailure(error);
    return;
  }

  let maintenanceFailed = false;
  let maintenanceError: unknown;
  try {
    await input.maintenance();
  } catch (error: unknown) {
    maintenanceFailed = true;
    maintenanceError = error;
  }

  try {
    await control.finalBarrier(pause, input.signal);
  } catch (error: unknown) {
    if (!isSignalAbort(error, input.signal)) control.recordFailure(error);
    return;
  }
  if (maintenanceFailed) throw maintenanceError;
}

export function createTestWorkerControlHarness(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly fileSystem?: TestWorkerControlFileSystem;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly now?: () => number;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): TestWorkerControlHarness {
  const paths = pathsFromEnvironment(input.environment);
  if (paths === null || !hasCommonIsolationEnvironment(input.environment)) {
    throw new Error('Refusing to create a non-isolated test worker harness');
  }
  const dependencies: ControlDependencies = {
    fileSystem: input.fileSystem ?? nodeFileSystem,
    now: input.now ?? monotonicNow,
    wait: input.wait ?? defaultWait
  };
  const generateBytes = input.randomBytes ?? nodeRandomBytes;
  let activeSession: TestWorkerControlSession | null = null;
  let sequenceActive = false;

  const waitForAcknowledgement = async (
    nonce: string,
    expected: 'paused' | 'released',
    signal: AbortSignal
  ): Promise<void> => {
    await waitForCondition({
      signal,
      dependencies,
      description: `${expected} acknowledgement`,
      inspect: async (deadlineAt) => {
        await waitForWriter(
          paths.acknowledgementTemp,
          signal,
          dependencies,
          deadlineAt
        );
        const raw = await readOptionalFile(
          dependencies.fileSystem,
          paths.acknowledgement
        );
        if (raw === null) return { done: false } as const;
        const current = decodeTestWorkerControlAcknowledgement(raw);
        if (current.nonce !== nonce) {
          throw new Error('Test worker control acknowledgement nonce is stale');
        }
        if (current.phase === expected) {
          return { done: true, value: undefined } as const;
        }
        if (expected === 'released' && current.phase === 'paused') {
          return { done: false } as const;
        }
        throw new Error('Test worker control acknowledgement phase is stale');
      }
    });
  };

  const unlinkOwnedFile = async (input: {
    readonly target: string;
    readonly temp: string;
    readonly lockContents: string;
    readonly nonceFromRaw: (raw: string) => string;
    readonly nonce: string;
    readonly signal: AbortSignal;
  }): Promise<void> => {
    await acquireExclusiveTemp({
      fileSystem: dependencies.fileSystem,
      temp: input.temp,
      contents: input.lockContents,
      signal: input.signal,
      dependencies
    });
    let operationFailed = false;
    let operationError: unknown;
    try {
      const raw = await readOptionalFile(
        dependencies.fileSystem,
        input.target
      );
      if (raw !== null && input.nonceFromRaw(raw) === input.nonce) {
        await unlinkWithRetry({
          fileSystem: dependencies.fileSystem,
          path: input.target,
          signal: input.signal,
          dependencies
        });
      }
    } catch (error: unknown) {
      operationFailed = true;
      operationError = error;
    }
    let releaseError: unknown;
    try {
      await releaseExclusiveTemp(
        dependencies.fileSystem,
        input.temp,
        dependencies
      );
    } catch (error: unknown) {
      releaseError = error;
    }
    if (operationFailed) throw operationError;
    if (releaseError !== undefined) throw releaseError;
  };

  const cleanupOwnedFiles = async (
    nonce: string,
    signal: AbortSignal
  ): Promise<void> => {
    await unlinkOwnedFile({
      target: paths.request,
      temp: paths.requestTemp,
      lockContents: encodeTestWorkerControlRequest({
        version: 1,
        nonce,
        phase: 'release'
      }),
      nonceFromRaw: requestNonce,
      nonce,
      signal
    });
    await unlinkOwnedFile({
      target: paths.acknowledgement,
      temp: paths.acknowledgementTemp,
      lockContents: encodeTestWorkerControlAcknowledgement(
        acknowledgement(nonce, 'released')
      ),
      nonceFromRaw: acknowledgementNonce,
      nonce,
      signal
    });
  };

  const recoverUntargetedPause = async (
    nonce: string,
    recoverySignal: AbortSignal
  ): Promise<void> => {
    const pauseRaw = encodeTestWorkerControlRequest({
      version: 1,
      nonce,
      phase: 'pause'
    });
    const releaseRaw = encodeTestWorkerControlRequest({
      version: 1,
      nonce,
      phase: 'release'
    });
    await acquireExclusiveTemp({
      fileSystem: dependencies.fileSystem,
      temp: paths.requestTemp,
      contents: pauseRaw,
      signal: recoverySignal,
      dependencies
    });
    let operationFailed = false;
    let operationError: unknown;
    let releaseMode: 'create' | 'replace' | null = null;
    let waitForRelease = false;
    try {
      const requestRaw = await readOptionalFile(
        dependencies.fileSystem,
        paths.request
      );
      const acknowledgementRaw = await readOptionalFile(
        dependencies.fileSystem,
        paths.acknowledgement
      );
      const currentRequest = requestRaw === null
        ? null
        : decodeTestWorkerControlRequest(requestRaw);
      const currentAcknowledgement = acknowledgementRaw === null
        ? null
        : decodeTestWorkerControlAcknowledgement(acknowledgementRaw);
      const requestOwned = currentRequest === null ||
        currentRequest.nonce === nonce;
      const acknowledgementOwned = currentAcknowledgement === null ||
        currentAcknowledgement.nonce === nonce;
      if (requestOwned && acknowledgementOwned) {
        if (currentRequest?.phase === 'pause' &&
          currentAcknowledgement === null) {
          await unlinkWithRetry({
            fileSystem: dependencies.fileSystem,
            path: paths.request,
            signal: recoverySignal,
            dependencies
          });
        } else if (currentRequest?.phase === 'pause' &&
          currentAcknowledgement?.phase === 'paused') {
          releaseMode = 'replace';
        } else if (currentRequest === null &&
          currentAcknowledgement?.phase === 'paused') {
          releaseMode = 'create';
        } else if (currentRequest?.phase === 'release' &&
          requestRaw === releaseRaw &&
          currentAcknowledgement?.phase === 'paused') {
          waitForRelease = true;
        } else if (currentRequest?.phase === 'release' &&
          requestRaw === releaseRaw &&
          currentAcknowledgement?.phase === 'released') {
          waitForRelease = false;
        } else if (currentRequest !== null ||
          currentAcknowledgement !== null) {
          throw new Error('Abandoned test worker pause changed unexpectedly');
        }
      }
    } catch (error: unknown) {
      operationFailed = true;
      operationError = error;
    }
    let releaseLockError: unknown;
    try {
      await releaseExclusiveTemp(
        dependencies.fileSystem,
        paths.requestTemp,
        dependencies
      );
    } catch (error: unknown) {
      releaseLockError = error;
    }
    if (operationFailed) throw operationError;
    if (releaseLockError !== undefined) throw releaseLockError;

    if (releaseMode !== null) {
      await atomicWrite(
        dependencies.fileSystem,
        paths.request,
        paths.requestTemp,
        releaseRaw,
        releaseMode,
        releaseMode === 'replace' ? pauseRaw : null,
        recoverySignal,
        dependencies
      );
      waitForRelease = true;
    }
    if (waitForRelease) {
      await waitForAcknowledgement(nonce, 'released', recoverySignal);
    }
    await cleanupOwnedFiles(nonce, recoverySignal);
  };

  return {
    async pause(signal) {
      if (sequenceActive) {
        throw new Error('A test worker control sequence is already active');
      }
      sequenceActive = true;
      let nonce: string;
      try {
        throwIfAborted(signal);
        await assertOwnedRoot(dependencies.fileSystem, paths);
        await assertAbsent(dependencies.fileSystem, paths.requestTemp);
        await assertAbsent(dependencies.fileSystem, paths.acknowledgementTemp);
        await assertAbsent(dependencies.fileSystem, paths.request);
        await assertAbsent(dependencies.fileSystem, paths.acknowledgement);

        const bytes = generateBytes(16);
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) {
          throw new Error(
            'Test worker control nonce source returned invalid bytes'
          );
        }
        nonce = Buffer.from(bytes).toString('hex');
        assertNonce(nonce);
      } catch (error: unknown) {
        sequenceActive = false;
        throw error;
      }

      let state:
        | 'pausing'
        | 'paused'
        | 'releasing'
        | 'released'
        | 'finishing'
        | 'finished'
        | 'canceling'
        | 'cleaning'
        | 'cleaned' = 'pausing';
      let targetCommandId: string | undefined;
      let releaseWaitActive = false;
      const session: TestWorkerControlSession = {
        nonce,
        async release(releaseInput) {
          if (state !== 'paused') {
            throw new Error('Test worker control session is not paused');
          }
          assertCommandId(releaseInput.commandId);
          if (typeof releaseInput.failCommand !== 'boolean') {
            throw new Error('Test worker control failure flag is invalid');
          }
          throwIfAborted(releaseInput.signal);
          const request: TestWorkerControlRequest = {
            version: 1,
            nonce,
            phase: 'release',
            ...(releaseInput.failCommand
              ? { failCommandId: releaseInput.commandId }
              : {})
          };
          targetCommandId = releaseInput.commandId;
          state = 'releasing';
          try {
            await atomicWrite(
              dependencies.fileSystem,
              paths.request,
              paths.requestTemp,
              encodeTestWorkerControlRequest(request),
              'replace',
              encodeTestWorkerControlRequest({
                version: 1,
                nonce,
                phase: 'pause'
              }),
              releaseInput.signal,
              dependencies
            );
          } catch (error: unknown) {
            targetCommandId = undefined;
            state = 'paused';
            throw error;
          }
          releaseWaitActive = true;
          try {
            await waitForAcknowledgement(
              nonce,
              'released',
              releaseInput.signal
            );
            state = 'released';
          } finally {
            releaseWaitActive = false;
          }
        },
        async finish(finishInput) {
          if (targetCommandId === undefined) {
            throw new Error('Test worker control target is not released');
          }
          if (state === 'releasing') {
            if (releaseWaitActive) {
              throw new Error('Test worker control release is still active');
            }
            state = 'finishing';
            try {
              await waitForAcknowledgement(
                nonce,
                'released',
                finishInput.signal
              );
            } catch (error: unknown) {
              state = 'releasing';
              throw error;
            }
          } else if (state === 'released') {
            state = 'finishing';
          } else {
            throw new Error('Test worker control target is not released');
          }
          try {
            await finishInput.waitForTerminal(
              targetCommandId,
              finishInput.signal
            );
          } catch (error: unknown) {
            state = 'released';
            throw error;
          }
          state = 'finished';
          await cleanupOwnedFiles(nonce, finishInput.signal);
          if (activeSession === session) {
            activeSession = null;
            sequenceActive = false;
          }
        },
        async cleanup(cleanupSignal) {
          throwIfAborted(cleanupSignal);
          if (state === 'releasing' || state === 'released' ||
            state === 'finishing' || state === 'cleaning') {
            throw new Error(
              'Test worker control cleanup requires terminal completion'
            );
          }
          if (state === 'paused' || state === 'canceling') {
            state = 'canceling';
            await recoverUntargetedPause(nonce, cleanupSignal);
          } else {
            state = 'cleaning';
            try {
              await cleanupOwnedFiles(nonce, cleanupSignal);
            } catch (error: unknown) {
              state = 'finished';
              throw error;
            }
          }
          state = 'cleaned';
          if (activeSession === session) {
            activeSession = null;
            sequenceActive = false;
          }
        }
      };
      activeSession = session;
      let pausePublished = false;
      try {
        await atomicWrite(
          dependencies.fileSystem,
          paths.request,
          paths.requestTemp,
          encodeTestWorkerControlRequest({ version: 1, nonce, phase: 'pause' }),
          'create',
          null,
          signal,
          dependencies
        );
        pausePublished = true;
        await waitForAcknowledgement(nonce, 'paused', signal);
        state = 'paused';
        return session;
      } catch (error: unknown) {
        if (pausePublished) {
          try {
            await recoverUntargetedPause(
              nonce,
              new AbortController().signal
            );
          } catch (recoveryError: unknown) {
            throw new Error(
              'Test worker control could not recover an abandoned pause',
              { cause: recoveryError }
            );
          }
        }
        if (activeSession === session) {
          activeSession = null;
          sequenceActive = false;
        }
        throw error;
      }
    }
  };
}
