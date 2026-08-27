import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { FinancialAdminPermanentError } from '$lib/server/commerce/financial/admin-commands/errors';
import type { FinancialAdminCommandExecutor } from '$lib/server/commerce/financial/admin-commands/handler';
import {
  FINANCIAL_ADMIN_COMMAND_KINDS,
  type FinancialAdminCommandKind
} from '$lib/types/financial-reporting';
import { runWorker } from './runner';
import type { JobFailureTransition, JobRepository } from './types';
import {
  TEST_WORKER_CONTROL_ACKNOWLEDGEMENT_BASENAME,
  TEST_WORKER_CONTROL_ACKNOWLEDGED_HOLD_DEADLINE_MS,
  TEST_WORKER_CONTROL_DEADLINE_MS,
  TEST_WORKER_CONTROL_REQUEST_BASENAME,
  createTestWorkerControl,
  createTestWorkerControlHarness,
  decodeTestWorkerControlAcknowledgement,
  decodeTestWorkerControlRequest,
  encodeTestWorkerControlAcknowledgement,
  encodeTestWorkerControlRequest,
  prepareTestWorkerPoll,
  type TestWorkerControl,
  type TestWorkerControlFileSystem
} from './test-worker-control';

const NONCE_A = '0123456789abcdef0123456789abcdef';
const NONCE_B = 'fedcba9876543210fedcba9876543210';
const COMMAND_A = '61f46ee7-3170-40ea-bfad-d55a734bf371';
const COMMAND_B = '61f46ee7-3170-40ea-bfad-d55a734bf372';
const TEST_TIMEOUT_MS = 7_000;

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const PAUSE_A =
  '{"version":1,"nonce":"0123456789abcdef0123456789abcdef","phase":"pause"}';
const PAUSED_A =
  '{"version":1,"nonce":"0123456789abcdef0123456789abcdef","phase":"paused"}';
const RELEASE_A =
  '{"version":1,"nonce":"0123456789abcdef0123456789abcdef","phase":"release"}';
const RELEASE_A_WITH_FAILURE =
  '{"version":1,"nonce":"0123456789abcdef0123456789abcdef","phase":"release","failCommandId":"61f46ee7-3170-40ea-bfad-d55a734bf371"}';
const RELEASED_A =
  '{"version":1,"nonce":"0123456789abcdef0123456789abcdef","phase":"released"}';

const createdRoots: string[] = [];

afterEach(async () => {
  await Promise.all(createdRoots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
  vi.restoreAllMocks();
});

interface ActiveFixture {
  readonly environment: NodeJS.ProcessEnv;
  readonly root: string;
  readonly readyFile: string;
  readonly requestFile: string;
  readonly acknowledgementFile: string;
  readonly requestTempFile: string;
  readonly acknowledgementTempFile: string;
}

async function activeFixture(): Promise<ActiveFixture> {
  const root = await mkdtemp(join(tmpdir(), 'pale-orbit-test-storage-'));
  createdRoots.push(root);
  const readyFile = join(root, 'worker.ready');
  await writeFile(readyFile, 'test-worker', 'utf8');
  return {
    root,
    readyFile,
    requestFile: join(root, TEST_WORKER_CONTROL_REQUEST_BASENAME),
    acknowledgementFile: join(
      root,
      TEST_WORKER_CONTROL_ACKNOWLEDGEMENT_BASENAME
    ),
    requestTempFile: join(root, 'worker.control.tmp'),
    acknowledgementTempFile: join(root, 'worker.control.ack.tmp'),
    environment: {
      APP_ENV: 'test',
      PALE_ORBIT_TEST_PROJECT: 'pale-orbit-test-0123456789abcdef',
      DATABASE_HOST: '127.0.0.1',
      DATABASE_PORT: '55432',
      DATABASE_NAME: 'pale_orbit_test',
      DATABASE_WORKER_USER: 'pale_orbit_test_worker',
      DATABASE_WORKER_PASSWORD: 'test-worker-password',
      WORKER_CONCURRENCY: '1',
      WORKER_READY_FILE: readyFile
    }
  };
}

function deferred<T = void>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out while ${label}`)),
      TEST_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForContents(path: string, expected: string): Promise<void> {
  await vi.waitFor(async () => {
    await expect(readFile(path, 'utf8')).resolves.toBe(expected);
  }, { interval: 5, timeout: 6_000 });
}

function repositoryWithNoJobs(onClaim?: () => void | Promise<void>): JobRepository {
  const fail = vi.fn().mockResolvedValue(true);
  return {
    claimNext: vi.fn(async () => {
      await onClaim?.();
      return null;
    }),
    renewLease: vi.fn().mockResolvedValue(true),
    complete: vi.fn().mockResolvedValue(true),
    fail,
    failWithDisposition: vi.fn(async (
      ...failureArguments: Parameters<JobRepository['fail']>
    ): Promise<JobFailureTransition> => await fail(...failureArguments)
      ? { applied: true, retryScheduled: false }
      : { applied: false }),
    renewOperationsJobLease: vi.fn().mockResolvedValue(true),
    completeOperationsJob: vi.fn().mockResolvedValue(true),
    failOperationsJob: vi.fn().mockResolvedValue({ applied: true, retryScheduled: false })
  };
}

function inertFileSystem() {
  const failure = () => Promise.reject(new Error('inactive filesystem access'));
  return {
    lstat: vi.fn(failure),
    realpath: vi.fn(failure),
    readFile: vi.fn(failure),
    writeFile: vi.fn(failure),
    rename: vi.fn(failure),
    unlink: vi.fn(failure)
  };
}

const nodeFileSystem = {
  lstat,
  realpath,
  readFile,
  writeFile,
  rename,
  unlink
} as unknown as TestWorkerControlFileSystem;

function releaseWitnessFileSystem(requestFile: string) {
  const published = deferred<void>();
  const fileSystem: TestWorkerControlFileSystem = {
    ...nodeFileSystem,
    async rename(from, to) {
      await nodeFileSystem.rename(from, to);
      if (
        to === requestFile &&
        await nodeFileSystem.readFile(to, 'utf8') === RELEASE_A
      ) {
        published.resolve();
      }
    }
  };
  return { fileSystem, published: published.promise };
}

function advancingDeadline() {
  let nowValue = 0;
  const waits: Array<{ milliseconds: number; signal: AbortSignal }> = [];
  return {
    now: () => nowValue,
    wait: vi.fn(async (milliseconds: number, signal: AbortSignal) => {
      waits.push({ milliseconds, signal });
      if (signal.aborted) {
        throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      }
      nowValue += 1_000;
      await Promise.resolve();
    }),
    waits,
    elapsed: () => nowValue
  };
}

function randomBytesFor(nonce: string) {
  return vi.fn((size: number) => {
    expect(size).toBe(16);
    return Uint8Array.from(Buffer.from(nonce, 'hex'));
  });
}

function fileSystemError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Injected filesystem error ${code}`), { code });
}

async function releasedSession(input: {
  fixture: ActiveFixture;
  control: ReturnType<typeof createTestWorkerControl>;
  harness: ReturnType<typeof createTestWorkerControlHarness>;
  commandId?: string;
  failCommand?: boolean;
}) {
  const signal = new AbortController();
  const pausing = input.harness.pause(signal.signal);
  await waitForContents(input.fixture.requestFile, PAUSE_A);
  const polling = prepareTestWorkerPoll({
    control: input.control,
    signal: signal.signal,
    maintenance: vi.fn().mockResolvedValue(undefined)
  });
  const session = await within(pausing, 'awaiting the paused acknowledgement');
  const releasing = session.release({
    commandId: input.commandId ?? COMMAND_A,
    failCommand: input.failCommand ?? false,
    signal: signal.signal
  });
  await within(
    Promise.all([polling, releasing]).then(() => undefined),
    'completing the release barrier'
  );
  return { session, signal };
}

describe('test worker control canonical protocol', () => {
  it('exports only the frozen public worker-control surface', () => {
    expectTypeOf<ReturnType<typeof createTestWorkerControl>>()
      .toEqualTypeOf<TestWorkerControl>();
  });

  it('uses exact transition and acknowledged-hold deadlines and canonical encodings', () => {
    expect(TEST_WORKER_CONTROL_DEADLINE_MS).toBe(5_000);
    expect(TEST_WORKER_CONTROL_ACKNOWLEDGED_HOLD_DEADLINE_MS).toBe(120_000);
    expect(basename(TEST_WORKER_CONTROL_REQUEST_BASENAME))
      .toBe(TEST_WORKER_CONTROL_REQUEST_BASENAME);
    expect(basename(TEST_WORKER_CONTROL_ACKNOWLEDGEMENT_BASENAME))
      .toBe(TEST_WORKER_CONTROL_ACKNOWLEDGEMENT_BASENAME);
    expect(TEST_WORKER_CONTROL_REQUEST_BASENAME)
      .not.toBe(TEST_WORKER_CONTROL_ACKNOWLEDGEMENT_BASENAME);

    expect(encodeTestWorkerControlRequest({
      version: 1,
      nonce: NONCE_A,
      phase: 'pause'
    })).toBe(PAUSE_A);
    expect(encodeTestWorkerControlRequest({
      version: 1,
      nonce: NONCE_A,
      phase: 'release'
    })).toBe(RELEASE_A);
    expect(encodeTestWorkerControlRequest({
      version: 1,
      nonce: NONCE_A,
      phase: 'release',
      failCommandId: COMMAND_A
    })).toBe(RELEASE_A_WITH_FAILURE);
    expect(encodeTestWorkerControlAcknowledgement({
      version: 1,
      nonce: NONCE_A,
      phase: 'paused'
    })).toBe(PAUSED_A);
    expect(encodeTestWorkerControlAcknowledgement({
      version: 1,
      nonce: NONCE_A,
      phase: 'released'
    })).toBe(RELEASED_A);

    expect(decodeTestWorkerControlRequest(PAUSE_A)).toEqual({
      version: 1,
      nonce: NONCE_A,
      phase: 'pause'
    });
    expect(decodeTestWorkerControlRequest(RELEASE_A_WITH_FAILURE)).toEqual({
      version: 1,
      nonce: NONCE_A,
      phase: 'release',
      failCommandId: COMMAND_A
    });
    expect(decodeTestWorkerControlAcknowledgement(PAUSED_A)).toEqual({
      version: 1,
      nonce: NONCE_A,
      phase: 'paused'
    });
    expect(decodeTestWorkerControlAcknowledgement(RELEASED_A)).toEqual({
      version: 1,
      nonce: NONCE_A,
      phase: 'released'
    });
  });

  it.each([
    ['31 characters', '0123456789abcdef0123456789abcde'],
    ['33 characters', '0123456789abcdef0123456789abcdef0'],
    ['uppercase', '0123456789ABCDEF0123456789ABCDEF'],
    ['non hexadecimal', 'g123456789abcdef0123456789abcdef']
  ])('rejects a %s nonce', (_label, nonce) => {
    expect(() => encodeTestWorkerControlRequest({
      version: 1,
      nonce,
      phase: 'pause'
    })).toThrow();
    expect(() => decodeTestWorkerControlRequest(
      `{"version":1,"nonce":"${nonce}","phase":"pause"}`
    )).toThrow();
  });

  it.each([
    ['leading whitespace', ` ${PAUSE_A}`],
    ['trailing newline', `${PAUSE_A}\n`],
    ['key order', `{"nonce":"${NONCE_A}","version":1,"phase":"pause"}`],
    ['duplicate nonce', `{"version":1,"nonce":"${NONCE_A}","nonce":"${NONCE_B}","phase":"pause"}`],
    ['unknown key', `{"version":1,"nonce":"${NONCE_A}","phase":"pause","extra":true}`],
    ['wrong version', `{"version":2,"nonce":"${NONCE_A}","phase":"pause"}`],
    ['wrong phase', `{"version":1,"nonce":"${NONCE_A}","phase":"paused"}`],
    ['failure on pause', `{"version":1,"nonce":"${NONCE_A}","phase":"pause","failCommandId":"${COMMAND_A}"}`],
    ['duplicate failure ID', `{"version":1,"nonce":"${NONCE_A}","phase":"release","failCommandId":"${COMMAND_A}","failCommandId":"${COMMAND_B}"}`],
    ['multiple failure IDs', `{"version":1,"nonce":"${NONCE_A}","phase":"release","failCommandIds":["${COMMAND_A}","${COMMAND_B}"]}`],
    ['invalid failure ID', `{"version":1,"nonce":"${NONCE_A}","phase":"release","failCommandId":"not-a-command"}`],
    ['noncanonical failure ID', `{"version":1,"nonce":"${NONCE_A}","phase":"release","failCommandId":"${COMMAND_A.toUpperCase()}"}`],
    ['malformed JSON', '{"version":1']
  ])('rejects noncanonical request JSON: %s', (_label, raw) => {
    expect(() => decodeTestWorkerControlRequest(raw)).toThrow();
  });

  it.each([
    ['leading whitespace', ` ${PAUSED_A}`],
    ['key order', `{"nonce":"${NONCE_A}","version":1,"phase":"paused"}`],
    ['duplicate phase', `{"version":1,"nonce":"${NONCE_A}","phase":"paused","phase":"released"}`],
    ['unknown key', `{"version":1,"nonce":"${NONCE_A}","phase":"paused","extra":true}`],
    ['request phase', `{"version":1,"nonce":"${NONCE_A}","phase":"pause"}`],
    ['wrong version', `{"version":0,"nonce":"${NONCE_A}","phase":"paused"}`],
    ['malformed JSON', '{']
  ])('rejects noncanonical acknowledgement JSON: %s', (_label, raw) => {
    expect(() => decodeTestWorkerControlAcknowledgement(raw)).toThrow();
  });
});

describe('test worker control activation', () => {
  const forbiddenSettings = [
    'DATABASE_USER',
    'DATABASE_USER_FILE',
    'DATABASE_PASSWORD',
    'DATABASE_PASSWORD_FILE',
    'DATABASE_OWNER_USER',
    'DATABASE_OWNER_USER_FILE',
    'DATABASE_OWNER_PASSWORD',
    'DATABASE_OWNER_PASSWORD_FILE'
  ] as const;

  const invalidConjuncts: ReadonlyArray<{
    readonly label: string;
    readonly change: (environment: NodeJS.ProcessEnv, fixture: ActiveFixture) => void;
    readonly concurrency?: number;
  }> = [
    { label: 'APP_ENV is absent', change: (environment) => { delete environment.APP_ENV; } },
    { label: 'APP_ENV is not exact', change: (environment) => { environment.APP_ENV = 'test '; } },
    { label: 'project is absent', change: (environment) => { delete environment.PALE_ORBIT_TEST_PROJECT; } },
    { label: 'project has a noncanonical suffix', change: (environment) => {
      environment.PALE_ORBIT_TEST_PROJECT = 'pale-orbit-test-0123456789ABCDEF';
    } },
    { label: 'database host is not loopback', change: (environment) => {
      environment.DATABASE_HOST = 'postgres';
    } },
    { label: 'database port is absent', change: (environment) => {
      delete environment.DATABASE_PORT;
    } },
    { label: 'database port is the PostgreSQL default', change: (environment) => {
      environment.DATABASE_PORT = '5432';
    } },
    { label: 'database port is below range', change: (environment) => {
      environment.DATABASE_PORT = '0';
    } },
    { label: 'database port is above range', change: (environment) => {
      environment.DATABASE_PORT = '65536';
    } },
    { label: 'database port has a noncanonical leading zero', change: (environment) => {
      environment.DATABASE_PORT = '055432';
    } },
    { label: 'database port has noncanonical whitespace', change: (environment) => {
      environment.DATABASE_PORT = '55432 ';
    } },
    { label: 'database name is not the isolated test name', change: (environment) => {
      environment.DATABASE_NAME = 'pale_orbit';
    } },
    { label: 'worker user is not exact', change: (environment) => {
      environment.DATABASE_WORKER_USER = 'pale_orbit_worker';
    } },
    { label: 'configured concurrency is not one', change: (environment) => {
      environment.WORKER_CONCURRENCY = '2';
    } },
    { label: 'runtime concurrency is not one', concurrency: 2, change: () => undefined },
    { label: 'ready path is relative', change: (environment) => {
      environment.WORKER_READY_FILE = join('pale-orbit-test-storage-relative', 'worker.ready');
    } },
    { label: 'ready basename is not exact', change: (environment, fixture) => {
      environment.WORKER_READY_FILE = join(fixture.root, 'other.ready');
    } },
    { label: 'ready root is not owned', change: (environment) => {
      environment.WORKER_READY_FILE = join(tmpdir(), 'unowned-test-storage', 'worker.ready');
    } },
    { label: 'ready path lexically escapes its owned root', change: (environment, fixture) => {
      environment.WORKER_READY_FILE = join(
        fixture.root,
        '..',
        'escaped-test-storage',
        'worker.ready'
      );
    } },
    { label: 'ready path contains an owned-sibling lexical escape', change: (
      environment,
      fixture
    ) => {
      environment.WORKER_READY_FILE =
        `${fixture.root}${sep}..${sep}pale-orbit-test-storage-other${sep}worker.ready`;
    } },
    ...forbiddenSettings.map((setting) => ({
      label: `${setting} is present`,
      change: (environment: NodeJS.ProcessEnv) => { environment[setting] = 'forbidden'; }
    }))
  ];

  it.each(invalidConjuncts)('$label performs zero filesystem operations', async ({
    change,
    concurrency = 1
  }) => {
    const fixture = await activeFixture();
    const environment = { ...fixture.environment };
    change(environment, fixture);
    const fileSystem = inertFileSystem();
    const abortWorker = vi.fn();
    const maintenance = vi.fn().mockResolvedValue(undefined);
    const control = createTestWorkerControl({
      environment,
      concurrency,
      abortWorker,
      fileSystem: fileSystem as unknown as TestWorkerControlFileSystem
    });

    expect(control.active).toBe(false);
    await within(prepareTestWorkerPoll({
      control,
      signal: new AbortController().signal,
      maintenance
    }), 'running an inactive poll seam');

    expect(maintenance).toHaveBeenCalledOnce();
    expect(abortWorker).not.toHaveBeenCalled();
    expect(fileSystem.lstat).not.toHaveBeenCalled();
    expect(fileSystem.realpath).not.toHaveBeenCalled();
    expect(fileSystem.readFile).not.toHaveBeenCalled();
    expect(fileSystem.writeFile).not.toHaveBeenCalled();
    expect(fileSystem.rename).not.toHaveBeenCalled();
    expect(fileSystem.unlink).not.toHaveBeenCalled();
    expect(() => control.throwIfFailed()).not.toThrow();
  });

  it('activates for the exact worker-scoped predicate without touching siblings at creation', async () => {
    const fixture = await activeFixture();
    const fileSystem = inertFileSystem();
    const control = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker: vi.fn(),
      fileSystem: fileSystem as unknown as TestWorkerControlFileSystem
    });

    expect(control.active).toBe(true);
    expect(fileSystem.lstat).not.toHaveBeenCalled();
    expect(fileSystem.realpath).not.toHaveBeenCalled();
    expect(fileSystem.readFile).not.toHaveBeenCalled();
    expect(fileSystem.writeFile).not.toHaveBeenCalled();
    expect(fileSystem.rename).not.toHaveBeenCalled();
    expect(fileSystem.unlink).not.toHaveBeenCalled();
  });
});

describe('test worker control filesystem and acknowledgement failures', () => {
  it('keeps harness pause strict when readiness is absent and creates no control sibling', async () => {
    const fixture = await activeFixture();
    await unlink(fixture.readyFile);
    const randomBytes = randomBytesFor(NONCE_A);
    const harness = createTestWorkerControlHarness({
      environment: fixture.environment,
      randomBytes
    });

    await expect(harness.pause(new AbortController().signal))
      .rejects.toMatchObject({ code: 'ENOENT' });

    expect(randomBytes).not.toHaveBeenCalled();
    expect(await readdir(fixture.root)).toEqual([]);
  });

  it('fails worker preflight closed for a non-missing readiness inspection error', async () => {
    const fixture = await activeFixture();
    const workerAbort = new AbortController();
    const abortWorker = vi.fn((reason?: unknown) => workerAbort.abort(reason));
    const maintenance = vi.fn().mockResolvedValue(undefined);
    const fileSystem = {
      ...nodeFileSystem,
      lstat: vi.fn(async (path: string) => {
        if (path === fixture.readyFile) throw fileSystemError('EACCES');
        return lstat(path);
      })
    } as unknown as TestWorkerControlFileSystem;
    const control = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker,
      fileSystem
    });

    await within(prepareTestWorkerPoll({
      control,
      signal: workerAbort.signal,
      maintenance
    }), 'rejecting a non-missing readiness inspection error');

    expect(abortWorker).toHaveBeenCalledOnce();
    expect(workerAbort.signal.aborted).toBe(true);
    expect(maintenance).not.toHaveBeenCalled();
    expect(() => control.throwIfFailed()).toThrow();
  });

  it('allows repeated clean bootstrap polls then fails closed if readiness disappears', async () => {
    const fixture = await activeFixture();
    await unlink(fixture.readyFile);
    const workerAbort = new AbortController();
    const abortWorker = vi.fn((reason?: unknown) => workerAbort.abort(reason));
    const bootstrapMaintenance = vi.fn().mockResolvedValue(undefined);
    const readyMaintenance = vi.fn().mockResolvedValue(undefined);
    const disappearedMaintenance = vi.fn().mockResolvedValue(undefined);
    const control = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker
    });

    await within(prepareTestWorkerPoll({
      control,
      signal: workerAbort.signal,
      maintenance: bootstrapMaintenance
    }), 'completing a first clean bootstrap poll');
    await within(prepareTestWorkerPoll({
      control,
      signal: workerAbort.signal,
      maintenance: bootstrapMaintenance
    }), 'completing a repeated clean bootstrap poll');
    await writeFile(fixture.readyFile, 'test-worker', 'utf8');
    await within(prepareTestWorkerPoll({
      control,
      signal: workerAbort.signal,
      maintenance: readyMaintenance
    }), 'observing valid readiness');
    await unlink(fixture.readyFile);
    await within(prepareTestWorkerPoll({
      control,
      signal: workerAbort.signal,
      maintenance: disappearedMaintenance
    }), 'rejecting disappeared readiness');

    expect(bootstrapMaintenance).toHaveBeenCalledTimes(2);
    expect(readyMaintenance).toHaveBeenCalledOnce();
    expect(disappearedMaintenance).not.toHaveBeenCalled();
    expect(abortWorker).toHaveBeenCalledOnce();
    expect(workerAbort.signal.aborted).toBe(true);
    expect(() => control.throwIfFailed()).toThrow();
  });

  it('fails closed when the ready path resolves outside its lexical owned root', async () => {
    const fixture = await activeFixture();
    const workerAbort = new AbortController();
    const maintenance = vi.fn().mockResolvedValue(undefined);
    const outside = resolve(tmpdir(), 'outside-test-worker', 'worker.ready');
    const fileSystem = {
      ...nodeFileSystem,
      realpath: vi.fn(async (path: string) =>
        path === fixture.readyFile ? outside : realpath(path))
    } as unknown as TestWorkerControlFileSystem;
    const control = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker: (reason) => workerAbort.abort(reason),
      fileSystem
    });

    await within(prepareTestWorkerPoll({
      control,
      signal: workerAbort.signal,
      maintenance
    }), 'rejecting a resolved path escape');

    expect(workerAbort.signal.aborted).toBe(true);
    expect(maintenance).not.toHaveBeenCalled();
    expect(() => control.throwIfFailed()).toThrow();
  });

  it('fails preflight closed for a symlink control request and skips maintenance', async () => {
    const fixture = await activeFixture();
    await writeFile(fixture.requestFile, PAUSE_A, 'utf8');
    const workerAbort = new AbortController();
    const maintenance = vi.fn().mockResolvedValue(undefined);
    const fileSystem = {
      ...nodeFileSystem,
      lstat: vi.fn(async (path: string) => {
        if (path === fixture.requestFile) {
          return {
            isFile: (): boolean => false,
            isDirectory: (): boolean => false,
            isSymbolicLink: (): boolean => true
          };
        }
        return lstat(path);
      })
    } as unknown as TestWorkerControlFileSystem;
    const control = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker: (reason) => workerAbort.abort(reason),
      fileSystem
    });

    await within(prepareTestWorkerPoll({
      control,
      signal: workerAbort.signal,
      maintenance
    }), 'rejecting a request symlink');

    expect(workerAbort.signal.aborted).toBe(true);
    expect(maintenance).not.toHaveBeenCalled();
    expect(() => control.throwIfFailed()).toThrow();
  });

  it('fails the final barrier for a symlink acknowledgement after maintenance', async () => {
    const fixture = await activeFixture();
    await writeFile(fixture.requestFile, PAUSE_A, 'utf8');
    const workerAbort = new AbortController();
    let acknowledgementIsSymlink = false;
    const fileSystem = {
      ...nodeFileSystem,
      lstat: vi.fn(async (path: string) => {
        if (path === fixture.acknowledgementFile && acknowledgementIsSymlink) {
          return {
            isFile: (): boolean => false,
            isDirectory: (): boolean => false,
            isSymbolicLink: (): boolean => true
          };
        }
        return lstat(path);
      })
    } as unknown as TestWorkerControlFileSystem;
    const control = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker: (reason) => workerAbort.abort(reason),
      fileSystem
    });
    const maintenance = vi.fn(async () => {
      acknowledgementIsSymlink = true;
      await writeFile(fixture.requestFile, RELEASE_A, 'utf8');
    });

    await within(prepareTestWorkerPoll({
      control,
      signal: workerAbort.signal,
      maintenance
    }), 'rejecting an acknowledgement symlink');

    expect(maintenance).toHaveBeenCalledOnce();
    expect(workerAbort.signal.aborted).toBe(true);
    expect(() => control.throwIfFailed()).toThrow();
  });

  it.each(['EPERM', 'EACCES', 'EBUSY'])(
    'retries transient Windows %s rename contention and removes its temp lock',
    async (code) => {
      const fixture = await activeFixture();
      let requestRenameCount = 0;
      const fileSystem = {
        ...nodeFileSystem,
        rename: vi.fn(async (from: string, to: string) => {
          if (to === fixture.requestFile) {
            requestRenameCount += 1;
            if (requestRenameCount === 2) throw fileSystemError(code);
          }
          await rename(from, to);
        })
      } as unknown as TestWorkerControlFileSystem;
      const retryWait = vi.fn(async (
        _milliseconds: number,
        signal: AbortSignal
      ) => {
        if (signal.aborted) {
          throw signal.reason ?? new DOMException('Aborted', 'AbortError');
        }
        await Promise.resolve();
      });
      const workerAbort = new AbortController();
      const control = createTestWorkerControl({
        environment: fixture.environment,
        concurrency: 1,
        abortWorker: (reason) => workerAbort.abort(reason),
        fileSystem
      });
      const harness = createTestWorkerControlHarness({
        environment: fixture.environment,
        randomBytes: randomBytesFor(NONCE_A),
        fileSystem,
        wait: retryWait
      });

      const released = await releasedSession({ fixture, control, harness });

      expect(requestRenameCount).toBeGreaterThanOrEqual(3);
      expect(retryWait.mock.calls.some((call) =>
        call[1] === released.signal.signal
      )).toBe(true);
      expect((await readdir(fixture.root)).some((name) =>
        name.endsWith('.tmp')
      )).toBe(false);
      await released.session.finish({
        signal: released.signal.signal,
        waitForTerminal: vi.fn().mockResolvedValue(undefined)
      });
    }
  );

  it('bounds persistent rename contention and removes its owned temp lock', async () => {
    const fixture = await activeFixture();
    let requestRenameCount = 0;
    let renameContending = false;
    const fileSystem = {
      ...nodeFileSystem,
      rename: vi.fn(async (from: string, to: string) => {
        if (to === fixture.requestFile) {
          requestRenameCount += 1;
          if (requestRenameCount >= 2) {
            renameContending = true;
            throw fileSystemError('EPERM');
          }
        }
        await rename(from, to);
      })
    } as unknown as TestWorkerControlFileSystem;
    let nowValue = 0;
    const wait = vi.fn(async (_milliseconds: number, signal: AbortSignal) => {
      if (signal.aborted) {
        throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      }
      if (renameContending) nowValue += 1_000;
      else await new Promise<void>((resolveValue) => setImmediate(resolveValue));
    });
    const workerAbort = new AbortController();
    const control = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker: (reason) => workerAbort.abort(reason),
      fileSystem
    });
    const harness = createTestWorkerControlHarness({
      environment: fixture.environment,
      randomBytes: randomBytesFor(NONCE_A),
      fileSystem,
      now: () => nowValue,
      wait
    });
    const signal = new AbortController();
    const pausing = harness.pause(signal.signal);
    await waitForContents(fixture.requestFile, PAUSE_A);
    const polling = prepareTestWorkerPoll({
      control,
      signal: workerAbort.signal,
      maintenance: vi.fn().mockResolvedValue(undefined)
    });
    const session = await within(pausing, 'pausing before rename deadline');

    await expect(session.release({
      commandId: COMMAND_A,
      failCommand: false,
      signal: signal.signal
    })).rejects.toThrow(/rename|deadline/i);
    expect(nowValue).toBeGreaterThanOrEqual(
      TEST_WORKER_CONTROL_DEADLINE_MS
    );
    expect((await readdir(fixture.root)).some((name) =>
      name.endsWith('.tmp')
    )).toBe(false);
    workerAbort.abort();
    await within(polling, 'aborting the worker-side release wait');
  });

  it('aborts rename contention and removes its owned temp lock', async () => {
    const fixture = await activeFixture();
    let requestRenameCount = 0;
    let renameContending = false;
    const renameEntered = deferred<void>();
    const fileSystem = {
      ...nodeFileSystem,
      rename: vi.fn(async (from: string, to: string) => {
        if (to === fixture.requestFile) {
          requestRenameCount += 1;
          if (requestRenameCount >= 2) {
            renameContending = true;
            renameEntered.resolve();
            throw fileSystemError('EBUSY');
          }
        }
        await rename(from, to);
      })
    } as unknown as TestWorkerControlFileSystem;
    const wait = vi.fn(async (_milliseconds: number, signal: AbortSignal) => {
      if (!renameContending) {
        await new Promise<void>((resolveValue) => setImmediate(resolveValue));
        return;
      }
      await new Promise<void>((_resolveValue, rejectValue) => {
        const abort = () => rejectValue(
          signal.reason ?? new DOMException('Aborted', 'AbortError')
        );
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    });
    const workerAbort = new AbortController();
    const control = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker: (reason) => workerAbort.abort(reason),
      fileSystem
    });
    const harness = createTestWorkerControlHarness({
      environment: fixture.environment,
      randomBytes: randomBytesFor(NONCE_A),
      fileSystem,
      wait
    });
    const releaseSignal = new AbortController();
    const pausing = harness.pause(releaseSignal.signal);
    await waitForContents(fixture.requestFile, PAUSE_A);
    const polling = prepareTestWorkerPoll({
      control,
      signal: workerAbort.signal,
      maintenance: vi.fn().mockResolvedValue(undefined)
    });
    const session = await within(pausing, 'pausing before rename abort');
    const releasing = session.release({
      commandId: COMMAND_A,
      failCommand: false,
      signal: releaseSignal.signal
    });
    await within(renameEntered.promise, 'entering rename contention');
    releaseSignal.abort(new DOMException('Stopped by test', 'AbortError'));

    await expect(within(releasing, 'aborting rename contention'))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect((await readdir(fixture.root)).some((name) =>
      name.endsWith('.tmp')
    )).toBe(false);
    workerAbort.abort();
    await within(polling, 'aborting the worker-side release wait');
  });

  it.each([
    ['stale nonce', encodeTestWorkerControlAcknowledgement({
      version: 1,
      nonce: NONCE_B,
      phase: 'paused'
    })],
    ['mismatched phase', RELEASED_A],
    ['malformed acknowledgement', '{']
  ])('rejects a %s while awaiting pause', async (_label, acknowledgement) => {
    const fixture = await activeFixture();
    await writeFile(fixture.acknowledgementFile, acknowledgement, 'utf8');
    const deadline = advancingDeadline();
    const signal = new AbortController();
    const harness = createTestWorkerControlHarness({
      environment: fixture.environment,
      randomBytes: randomBytesFor(NONCE_A),
      now: deadline.now,
      wait: deadline.wait
    });

    await expect(within(
      harness.pause(signal.signal),
      'rejecting a bad paused acknowledgement'
    )).rejects.toThrow();
    expect(deadline.waits.every((entry) => entry.signal === signal.signal)).toBe(true);
  });

  it('rejects a missing acknowledgement at the explicit deadline', async () => {
    const fixture = await activeFixture();
    const deadline = advancingDeadline();
    const signal = new AbortController();
    const harness = createTestWorkerControlHarness({
      environment: fixture.environment,
      randomBytes: randomBytesFor(NONCE_A),
      now: deadline.now,
      wait: deadline.wait
    });

    await expect(within(
      harness.pause(signal.signal),
      'reaching the acknowledgement deadline'
    )).rejects.toThrow(/deadline|acknowledgement|timeout/i);
    expect(deadline.elapsed()).toBeGreaterThanOrEqual(TEST_WORKER_CONTROL_DEADLINE_MS);
    expect(deadline.waits.length).toBeGreaterThan(0);
    expect(deadline.waits.every((entry) =>
      entry.milliseconds > 0 &&
      entry.milliseconds <= TEST_WORKER_CONTROL_DEADLINE_MS &&
      entry.signal === signal.signal
    )).toBe(true);
  });

  it('aborts an acknowledgement wait with the harness-owned signal', async () => {
    const fixture = await activeFixture();
    const waiting = deferred<void>();
    const wait = vi.fn((_milliseconds: number, signal: AbortSignal) =>
      new Promise<void>((resolveValue, rejectValue) => {
        waiting.resolve();
        const abort = () => rejectValue(
          signal.reason ?? new DOMException('Aborted', 'AbortError')
        );
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      }));
    const signal = new AbortController();
    const harness = createTestWorkerControlHarness({
      environment: fixture.environment,
      randomBytes: randomBytesFor(NONCE_A),
      wait
    });
    const pausing = harness.pause(signal.signal);
    await within(waiting.promise, 'entering the acknowledgement wait');
    signal.abort(new DOMException('Stopped by test', 'AbortError'));

    await expect(within(pausing, 'aborting the acknowledgement wait'))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(wait).toHaveBeenCalled();
    expect(wait.mock.calls.every((call) => call[1] === signal.signal)).toBe(true);
  });
});

describe('test worker control state machine', () => {
  it('generates 16 random bytes and completes both exact same-nonce phases', async () => {
    const fixture = await activeFixture();
    const workerAbort = new AbortController();
    const randomBytes = randomBytesFor(NONCE_A);
    const control = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker: (reason) => workerAbort.abort(reason)
    });
    const harness = createTestWorkerControlHarness({
      environment: fixture.environment,
      randomBytes
    });
    const harnessSignal = new AbortController();

    const pausing = harness.pause(harnessSignal.signal);
    await waitForContents(fixture.requestFile, PAUSE_A);
    const maintenance = vi.fn().mockResolvedValue(undefined);
    const polling = prepareTestWorkerPoll({
      control,
      signal: workerAbort.signal,
      maintenance
    });
    const session = await within(pausing, 'receiving the paused acknowledgement');
    expect(session.nonce).toBe(NONCE_A);
    await waitForContents(fixture.acknowledgementFile, PAUSED_A);

    const releasing = session.release({
      commandId: COMMAND_A,
      failCommand: true,
      signal: harnessSignal.signal
    });
    await within(
      Promise.all([polling, releasing]).then(() => undefined),
      'receiving the released acknowledgement'
    );

    expect(randomBytes).toHaveBeenCalledOnce();
    expect(randomBytes).toHaveBeenCalledWith(16);
    expect(maintenance).toHaveBeenCalledOnce();
    expect(await readFile(fixture.requestFile, 'utf8'))
      .toBe(RELEASE_A_WITH_FAILURE);
    expect(await readFile(fixture.acknowledgementFile, 'utf8')).toBe(RELEASED_A);
    expect(workerAbort.signal.aborted).toBe(false);
    expect(() => control.throwIfFailed()).not.toThrow();
    await session.finish({
      signal: harnessSignal.signal,
      waitForTerminal: vi.fn().mockResolvedValue(undefined)
    });
  });

  it.each([
    ['release before pause', RELEASE_A],
    ['malformed request', '{'],
    ['unknown request key', `{"version":1,"nonce":"${NONCE_A}","phase":"pause","unknown":1}`]
  ])('fails closed for %s', async (_label, raw) => {
    const fixture = await activeFixture();
    await writeFile(fixture.requestFile, raw, 'utf8');
    const workerAbort = new AbortController();
    const maintenance = vi.fn().mockResolvedValue(undefined);
    const control = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker: (reason) => workerAbort.abort(reason)
    });

    await within(prepareTestWorkerPoll({
      control,
      signal: workerAbort.signal,
      maintenance
    }), 'rejecting invalid request state');

    expect(maintenance).not.toHaveBeenCalled();
    expect(workerAbort.signal.aborted).toBe(true);
    expect(() => control.throwIfFailed()).toThrow();
  });

  it('rejects a different concurrent nonce after acknowledging pause', async () => {
    const fixture = await activeFixture();
    await writeFile(fixture.requestFile, PAUSE_A, 'utf8');
    const workerAbort = new AbortController();
    const control = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker: (reason) => workerAbort.abort(reason)
    });
    const polling = prepareTestWorkerPoll({
      control,
      signal: workerAbort.signal,
      maintenance: vi.fn().mockResolvedValue(undefined)
    });
    await waitForContents(fixture.acknowledgementFile, PAUSED_A);
    await writeFile(fixture.requestFile, encodeTestWorkerControlRequest({
      version: 1,
      nonce: NONCE_B,
      phase: 'pause'
    }), 'utf8');

    await within(polling, 'rejecting a concurrent nonce');
    expect(workerAbort.signal.aborted).toBe(true);
    expect(() => control.throwIfFailed()).toThrow();
  });

  it('rejects a reused completed nonce', async () => {
    const fixture = await activeFixture();
    const workerAbort = new AbortController();
    const control = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker: (reason) => workerAbort.abort(reason)
    });
    const harness = createTestWorkerControlHarness({
      environment: fixture.environment,
      randomBytes: randomBytesFor(NONCE_A)
    });
    const completed = await releasedSession({ fixture, control, harness });
    await completed.session.finish({
      signal: completed.signal.signal,
      waitForTerminal: vi.fn().mockResolvedValue(undefined)
    });
    await writeFile(fixture.requestFile, PAUSE_A, 'utf8');
    const maintenance = vi.fn().mockResolvedValue(undefined);

    await within(prepareTestWorkerPoll({
      control,
      signal: workerAbort.signal,
      maintenance
    }), 'rejecting a completed nonce');

    expect(maintenance).not.toHaveBeenCalled();
    expect(workerAbort.signal.aborted).toBe(true);
    expect(() => control.throwIfFailed()).toThrow();
  });

  it('treats its exact stable release/released pair as a later-poll no-op', async () => {
    const fixture = await activeFixture();
    const workerAbort = new AbortController();
    const control = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker: (reason) => workerAbort.abort(reason)
    });
    const harness = createTestWorkerControlHarness({
      environment: fixture.environment,
      randomBytes: randomBytesFor(NONCE_A)
    });
    const completed = await releasedSession({ fixture, control, harness });
    const maintenance = vi.fn().mockResolvedValue(undefined);

    await within(prepareTestWorkerPoll({
      control,
      signal: completed.signal.signal,
      maintenance
    }), 'accepting the stable completed handshake');

    expect(maintenance).toHaveBeenCalledOnce();
    expect(await readFile(fixture.requestFile, 'utf8')).toBe(RELEASE_A);
    expect(await readFile(fixture.acknowledgementFile, 'utf8')).toBe(RELEASED_A);
    expect(workerAbort.signal.aborted).toBe(false);
    expect(() => control.throwIfFailed()).not.toThrow();
    await completed.session.finish({
      signal: completed.signal.signal,
      waitForTerminal: vi.fn().mockResolvedValue(undefined)
    });
  });

  it('tolerates request-first partial cleanup only for its completed nonce', async () => {
    const fixture = await activeFixture();
    const workerAbort = new AbortController();
    const control = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker: (reason) => workerAbort.abort(reason)
    });
    const harness = createTestWorkerControlHarness({
      environment: fixture.environment,
      randomBytes: randomBytesFor(NONCE_A)
    });
    const completed = await releasedSession({ fixture, control, harness });
    await unlink(fixture.requestFile);
    const maintenance = vi.fn().mockResolvedValue(undefined);

    await within(prepareTestWorkerPoll({
      control,
      signal: completed.signal.signal,
      maintenance
    }), 'accepting request-first partial cleanup');

    expect(maintenance).toHaveBeenCalledOnce();
    expect(await readFile(fixture.acknowledgementFile, 'utf8')).toBe(RELEASED_A);
    expect(workerAbort.signal.aborted).toBe(false);
    expect(() => control.throwIfFailed()).not.toThrow();
    await completed.session.finish({
      signal: completed.signal.signal,
      waitForTerminal: vi.fn().mockResolvedValue(undefined)
    });
    await expect(readFile(fixture.acknowledgementFile, 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('validates the release command ID and failure flag before replacing pause', async () => {
    const fixture = await activeFixture();
    const workerAbort = new AbortController();
    const harnessSignal = new AbortController();
    const control = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker: (reason) => workerAbort.abort(reason)
    });
    const harness = createTestWorkerControlHarness({
      environment: fixture.environment,
      randomBytes: randomBytesFor(NONCE_A)
    });
    const pausing = harness.pause(harnessSignal.signal);
    await waitForContents(fixture.requestFile, PAUSE_A);
    const polling = prepareTestWorkerPoll({
      control,
      signal: workerAbort.signal,
      maintenance: vi.fn().mockResolvedValue(undefined)
    });
    const session = await within(pausing, 'receiving pause before invalid release');

    await expect(session.release({
      commandId: 'not-a-command-id',
      failCommand: false,
      signal: harnessSignal.signal
    })).rejects.toThrow();
    await expect(session.release({
      commandId: COMMAND_A,
      failCommand: 'true' as never,
      signal: harnessSignal.signal
    })).rejects.toThrow();
    expect(await readFile(fixture.requestFile, 'utf8')).toBe(PAUSE_A);

    const releasing = session.release({
      commandId: COMMAND_A,
      failCommand: false,
      signal: harnessSignal.signal
    });
    await within(
      Promise.all([polling, releasing]).then(() => undefined),
      'releasing after rejected invalid inputs'
    );
    await session.finish({
      signal: harnessSignal.signal,
      waitForTerminal: vi.fn().mockResolvedValue(undefined)
    });
  });

  it('rejects a concurrent second release and terminal-bypassing cleanup', async () => {
    const fixture = await activeFixture();
    const workerAbort = new AbortController();
    const harnessSignal = new AbortController();
    const control = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker: (reason) => workerAbort.abort(reason)
    });
    const harness = createTestWorkerControlHarness({
      environment: fixture.environment,
      randomBytes: randomBytesFor(NONCE_A)
    });
    const pausing = harness.pause(harnessSignal.signal);
    await waitForContents(fixture.requestFile, PAUSE_A);
    const polling = prepareTestWorkerPoll({
      control,
      signal: workerAbort.signal,
      maintenance: vi.fn().mockResolvedValue(undefined)
    });
    const session = await within(pausing, 'pausing before concurrent release');
    const firstRelease = session.release({
      commandId: COMMAND_A,
      failCommand: false,
      signal: harnessSignal.signal
    });

    await expect(session.release({
      commandId: COMMAND_B,
      failCommand: false,
      signal: harnessSignal.signal
    })).rejects.toThrow(/paused|sequence|release/i);
    await within(
      Promise.all([polling, firstRelease]).then(() => undefined),
      'finishing the first release'
    );
    await expect(session.cleanup(harnessSignal.signal))
      .rejects.toThrow(/terminal/i);
    expect(await readFile(fixture.requestFile, 'utf8')).toBe(RELEASE_A);
    expect(await readFile(fixture.acknowledgementFile, 'utf8')).toBe(RELEASED_A);
    await session.finish({
      signal: harnessSignal.signal,
      waitForTerminal: vi.fn().mockResolvedValue(undefined)
    });
  });

  it('reserves finish while recovering an aborted release acknowledgement wait', async () => {
    const fixture = await activeFixture();
    const pausePublished = deferred<void>();
    const releasePublished = deferred<void>();
    let requestRenames = 0;
    const fileSystem = {
      ...nodeFileSystem,
      rename: vi.fn(async (from: string, to: string) => {
        await rename(from, to);
        if (to !== fixture.requestFile) return;
        requestRenames += 1;
        if (requestRenames === 1) pausePublished.resolve();
        if (requestRenames === 2) releasePublished.resolve();
      })
    } as TestWorkerControlFileSystem;
    const harness = createTestWorkerControlHarness({
      environment: fixture.environment,
      randomBytes: randomBytesFor(NONCE_A),
      fileSystem
    });
    const pauseSignal = new AbortController();
    const pausing = harness.pause(pauseSignal.signal);
    await within(pausePublished.promise, 'publishing pause before release recovery');
    await writeFile(fixture.acknowledgementFile, PAUSED_A, 'utf8');
    const session = await within(pausing, 'acknowledging pause before release recovery');

    const releaseSignal = new AbortController();
    const releasing = session.release({
      commandId: COMMAND_A,
      failCommand: false,
      signal: releaseSignal.signal
    });
    await within(releasePublished.promise, 'publishing release before abort');
    releaseSignal.abort(new DOMException('Stopped by test', 'AbortError'));
    await expect(within(releasing, 'aborting the release acknowledgement wait'))
      .rejects.toMatchObject({ name: 'AbortError' });

    const terminalEntered = deferred<void>();
    const completeTerminal = deferred<void>();
    const finishSignal = new AbortController();
    const firstWaitForTerminal = vi.fn(async () => {
      terminalEntered.resolve();
      await completeTerminal.promise;
    });
    const secondWaitForTerminal = vi.fn().mockResolvedValue(undefined);
    const firstFinish = session.finish({
      signal: finishSignal.signal,
      waitForTerminal: firstWaitForTerminal
    });
    const secondFinish = session.finish({
      signal: finishSignal.signal,
      waitForTerminal: secondWaitForTerminal
    }).then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error })
    );
    await writeFile(fixture.acknowledgementFile, RELEASED_A, 'utf8');
    await within(terminalEntered.promise, 'entering the reserved terminal wait');
    const secondResult = await within(secondFinish, 'rejecting concurrent finish');
    completeTerminal.resolve();
    await within(firstFinish, 'completing the reserved finish');

    expect(secondResult.error).toBeInstanceOf(Error);
    expect(secondWaitForTerminal).not.toHaveBeenCalled();
    expect(firstWaitForTerminal).toHaveBeenCalledOnce();
  });
});

describe('test worker control integration with the real runner', () => {
  it('allows the first repository poll before heartbeat evidence when control siblings are absent', async () => {
    const fixture = await activeFixture();
    await unlink(fixture.readyFile);
    const workerAbort = new AbortController();
    const abortWorker = vi.fn((reason?: unknown) => workerAbort.abort(reason));
    const repository = repositoryWithNoJobs(() => workerAbort.abort());
    const maintenance = vi.fn().mockResolvedValue(undefined);
    const control = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker
    });

    await within(runWorker({
      repository,
      handlers: new Map(),
      workerId: 'test-pre-readiness-worker',
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 1,
      signal: workerAbort.signal,
      beforePoll: ({ signal }) => prepareTestWorkerPoll({
        control,
        signal,
        maintenance
      }),
      sleep: async () => workerAbort.abort()
    }), 'completing the first pre-readiness repository poll');

    expect(await readdir(fixture.root)).toEqual([]);
    expect(maintenance).toHaveBeenCalledOnce();
    expect(repository.claimNext).toHaveBeenCalledOnce();
    expect(abortWorker).not.toHaveBeenCalled();
    expect(() => control.throwIfFailed()).not.toThrow();
  });

  it.each([
    {
      label: 'request',
      path: (fixture: ActiveFixture) => fixture.requestFile,
      contents: PAUSE_A
    },
    {
      label: 'acknowledgement',
      path: (fixture: ActiveFixture) => fixture.acknowledgementFile,
      contents: PAUSED_A
    },
    {
      label: 'request temp',
      path: (fixture: ActiveFixture) => fixture.requestTempFile,
      contents: PAUSE_A
    },
    {
      label: 'acknowledgement temp',
      path: (fixture: ActiveFixture) => fixture.acknowledgementTempFile,
      contents: PAUSED_A
    }
  ])('fails closed when a $label sibling precedes readiness', async ({
    path,
    contents
  }) => {
    const fixture = await activeFixture();
    await unlink(fixture.readyFile);
    await writeFile(path(fixture), contents, 'utf8');
    const workerAbort = new AbortController();
    const abortWorker = vi.fn((reason?: unknown) => workerAbort.abort(reason));
    const repository = repositoryWithNoJobs();
    const maintenance = vi.fn().mockResolvedValue(undefined);
    const control = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker
    });

    await within(runWorker({
      repository,
      handlers: new Map(),
      workerId: 'test-invalid-pre-readiness-worker',
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 1,
      signal: workerAbort.signal,
      beforePoll: ({ signal }) => prepareTestWorkerPoll({
        control,
        signal,
        maintenance
      }),
      sleep: async () => undefined
    }), 'rejecting a control sibling before readiness');

    expect(abortWorker).toHaveBeenCalledOnce();
    expect(repository.claimNext).not.toHaveBeenCalled();
    expect(maintenance).not.toHaveBeenCalled();
    expect(() => control.throwIfFailed()).toThrow();
  });

  it('aborts on malformed control before the fake repository can claim', async () => {
    const fixture = await activeFixture();
    await writeFile(fixture.requestFile, '{"private":"malformed"}', 'utf8');
    const workerAbort = new AbortController();
    const repository = repositoryWithNoJobs();
    const maintenance = vi.fn().mockResolvedValue(undefined);
    const control = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker: (reason) => workerAbort.abort(reason)
    });

    await within(runWorker({
      repository,
      handlers: new Map(),
      workerId: 'test-controlled-worker',
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 1,
      signal: workerAbort.signal,
      beforePoll: ({ signal }) => prepareTestWorkerPoll({
        control,
        signal,
        maintenance
      }),
      sleep: async () => workerAbort.abort()
    }), 'stopping the runner after malformed control');

    expect(repository.claimNext).not.toHaveBeenCalled();
    expect(maintenance).not.toHaveBeenCalled();
    expect(workerAbort.signal.aborted).toBe(true);
    expect(() => control.throwIfFailed()).toThrow();
  });

  it('holds an acknowledged pause beyond the transition deadline until exact release', async () => {
    const fixture = await activeFixture();
    const workerAbort = new AbortController();
    const heldBeyondTransitionDeadline = deferred<void>();
    const continueReleaseWait = deferred<void>();
    let nowValue = 0;
    let releasedWait = false;
    const wait = vi.fn(async (_milliseconds: number, signal: AbortSignal) => {
      if (signal.aborted) {
        throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      }
      nowValue += 1_000;
      if (nowValue > TEST_WORKER_CONTROL_DEADLINE_MS && !releasedWait) {
        heldBeyondTransitionDeadline.resolve();
        await continueReleaseWait.promise;
        releasedWait = true;
      }
      await new Promise<void>((resolveValue) => setImmediate(resolveValue));
    });
    const repository = repositoryWithNoJobs(() => workerAbort.abort());
    const control = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker: (reason) => workerAbort.abort(reason),
      now: () => nowValue,
      wait
    });
    const releaseWitness = releaseWitnessFileSystem(fixture.requestFile);
    const harness = createTestWorkerControlHarness({
      environment: fixture.environment,
      fileSystem: releaseWitness.fileSystem,
      randomBytes: randomBytesFor(NONCE_A)
    });
    const harnessSignal = new AbortController();
    const pausing = harness.pause(harnessSignal.signal);
    await waitForContents(fixture.requestFile, PAUSE_A);
    const running = runWorker({
      repository,
      handlers: new Map(),
      workerId: 'test-durable-pause-worker',
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 1,
      signal: workerAbort.signal,
      beforePoll: ({ signal }) => prepareTestWorkerPoll({
        control,
        signal,
        maintenance: vi.fn().mockResolvedValue(undefined)
      }),
      sleep: async () => undefined
    });
    const session = await within(pausing, 'acknowledging the durable pause');

    await within(
      heldBeyondTransitionDeadline.promise,
      'holding beyond the transition deadline'
    );
    expect(nowValue).toBeGreaterThan(TEST_WORKER_CONTROL_DEADLINE_MS);
    expect(workerAbort.signal.aborted).toBe(false);
    expect(repository.claimNext).not.toHaveBeenCalled();

    const cleanup = session.cleanup(harnessSignal.signal);
    await within(releaseWitness.published, 'publishing the durable-pause release');
    continueReleaseWait.resolve();
    await within(
      Promise.all([running, cleanup]).then(() => undefined),
      'releasing the durable pause'
    );

    expect(repository.claimNext).toHaveBeenCalledOnce();
    expect(workerAbort.signal.aborted).toBe(true);
    expect(() => control.throwIfFailed()).not.toThrow();
  });

  it('accepts release observed one millisecond before the acknowledged-hold deadline', async () => {
    const fixture = await activeFixture();
    const workerAbort = new AbortController();
    const releaseWindow = deferred<void>();
    const continueReleaseWait = deferred<void>();
    let nowValue = 0;
    let parked = false;
    const wait = vi.fn(async (_milliseconds: number, signal: AbortSignal) => {
      if (signal.aborted) {
        throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      }
      if (!parked) {
        parked = true;
        nowValue = TEST_WORKER_CONTROL_ACKNOWLEDGED_HOLD_DEADLINE_MS - 1;
        releaseWindow.resolve();
        await continueReleaseWait.promise;
      }
      await new Promise<void>((resolveValue) => setImmediate(resolveValue));
    });
    const abortWorker = vi.fn((reason?: unknown) => workerAbort.abort(reason));
    const repository = repositoryWithNoJobs(() => workerAbort.abort());
    const control = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker,
      now: () => nowValue,
      wait
    });
    const releaseWitness = releaseWitnessFileSystem(fixture.requestFile);
    const harness = createTestWorkerControlHarness({
      environment: fixture.environment,
      fileSystem: releaseWitness.fileSystem,
      randomBytes: randomBytesFor(NONCE_A)
    });
    const harnessSignal = new AbortController();
    const pausing = harness.pause(harnessSignal.signal);
    await waitForContents(fixture.requestFile, PAUSE_A);
    const running = runWorker({
      repository,
      handlers: new Map(),
      workerId: 'test-pre-boundary-pause-worker',
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 1,
      signal: workerAbort.signal,
      beforePoll: ({ signal }) => prepareTestWorkerPoll({
        control,
        signal,
        maintenance: vi.fn().mockResolvedValue(undefined)
      }),
      sleep: async () => undefined
    });
    const session = await within(pausing, 'acknowledging the pre-boundary pause');
    await within(releaseWindow.promise, 'reaching the pre-boundary release window');

    const cleanup = session.cleanup(harnessSignal.signal);
    await within(releaseWitness.published, 'publishing the pre-boundary release');
    continueReleaseWait.resolve();
    await within(
      Promise.all([running, cleanup]).then(() => undefined),
      'accepting the pre-boundary release'
    );

    expect(nowValue).toBe(TEST_WORKER_CONTROL_ACKNOWLEDGED_HOLD_DEADLINE_MS - 1);
    expect(abortWorker).not.toHaveBeenCalled();
    expect(repository.claimNext).toHaveBeenCalledOnce();
    expect(() => control.throwIfFailed()).not.toThrow();
  });

  it('expires fail closed when release is first observable at the acknowledged-hold boundary', async () => {
    const fixture = await activeFixture();
    const workerAbort = new AbortController();
    const boundaryReached = deferred<void>();
    const continueBoundaryWait = deferred<void>();
    let nowValue = 0;
    let parked = false;
    const wait = vi.fn(async (_milliseconds: number, signal: AbortSignal) => {
      if (signal.aborted) {
        throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      }
      if (!parked) {
        parked = true;
        nowValue = TEST_WORKER_CONTROL_ACKNOWLEDGED_HOLD_DEADLINE_MS;
        boundaryReached.resolve();
        await continueBoundaryWait.promise;
      }
      await new Promise<void>((resolveValue) => setImmediate(resolveValue));
    });
    const abortWorker = vi.fn((reason?: unknown) => workerAbort.abort(reason));
    const repository = repositoryWithNoJobs(() => workerAbort.abort());
    const control = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker,
      now: () => nowValue,
      wait
    });
    const releaseWitness = releaseWitnessFileSystem(fixture.requestFile);
    const harness = createTestWorkerControlHarness({
      environment: fixture.environment,
      fileSystem: releaseWitness.fileSystem,
      randomBytes: randomBytesFor(NONCE_A)
    });
    const harnessSignal = new AbortController();
    const pausing = harness.pause(harnessSignal.signal);
    await waitForContents(fixture.requestFile, PAUSE_A);
    const running = runWorker({
      repository,
      handlers: new Map(),
      workerId: 'test-boundary-expiry-worker',
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 1,
      signal: workerAbort.signal,
      beforePoll: ({ signal }) => prepareTestWorkerPoll({
        control,
        signal,
        maintenance: vi.fn().mockResolvedValue(undefined)
      }),
      sleep: async () => undefined
    });
    const session = await within(pausing, 'acknowledging the boundary pause');
    await within(boundaryReached.promise, 'reaching the acknowledged-hold boundary');

    const cleanup = session.cleanup(harnessSignal.signal);
    await within(releaseWitness.published, 'publishing the boundary release');
    continueBoundaryWait.resolve();
    await within(running, 'failing closed at the acknowledged-hold boundary');
    harnessSignal.abort(new DOMException('Boundary cleanup', 'AbortError'));
    await cleanup.catch(() => undefined);

    expect(nowValue).toBe(TEST_WORKER_CONTROL_ACKNOWLEDGED_HOLD_DEADLINE_MS);
    expect(abortWorker).toHaveBeenCalledOnce();
    expect(repository.claimNext).not.toHaveBeenCalled();
    expect(() => control.throwIfFailed()).toThrow(
      'Test worker control acknowledged pause deadline expired'
    );
  });

  it('caps a nested transition wait at the remaining acknowledged-hold time', async () => {
    const fixture = await activeFixture();
    const workerAbort = new AbortController();
    const nearBoundary = deferred<void>();
    const continueOuterPoll = deferred<void>();
    const nestedWaitObserved = deferred<number>();
    let nowValue = 0;
    let waitCount = 0;
    const wait = vi.fn(async (milliseconds: number, signal: AbortSignal) => {
      if (signal.aborted) {
        throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      }
      waitCount += 1;
      if (waitCount === 1) {
        nowValue = TEST_WORKER_CONTROL_ACKNOWLEDGED_HOLD_DEADLINE_MS - 1;
        nearBoundary.resolve();
        await continueOuterPoll.promise;
        return;
      }
      nestedWaitObserved.resolve(milliseconds);
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')),
          { once: true }
        );
      });
    });
    const repository = repositoryWithNoJobs();
    const control = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker: (reason) => workerAbort.abort(reason),
      now: () => nowValue,
      wait
    });
    const harness = createTestWorkerControlHarness({
      environment: fixture.environment,
      randomBytes: randomBytesFor(NONCE_A)
    });
    const harnessSignal = new AbortController();
    const pausing = harness.pause(harnessSignal.signal);
    await waitForContents(fixture.requestFile, PAUSE_A);
    const running = runWorker({
      repository,
      handlers: new Map(),
      workerId: 'test-capped-transition-worker',
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 1,
      signal: workerAbort.signal,
      beforePoll: ({ signal }) => prepareTestWorkerPoll({
        control,
        signal,
        maintenance: vi.fn().mockResolvedValue(undefined)
      }),
      sleep: async () => undefined
    });
    await within(pausing, 'acknowledging the capped-transition pause');
    await within(nearBoundary.promise, 'reaching the capped-transition boundary');
    await writeFile(join(fixture.root, 'worker.control.tmp'), PAUSE_A, 'utf8');
    continueOuterPoll.resolve();

    const nestedWait = await within(
      nestedWaitObserved.promise,
      'observing the capped nested transition wait'
    );
    workerAbort.abort(new DOMException('Test teardown', 'AbortError'));
    await within(running, 'aborting the capped-transition worker');

    expect(nestedWait).toBe(1);
    expect(repository.claimNext).not.toHaveBeenCalled();
    expect(() => control.throwIfFailed()).not.toThrow();
  });

  it('abandons an acknowledged pause promptly when the worker lifecycle aborts', async () => {
    const fixture = await activeFixture();
    const workerAbort = new AbortController();
    const repository = repositoryWithNoJobs();
    const abortWorker = vi.fn((reason?: unknown) => workerAbort.abort(reason));
    const control = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker
    });
    const harness = createTestWorkerControlHarness({
      environment: fixture.environment,
      randomBytes: randomBytesFor(NONCE_A)
    });
    const harnessSignal = new AbortController();
    const pausing = harness.pause(harnessSignal.signal);
    await waitForContents(fixture.requestFile, PAUSE_A);
    const running = runWorker({
      repository,
      handlers: new Map(),
      workerId: 'test-abortable-pause-worker',
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 1,
      signal: workerAbort.signal,
      beforePoll: ({ signal }) => prepareTestWorkerPoll({
        control,
        signal,
        maintenance: vi.fn().mockResolvedValue(undefined)
      }),
      sleep: async () => undefined
    });
    await within(pausing, 'acknowledging the abortable pause');

    workerAbort.abort(new DOMException('Worker teardown', 'AbortError'));
    await within(running, 'aborting the acknowledged pause');

    expect(repository.claimNext).not.toHaveBeenCalled();
    expect(abortWorker).not.toHaveBeenCalled();
    expect(() => control.throwIfFailed()).not.toThrow();
  });

  it('holds a pause arriving during maintenance until exact release and acknowledges before claim', async () => {
    const fixture = await activeFixture();
    const workerAbort = new AbortController();
    const maintenanceEntered = deferred<void>();
    const releaseMaintenance = deferred<void>();
    const trace: string[] = [];
    const maintenance = vi.fn(async () => {
      trace.push('maintenance');
      maintenanceEntered.resolve();
      await releaseMaintenance.promise;
    });
    const repository = repositoryWithNoJobs(async () => {
      trace.push('claim');
      expect(await readFile(fixture.acknowledgementFile, 'utf8')).toBe(RELEASED_A);
      workerAbort.abort();
    });
    const control = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker: (reason) => workerAbort.abort(reason)
    });
    const harness = createTestWorkerControlHarness({
      environment: fixture.environment,
      randomBytes: randomBytesFor(NONCE_A)
    });
    const harnessSignal = new AbortController();
    const running = runWorker({
      repository,
      handlers: new Map(),
      workerId: 'test-maintenance-worker',
      concurrency: 1,
      pollIntervalMs: 1,
      leaseRenewalIntervalMs: 1,
      signal: workerAbort.signal,
      beforePoll: ({ signal }) => prepareTestWorkerPoll({
        control,
        signal,
        maintenance
      }),
      sleep: async () => workerAbort.abort()
    });

    await within(maintenanceEntered.promise, 'entering injected maintenance');
    const pausing = harness.pause(harnessSignal.signal);
    await waitForContents(fixture.requestFile, PAUSE_A);
    expect(repository.claimNext).not.toHaveBeenCalled();
    releaseMaintenance.resolve();
    const session = await within(pausing, 'pausing after maintenance arrival');
    expect(repository.claimNext).not.toHaveBeenCalled();

    const releasing = session.release({
      commandId: COMMAND_A,
      failCommand: false,
      signal: harnessSignal.signal
    });
    await within(
      Promise.all([running, releasing]).then(() => undefined),
      'releasing the maintenance-arrival barrier'
    );

    expect(repository.claimNext).toHaveBeenCalledOnce();
    expect(trace).toEqual(['maintenance', 'claim']);
    expect(() => control.throwIfFailed()).not.toThrow();
    await session.finish({
      signal: harnessSignal.signal,
      waitForTerminal: vi.fn().mockResolvedValue(undefined)
    });
  });

  it('completes a pause-arrival final barrier before propagating maintenance rejection', async () => {
    const fixture = await activeFixture();
    const workerAbort = new AbortController();
    const maintenanceEntered = deferred<void>();
    const continueMaintenance = deferred<void>();
    const maintenanceFailure = new Error('bounded maintenance failure');
    const maintenance = vi.fn(async () => {
      maintenanceEntered.resolve();
      await continueMaintenance.promise;
      throw maintenanceFailure;
    });
    const control = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker: (reason) => workerAbort.abort(reason)
    });
    const harness = createTestWorkerControlHarness({
      environment: fixture.environment,
      randomBytes: randomBytesFor(NONCE_A)
    });
    const harnessSignal = new AbortController();
    const polling = prepareTestWorkerPoll({
      control,
      signal: workerAbort.signal,
      maintenance
    }).then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error })
    );

    await within(maintenanceEntered.promise, 'entering rejecting maintenance');
    const pausing = harness.pause(harnessSignal.signal);
    await waitForContents(fixture.requestFile, PAUSE_A);
    continueMaintenance.resolve();
    const session = await within(
      pausing,
      'acknowledging the pause after maintenance rejection'
    );
    const releasing = session.release({
      commandId: COMMAND_A,
      failCommand: false,
      signal: harnessSignal.signal
    });
    const [pollResult] = await within(Promise.all([polling, releasing]),
      'finishing the rejected-maintenance release barrier');

    expect(pollResult.error).toBe(maintenanceFailure);
    expect(await readFile(fixture.acknowledgementFile, 'utf8')).toBe(RELEASED_A);
    expect(workerAbort.signal.aborted).toBe(false);
    expect(() => control.throwIfFailed()).not.toThrow();
    await session.finish({
      signal: harnessSignal.signal,
      waitForTerminal: vi.fn().mockResolvedValue(undefined)
    });
  });
});

describe('test worker command failure decoration and sequential cleanup', () => {
  it('accepts the isolated web environment and performs owned pre-submit release cleanup', async () => {
    const fixture = await activeFixture();
    const webEnvironment: NodeJS.ProcessEnv = {
      ...fixture.environment,
      DATABASE_USER: 'pale_orbit_test_web',
      DATABASE_PASSWORD: 'test-web-password',
      DATABASE_OWNER_USER: 'pale_orbit_test',
      DATABASE_OWNER_PASSWORD: 'test-owner-password',
      DATABASE_STORAGE_CLEANUP_USER: 'pale_orbit_test_storage_cleanup',
      DATABASE_STORAGE_CLEANUP_PASSWORD: 'test-storage-cleanup-password'
    };
    const inactiveFileSystem = inertFileSystem();
    const inactiveWorker = createTestWorkerControl({
      environment: webEnvironment,
      concurrency: 1,
      abortWorker: vi.fn(),
      fileSystem: inactiveFileSystem as unknown as TestWorkerControlFileSystem
    });
    expect(inactiveWorker.active).toBe(false);

    const observedWrites: unknown[] = [];
    const fileSystem = {
      ...nodeFileSystem,
      writeFile: vi.fn(async (
        path: string,
        data: string | Uint8Array,
        options?: unknown
      ) => {
        observedWrites.push(data);
        await Reflect.apply(writeFile, undefined, [path, data, options]);
      })
    } as unknown as TestWorkerControlFileSystem;
    const workerAbort = new AbortController();
    const activeWorker = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker: (reason) => workerAbort.abort(reason),
      fileSystem
    });
    const harness = createTestWorkerControlHarness({
      environment: webEnvironment,
      randomBytes: randomBytesFor(NONCE_A),
      fileSystem
    });
    const harnessSignal = new AbortController();
    const pausing = harness.pause(harnessSignal.signal);
    await waitForContents(fixture.requestFile, PAUSE_A);
    const polling = prepareTestWorkerPoll({
      control: activeWorker,
      signal: workerAbort.signal,
      maintenance: vi.fn().mockResolvedValue(undefined)
    });
    const session = await within(pausing, 'pausing from the isolated web environment');

    await within(
      Promise.all([
        polling,
        session.cleanup(harnessSignal.signal)
      ]).then(() => undefined),
      'releasing an owned pre-submit pause during cleanup'
    );

    const serializedWrites = observedWrites.map((value) =>
      typeof value === 'string'
        ? value
        : Buffer.from(value as Uint8Array).toString('utf8')
    );
    expect(serializedWrites).toContain(RELEASE_A);
    expect(serializedWrites).not.toContain(RELEASE_A_WITH_FAILURE);
    expect(workerAbort.signal.aborted).toBe(false);
    expect(() => activeWorker.throwIfFailed()).not.toThrow();
    expect(inactiveFileSystem.lstat).not.toHaveBeenCalled();
    expect(inactiveFileSystem.realpath).not.toHaveBeenCalled();
    expect(inactiveFileSystem.readFile).not.toHaveBeenCalled();
    expect(inactiveFileSystem.writeFile).not.toHaveBeenCalled();
    expect(inactiveFileSystem.rename).not.toHaveBeenCalled();
    expect(inactiveFileSystem.unlink).not.toHaveBeenCalled();
    await expect(readFile(fixture.requestFile, 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(fixture.acknowledgementFile, 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves unrelated executions and consumes a matching failure exactly once', async () => {
    const fixture = await activeFixture();
    const workerAbort = new AbortController();
    const control = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker: (reason) => workerAbort.abort(reason)
    });
    const harness = createTestWorkerControlHarness({
      environment: fixture.environment,
      randomBytes: randomBytesFor(NONCE_A)
    });
    const executor = vi.fn<FinancialAdminCommandExecutor>()
      .mockResolvedValue({} as never);
    const executors = new Map<FinancialAdminCommandKind, FinancialAdminCommandExecutor>(
      FINANCIAL_ADMIN_COMMAND_KINDS.map((kind) => [kind, executor])
    );
    const decorated = control.decorateFinancialAdminExecutors(executors);
    const selected = decorated.get(FINANCIAL_ADMIN_COMMAND_KINDS[0]);
    if (!selected) throw new Error('Expected a decorated executor');
    const released = await releasedSession({
      fixture,
      control,
      harness,
      commandId: COMMAND_A,
      failCommand: true
    });
    const signal = new AbortController().signal;
    const command = { kind: FINANCIAL_ADMIN_COMMAND_KINDS[0] } as never;

    await expect(selected({ commandId: COMMAND_B, signal } as never, command))
      .resolves.toEqual({});
    expect(executor).toHaveBeenCalledOnce();

    await expect(selected({ commandId: COMMAND_A, signal } as never, command))
      .rejects.toMatchObject({
        name: 'FinancialAdminPermanentError',
        safeCode: 'command_failed'
      });
    expect(executor).toHaveBeenCalledOnce();

    await expect(selected({ commandId: COMMAND_A, signal } as never, command))
      .resolves.toEqual({});
    expect(executor).toHaveBeenCalledTimes(2);
    try {
      await control.decorateFinancialAdminExecutors(executors)
        .get(FINANCIAL_ADMIN_COMMAND_KINDS[0])?.(
          { commandId: COMMAND_B, signal } as never,
          command
        );
    } catch (error: unknown) {
      expect(error).not.toBeInstanceOf(FinancialAdminPermanentError);
      throw error;
    }
    await released.session.finish({
      signal: released.signal.signal,
      waitForTerminal: vi.fn().mockResolvedValue(undefined)
    });
  });

  it('permits a fresh nonce only after terminal completion and nonce-owned cleanup', async () => {
    const fixture = await activeFixture();
    const workerAbort = new AbortController();
    const control = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker: (reason) => workerAbort.abort(reason)
    });
    const nonces = [NONCE_A, NONCE_B];
    const randomBytes = vi.fn((size: number) => {
      expect(size).toBe(16);
      const nonce = nonces.shift();
      if (!nonce) throw new Error('Unexpected third nonce');
      return Uint8Array.from(Buffer.from(nonce, 'hex'));
    });
    const harness = createTestWorkerControlHarness({
      environment: fixture.environment,
      randomBytes
    });
    const first = await releasedSession({ fixture, control, harness });
    const terminal = deferred<void>();
    const waitForTerminal = vi.fn((
      commandId: string,
      signal: AbortSignal
    ) => {
      expect(commandId).toBe(COMMAND_A);
      expect(signal).toBe(first.signal.signal);
      return terminal.promise;
    });
    const finishing = first.session.finish({
      signal: first.signal.signal,
      waitForTerminal
    });

    await expect(harness.pause(new AbortController().signal))
      .rejects.toThrow(/active|terminal|cleanup|sequence/i);
    expect(randomBytes).toHaveBeenCalledOnce();
    expect(await readFile(fixture.requestFile, 'utf8')).toBe(RELEASE_A);
    expect(await readFile(fixture.acknowledgementFile, 'utf8')).toBe(RELEASED_A);

    terminal.resolve();
    await within(finishing, 'waiting for terminal state and cleanup');
    expect(waitForTerminal).toHaveBeenCalledOnce();
    expect(waitForTerminal).toHaveBeenCalledWith(COMMAND_A, first.signal.signal);
    await expect(readFile(fixture.requestFile, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    });
    await expect(readFile(fixture.acknowledgementFile, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    });

    const secondSignal = new AbortController();
    const secondPause = harness.pause(secondSignal.signal);
    const pauseB = encodeTestWorkerControlRequest({
      version: 1,
      nonce: NONCE_B,
      phase: 'pause'
    });
    await waitForContents(fixture.requestFile, pauseB);
    const secondPoll = prepareTestWorkerPoll({
      control,
      signal: workerAbort.signal,
      maintenance: vi.fn().mockResolvedValue(undefined)
    });
    const second = await within(secondPause, 'receiving the second paused acknowledgement');
    expect(second.nonce).toBe(NONCE_B);

    await first.session.cleanup(first.signal.signal);
    expect(await readFile(fixture.requestFile, 'utf8')).toBe(pauseB);
    expect(decodeTestWorkerControlAcknowledgement(
      await readFile(fixture.acknowledgementFile, 'utf8')
    )).toEqual({ version: 1, nonce: NONCE_B, phase: 'paused' });

    const secondRelease = second.release({
      commandId: COMMAND_B,
      failCommand: false,
      signal: secondSignal.signal
    });
    await within(
      Promise.all([secondPoll, secondRelease]).then(() => undefined),
      'releasing the second nonce'
    );
    await second.finish({
      signal: secondSignal.signal,
      waitForTerminal: vi.fn().mockResolvedValue(undefined)
    });
    expect(randomBytes).toHaveBeenCalledTimes(2);
  });

  it('clears an unconsumed completed failure arm before accepting a fresh nonce', async () => {
    const fixture = await activeFixture();
    const workerAbort = new AbortController();
    const control = createTestWorkerControl({
      environment: fixture.environment,
      concurrency: 1,
      abortWorker: (reason) => workerAbort.abort(reason)
    });
    const nonces = [NONCE_A, NONCE_B];
    const harness = createTestWorkerControlHarness({
      environment: fixture.environment,
      randomBytes: vi.fn(() => {
        const nonce = nonces.shift();
        if (!nonce) throw new Error('Unexpected third nonce');
        return Uint8Array.from(Buffer.from(nonce, 'hex'));
      })
    });
    const executor = vi.fn<FinancialAdminCommandExecutor>()
      .mockResolvedValue({} as never);
    const decorated = control.decorateFinancialAdminExecutors(new Map([
      [FINANCIAL_ADMIN_COMMAND_KINDS[0], executor]
    ]));
    const selected = decorated.get(FINANCIAL_ADMIN_COMMAND_KINDS[0]);
    if (!selected) throw new Error('Expected a decorated executor');

    const first = await releasedSession({
      fixture,
      control,
      harness,
      commandId: COMMAND_A,
      failCommand: true
    });
    await first.session.finish({
      signal: first.signal.signal,
      waitForTerminal: vi.fn().mockResolvedValue(undefined)
    });

    const secondSignal = new AbortController();
    const secondPause = harness.pause(secondSignal.signal);
    await waitForContents(fixture.requestFile, encodeTestWorkerControlRequest({
      version: 1,
      nonce: NONCE_B,
      phase: 'pause'
    }));
    const secondPoll = prepareTestWorkerPoll({
      control,
      signal: workerAbort.signal,
      maintenance: vi.fn().mockResolvedValue(undefined)
    });
    const second = await within(secondPause, 'acknowledging the fresh nonce');
    const secondRelease = second.release({
      commandId: COMMAND_B,
      failCommand: true,
      signal: secondSignal.signal
    });
    await within(
      Promise.all([secondPoll, secondRelease]).then(() => undefined),
      'arming the fresh nonce after prior terminal cleanup'
    );

    const signal = new AbortController().signal;
    const command = { kind: FINANCIAL_ADMIN_COMMAND_KINDS[0] } as never;
    await expect(selected({ commandId: COMMAND_A, signal } as never, command))
      .resolves.toEqual({});
    await expect(selected({ commandId: COMMAND_B, signal } as never, command))
      .rejects.toMatchObject({
        name: 'FinancialAdminPermanentError',
        safeCode: 'command_failed'
      });
    expect(workerAbort.signal.aborted).toBe(false);
    expect(() => control.throwIfFailed()).not.toThrow();
    await second.finish({
      signal: secondSignal.signal,
      waitForTerminal: vi.fn().mockResolvedValue(undefined)
    });
  });

  it('does not let an older cleanup unlink newer nonce-owned files', async () => {
    const fixture = await activeFixture();
    const harness = createTestWorkerControlHarness({
      environment: fixture.environment,
      randomBytes: randomBytesFor(NONCE_A)
    });
    const signal = new AbortController();
    const pausing = harness.pause(signal.signal);
    await waitForContents(fixture.requestFile, PAUSE_A);
    await writeFile(fixture.acknowledgementFile, PAUSED_A, 'utf8');
    const session = await within(pausing, 'constructing an owned cleanup session');
    const requestB = encodeTestWorkerControlRequest({
      version: 1,
      nonce: NONCE_B,
      phase: 'pause'
    });
    const acknowledgementB = encodeTestWorkerControlAcknowledgement({
      version: 1,
      nonce: NONCE_B,
      phase: 'paused'
    });
    await writeFile(fixture.requestFile, requestB, 'utf8');
    await writeFile(fixture.acknowledgementFile, acknowledgementB, 'utf8');

    await session.cleanup(signal.signal);

    expect(await readFile(fixture.requestFile, 'utf8')).toBe(requestB);
    expect(await readFile(fixture.acknowledgementFile, 'utf8')).toBe(acknowledgementB);
  });
});
