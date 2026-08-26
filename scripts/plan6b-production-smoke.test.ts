import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertLoopbackPortAvailable,
  executeProductionSmoke,
  createProductionSmokeManifest,
  createProductionSmokeCommandRuntime,
  createProductionSmokeDockerOperations as createProductionSmokeDockerOperationsWithClock,
  createProductionSmokePortOperations,
  parsePlan6bSmokeStage,
  renderProductionSmokeOverride,
  runProductionSmoke,
  validateProductionSmokeManifest,
  validateVerifiedProductionImageLease,
  type DisabledRuntimeEvidence,
  type ProductionSmokeRunDependencies,
  type ProductionSmokeManifest,
  type ProductionSmokeOperations,
  type ProductionSmokeCommandRuntime,
  type ProductionSmokeCommandResult,
  type ProductionSmokeDockerDependencies,
  type ProductionSmokePortOperations,
  type ProductionSmokePortRuntime,
  type VerifiedProductionImageLease
} from './plan6b-production-smoke';

const DETERMINISTIC_SMOKE_NOW = '2026-08-26T12:00:00.000Z';

function createProductionSmokeDockerOperations(
  owned: ProductionSmokeManifest,
  dependencies: Omit<ProductionSmokeDockerDependencies, 'now'> & {
    readonly now?: () => Date;
  }
): ProductionSmokeOperations {
  return createProductionSmokeDockerOperationsWithClock(owned, {
    ...dependencies,
    now: dependencies.now ?? (() => new Date(DETERMINISTIC_SMOKE_NOW))
  });
}

type TcpConnectionHandler = (socket: { destroy(): void }) => void;
type TcpServerFactory = (handler: TcpConnectionHandler | undefined) => unknown;
type UdpSocketFactory = (options: unknown) => unknown;

const socketAdapterTraps = vi.hoisted(() => {
  const state = {
    tcpFactory: undefined as TcpServerFactory | undefined,
    udpFactory: undefined as UdpSocketFactory | undefined,
    expectedTcpCalls: 0,
    expectedUdpCalls: 0,
    unexpectedCalls: [] as string[]
  };
  return {
    state,
    createServer: vi.fn((handler?: TcpConnectionHandler) => {
      if (!state.tcpFactory) {
        state.unexpectedCalls.push('node:net.createServer');
        throw new Error('unexpected default TCP socket adapter use');
      }
      return state.tcpFactory(handler);
    }),
    createSocket: vi.fn((options: unknown) => {
      if (!state.udpFactory) {
        state.unexpectedCalls.push('node:dgram.createSocket');
        throw new Error('unexpected default UDP socket adapter use');
      }
      return state.udpFactory(options);
    })
  };
});

const commandAdapterTraps = vi.hoisted(() => ({
  spawnSync: vi.fn()
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawnSync = commandAdapterTraps.spawnSync as unknown as typeof actual.spawnSync;
  return { ...actual, spawnSync };
});

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>();
  const createServer = socketAdapterTraps.createServer as unknown as typeof actual.createServer;
  return {
    ...actual,
    createServer,
    default: { ...actual.default, createServer }
  };
});

vi.mock('node:dgram', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dgram')>();
  const createSocket = socketAdapterTraps.createSocket as unknown as typeof actual.createSocket;
  return {
    ...actual,
    createSocket,
    default: { ...actual.default, createSocket }
  };
});

beforeEach(() => {
  socketAdapterTraps.state.tcpFactory = undefined;
  socketAdapterTraps.state.udpFactory = undefined;
  socketAdapterTraps.state.expectedTcpCalls = 0;
  socketAdapterTraps.state.expectedUdpCalls = 0;
  socketAdapterTraps.state.unexpectedCalls.length = 0;
  socketAdapterTraps.createServer.mockClear();
  socketAdapterTraps.createSocket.mockClear();
  commandAdapterTraps.spawnSync.mockReset();
});

afterEach(() => {
  expect(socketAdapterTraps.state.unexpectedCalls).toEqual([]);
  expect(socketAdapterTraps.createServer).toHaveBeenCalledTimes(
    socketAdapterTraps.state.expectedTcpCalls
  );
  expect(socketAdapterTraps.createSocket).toHaveBeenCalledTimes(
    socketAdapterTraps.state.expectedUdpCalls
  );
});

type FakePortLeaseOutcome = number | 'conflict';

interface FakePortRuntimeOptions {
  readonly randomPorts?: readonly number[];
  readonly tcpOutcomes: readonly FakePortLeaseOutcome[];
  readonly udpOutcomes?: readonly FakePortLeaseOutcome[];
  readonly closeFailures?: readonly string[];
}

function createFakePortRuntime(options: FakePortRuntimeOptions): {
  readonly operations: ProductionSmokePortOperations;
  readonly runtime: ProductionSmokePortRuntime;
  readonly trace: string[];
} {
  const randomPorts = [...(options.randomPorts ?? [])];
  const tcpOutcomes = [...options.tcpOutcomes];
  const udpOutcomes = [...(options.udpOutcomes ?? [])];
  const closeFailures = new Set(options.closeFailures ?? []);
  const trace: string[] = [];

  const lease = async (
    protocol: 'tcp' | 'udp',
    requestedPort: number,
    outcomes: FakePortLeaseOutcome[]
  ) => {
    const outcome = outcomes.shift();
    if (outcome === undefined) throw new Error(`unexpected ${protocol} lease`);
    if (outcome === 'conflict') {
      trace.push(`${protocol}:conflict:${requestedPort}`);
      throw new Error(`${protocol} conflict`);
    }
    trace.push(`${protocol}:open:${requestedPort}:${outcome}`);
    return {
      port: outcome,
      async close() {
        trace.push(`${protocol}:close:${outcome}`);
        if (closeFailures.has(`${protocol}:${outcome}`)) {
          throw new Error(`${protocol} close failure`);
        }
      }
    };
  };

  const runtime: ProductionSmokePortRuntime = {
    randomInteger: vi.fn((minimum, maximumExclusive) => {
      const port = randomPorts.shift();
      if (port === undefined) throw new Error('unexpected random port request');
      trace.push(`random:${minimum}:${maximumExclusive}:${port}`);
      return port;
    }),
    leaseTcpLoopback: vi.fn((port) => lease('tcp', port, tcpOutcomes)),
    leaseUdpLoopback: vi.fn((port) => lease('udp', port, udpOutcomes))
  };
  return {
    operations: createProductionSmokePortOperations(runtime),
    runtime,
    trace
  };
}

function deterministicPortOperations(): ProductionSmokePortOperations {
  return createFakePortRuntime({
    randomPorts: [49_153],
    tcpOutcomes: [49_152, 49_153],
    udpOutcomes: [49_153]
  }).operations;
}

interface AllocationCase {
  readonly name: string;
  readonly options: FakePortRuntimeOptions;
  readonly requireUdp: boolean;
  readonly excludedPort?: number;
  readonly expectedPort?: number;
  readonly expectedError?: string;
  readonly trace: readonly string[];
}

const allocationCases = [
  {
    name: 'leases TCP only for HTTP success',
    options: { tcpOutcomes: [49_152] },
    requireUdp: false,
    expectedPort: 49_152,
    trace: ['tcp:open:0:49152', 'tcp:close:49152']
  },
  {
    name: 'leases distinct TCP and UDP identities for HTTPS success',
    options: {
      randomPorts: [49_152, 49_153],
      tcpOutcomes: [49_153],
      udpOutcomes: [49_153]
    },
    requireUdp: true,
    excludedPort: 49_152,
    expectedPort: 49_153,
    trace: [
      'random:49152:65536:49152',
      'random:49152:65536:49153',
      'tcp:open:49153:49153',
      'udp:open:49153:49153',
      'udp:close:49153',
      'tcp:close:49153'
    ]
  },
  {
    name: 'retries after partial TCP acquisition',
    options: {
      randomPorts: [50_001, 50_002],
      tcpOutcomes: ['conflict', 50_002],
      udpOutcomes: [50_002]
    },
    requireUdp: true,
    expectedPort: 50_002,
    trace: [
      'random:49152:65536:50001',
      'tcp:conflict:50001',
      'random:49152:65536:50002',
      'tcp:open:50002:50002',
      'udp:open:50002:50002',
      'udp:close:50002',
      'tcp:close:50002'
    ]
  },
  {
    name: 'retries after partial UDP acquisition and closes TCP',
    options: {
      randomPorts: [50_003, 50_004],
      tcpOutcomes: [50_003, 50_004],
      udpOutcomes: ['conflict', 50_004]
    },
    requireUdp: true,
    expectedPort: 50_004,
    trace: [
      'random:49152:65536:50003',
      'tcp:open:50003:50003',
      'udp:conflict:50003',
      'tcp:close:50003',
      'random:49152:65536:50004',
      'tcp:open:50004:50004',
      'udp:open:50004:50004',
      'udp:close:50004',
      'tcp:close:50004'
    ]
  },
  {
    name: 'retries a nonzero TCP lease with a mismatched identity',
    options: {
      randomPorts: [50_005, 50_006],
      tcpOutcomes: [50_007, 50_006],
      udpOutcomes: [50_006]
    },
    requireUdp: true,
    expectedPort: 50_006,
    trace: [
      'random:49152:65536:50005',
      'tcp:open:50005:50007',
      'tcp:close:50007',
      'random:49152:65536:50006',
      'tcp:open:50006:50006',
      'udp:open:50006:50006',
      'udp:close:50006',
      'tcp:close:50006'
    ]
  },
  {
    name: 'retries a UDP lease with a mismatched TCP identity',
    options: {
      randomPorts: [50_008, 50_009],
      tcpOutcomes: [50_008, 50_009],
      udpOutcomes: [50_010, 50_009]
    },
    requireUdp: true,
    expectedPort: 50_009,
    trace: [
      'random:49152:65536:50008',
      'tcp:open:50008:50008',
      'udp:open:50008:50010',
      'udp:close:50010',
      'tcp:close:50008',
      'random:49152:65536:50009',
      'tcp:open:50009:50009',
      'udp:open:50009:50009',
      'udp:close:50009',
      'tcp:close:50009'
    ]
  },
  {
    name: 'retries an unsafe TCP lease identity',
    options: {
      randomPorts: [50_011, 50_012],
      tcpOutcomes: [80, 50_012],
      udpOutcomes: [50_012]
    },
    requireUdp: true,
    expectedPort: 50_012,
    trace: [
      'random:49152:65536:50011',
      'tcp:open:50011:80',
      'tcp:close:80',
      'random:49152:65536:50012',
      'tcp:open:50012:50012',
      'udp:open:50012:50012',
      'udp:close:50012',
      'tcp:close:50012'
    ]
  },
  {
    name: 'fails closed on TCP cleanup failure',
    options: { tcpOutcomes: [52_000], closeFailures: ['tcp:52000'] },
    requireUdp: false,
    expectedError: '[plan6b-smoke] loopback TCP socket cleanup failed',
    trace: ['tcp:open:0:52000', 'tcp:close:52000']
  },
  {
    name: 'fails closed on UDP cleanup failure and still closes TCP',
    options: {
      randomPorts: [52_001],
      tcpOutcomes: [52_001],
      udpOutcomes: [52_001],
      closeFailures: ['udp:52001']
    },
    requireUdp: true,
    expectedError: '[plan6b-smoke] loopback UDP socket cleanup failed',
    trace: [
      'random:49152:65536:52001',
      'tcp:open:52001:52001',
      'udp:open:52001:52001',
      'udp:close:52001',
      'tcp:close:52001'
    ]
  }
] satisfies readonly AllocationCase[];

interface ProbeCase {
  readonly name: string;
  readonly port: number;
  readonly requireUdp: boolean;
  readonly options: FakePortRuntimeOptions;
  readonly expectedError?: string;
  readonly trace: readonly string[];
}

const unavailablePortError = '[plan6b-smoke] reserved loopback port is no longer available';
const probeCleanupError = '[plan6b-smoke] loopback port check failed';
const probeCases = [
  {
    name: 'accepts an exact TCP-only lease',
    port: 51_000,
    requireUdp: false,
    options: { tcpOutcomes: [51_000] },
    trace: ['tcp:open:51000:51000', 'tcp:close:51000']
  },
  {
    name: 'accepts exact TCP and UDP leases',
    port: 51_001,
    requireUdp: true,
    options: { tcpOutcomes: [51_001], udpOutcomes: [51_001] },
    trace: [
      'tcp:open:51001:51001',
      'udp:open:51001:51001',
      'udp:close:51001',
      'tcp:close:51001'
    ]
  },
  {
    name: 'rejects partial TCP acquisition',
    port: 51_002,
    requireUdp: false,
    options: { tcpOutcomes: ['conflict'] },
    expectedError: unavailablePortError,
    trace: ['tcp:conflict:51002']
  },
  {
    name: 'rejects partial UDP acquisition and closes TCP',
    port: 51_003,
    requireUdp: true,
    options: { tcpOutcomes: [51_003], udpOutcomes: ['conflict'] },
    expectedError: unavailablePortError,
    trace: ['tcp:open:51003:51003', 'udp:conflict:51003', 'tcp:close:51003']
  },
  {
    name: 'rejects an unsafe TCP lease identity',
    port: 51_004,
    requireUdp: false,
    options: { tcpOutcomes: [80] },
    expectedError: unavailablePortError,
    trace: ['tcp:open:51004:80', 'tcp:close:80']
  },
  {
    name: 'rejects a mismatched TCP lease identity',
    port: 51_005,
    requireUdp: false,
    options: { tcpOutcomes: [51_006] },
    expectedError: unavailablePortError,
    trace: ['tcp:open:51005:51006', 'tcp:close:51006']
  },
  {
    name: 'rejects an unsafe UDP lease identity and closes both leases',
    port: 51_007,
    requireUdp: true,
    options: { tcpOutcomes: [51_007], udpOutcomes: [80] },
    expectedError: unavailablePortError,
    trace: [
      'tcp:open:51007:51007',
      'udp:open:51007:80',
      'udp:close:80',
      'tcp:close:51007'
    ]
  },
  {
    name: 'rejects a mismatched UDP lease identity and closes both leases',
    port: 51_008,
    requireUdp: true,
    options: { tcpOutcomes: [51_008], udpOutcomes: [51_009] },
    expectedError: unavailablePortError,
    trace: [
      'tcp:open:51008:51008',
      'udp:open:51008:51009',
      'udp:close:51009',
      'tcp:close:51008'
    ]
  },
  {
    name: 'fails closed on TCP probe cleanup failure',
    port: 51_010,
    requireUdp: false,
    options: { tcpOutcomes: [51_010], closeFailures: ['tcp:51010'] },
    expectedError: probeCleanupError,
    trace: ['tcp:open:51010:51010', 'tcp:close:51010']
  },
  {
    name: 'fails closed on UDP probe cleanup failure and still closes TCP',
    port: 51_011,
    requireUdp: true,
    options: {
      tcpOutcomes: [51_011],
      udpOutcomes: [51_011],
      closeFailures: ['udp:51011']
    },
    expectedError: probeCleanupError,
    trace: [
      'tcp:open:51011:51011',
      'udp:open:51011:51011',
      'udp:close:51011',
      'tcp:close:51011'
    ]
  }
] satisfies readonly ProbeCase[];

function manifest(): ProductionSmokeManifest {
  const runId = '0123456789abcdef';
  const tempDirectory = join(tmpdir(), `pale-orbit-plan6b-6b-ii-smoke-${runId}`);
  return {
    version: 2,
    stage: '6b-ii',
    runId,
    ownershipToken: 'f'.repeat(32),
    project: `pale-orbit-plan6b-6b-ii-smoke-${runId}`,
    imageTag: `pale-orbit:plan6b-6b-ii-smoke-${runId}`,
    tempDirectory,
    overrideFile: join(tempDirectory, 'compose.override.yaml'),
    manifestFile: join(tempDirectory, 'owned-run.json'),
    secretDirectory: join(tempDirectory, 'secrets'),
    httpHost: '127.0.0.1',
    httpsHost: '127.0.0.1',
    httpPort: 49152,
    httpsPort: 49153
  };
}

const safeRuntime = (): DisabledRuntimeEvidence => ({
  storefrontStatus: 503,
  commerceStatus: 503,
  appStripeEnabled: false,
  workerStripeEnabled: false,
  appDatabaseRoleIsWeb: true,
  workerDatabaseRoleIsWorker: true,
  appFixtureMode: false,
  workerFixtureMode: false,
  appHasStripeSecret: false,
  workerHasStripeSecret: false,
  postgresHostPublished: false,
  workerReady: true,
  providerBackedJobCount: 0,
  classificationRootCount: 1,
  classificationRootCompletedCount: 1,
  classificationRootUnsafeCount: 0,
  classificationContinuationCount: 1,
  classificationContinuationCompletedCount: 1,
  classificationContinuationUnsafeCount: 0,
  classificationRunCount: 1,
  classificationRunCompletedCount: 1,
  pendingProjectionVersionCount: 0,
  activeClassifierVersion: 1,
  activeAllocationAlgorithmVersion: 2,
  providerLedgerSubjectCount: 0
});

type CapturedCommandResult = ProductionSmokeCommandResult & {
  readonly stderr?: string;
};

function runtimeInspectionCommand(
  workerHealthRehearsal: (readyFileOverride: string) => CapturedCommandResult
): ProductionSmokeCommandRuntime {
  const appId = 'a'.repeat(64);
  const workerId = 'b'.repeat(64);
  const postgresId = 'c'.repeat(64);
  return {
    run: vi.fn(async () => undefined),
    capture: vi.fn(async (args) => {
      if (args.includes('ps') && args.includes('--quiet')) {
        const service = args.at(-1);
        return {
          status: 0,
          stdout: `${service === 'app' ? appId : service === 'worker' ? workerId : postgresId}\n`
        };
      }
      if (args[0] === 'inspect' && args.includes('{{json .Config.Env}}')) {
        return {
          status: 0,
          stdout: args.at(-1) === workerId
            ? JSON.stringify([
                'WORKER_CONCURRENCY=1',
                'WORKER_HEARTBEAT_MAX_AGE_MS=20000'
              ])
            : '[]'
        };
      }
      if (args[0] === 'inspect' && args.includes('{{json .Mounts}}')) {
        return { status: 0, stdout: '[]' };
      }
      if (args[0] === 'port') return { status: 0, stdout: '' };
      if (args.includes('build/services/worker-health.js')) {
        const overrideIndex = args.indexOf('--env');
        return overrideIndex === -1
          ? { status: 0, stdout: '' }
          : workerHealthRehearsal(String(args[overrideIndex + 1]));
      }
      if (args.includes('psql')) {
        return { status: 0, stdout: JSON.stringify(safeRuntime()) };
      }
      return { status: 0, stdout: '' };
    })
  };
}

const migrationState = (
  overrides: Partial<Record<
    | 'migrationCount'
    | 'migrationMax'
    | 'credentialAuthorityCount'
    | 'entitlementGrantCount'
    | 'refundComponentCount'
    | 'financialIssueCount'
    | 'projectionVersionCount'
    | 'activeClassifierVersion'
    | 'activeAllocationAlgorithmVersion',
    number
  >> = {}
): string => JSON.stringify({
  migrationCount: 7,
  migrationMax: 7,
  credentialAuthorityCount: 0,
  entitlementGrantCount: 0,
  refundComponentCount: 0,
  financialIssueCount: 0,
  projectionVersionCount: 1,
  activeClassifierVersion: 1,
  activeAllocationAlgorithmVersion: 1,
  ...overrides
});

function operations(trace: string[], failAt: string | null = null): ProductionSmokeOperations {
  const step = async <Value>(name: string, value: Value): Promise<Value> => {
    trace.push(name);
    if (failAt === name) throw new Error(`private-${name}-failure`);
    return value;
  };
  return {
    build: vi.fn(() => step('build', undefined)),
    revalidatePorts: vi.fn(() => step('ports', undefined)),
    startDatabase: vi.fn(() => step('database', undefined)),
    migrate: vi.fn(() => step('migrate', undefined)),
    snapshotMigrationState: vi.fn(() => step('snapshot', migrationState())),
    startRuntime: vi.fn(() => step('runtime', undefined)),
    inspectDisabledRuntime: vi.fn(() => step('inspect-runtime', safeRuntime())),
    inspectImage: vi.fn(() => step('inspect-image', {
      digest: `sha256:${'a'.repeat(64)}`, sizeBytes: 42
    })),
    cleanup: vi.fn(() => step('cleanup', undefined))
  };
}

describe('Plan 6B production smoke ownership', () => {
  it('requires exactly one explicit supported Plan 6B stage', () => {
    expect(parsePlan6bSmokeStage(['--stage', '6b-ii'])).toBe('6b-ii');
    for (const argumentsToReject of [
      [],
      ['--stage'],
      ['--stage', '6b-i'],
      ['--stage', '6b-iii'],
      ['--stage=6b-ii'],
      ['--stage', '6b-ii', '--stage', '6b-ii'],
      ['--stage', '6b-ii', 'unexpected']
    ]) {
      expect(() => parsePlan6bSmokeStage(argumentsToReject)).toThrow(
        '[plan6b-smoke] stage arguments are invalid'
      );
    }
  });

  it('publishes only the two explicit Plan 6B smoke entry points', async () => {
    const packageManifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8')
    ) as { scripts?: Record<string, string> };
    expect(packageManifest.scripts).toMatchObject({
      'smoke:plan6b': 'node --import tsx scripts/plan6b-production-smoke.ts',
      'smoke:plan6b-fixture': 'node --import tsx scripts/plan6b-fixture-runtime-probe.ts'
    });
    expect(Object.keys(packageManifest.scripts ?? {})
      .filter((key) => key.startsWith('smoke:plan6b'))
      .sort()).toEqual(['smoke:plan6b', 'smoke:plan6b-fixture']);
    expect(Object.hasOwn(packageManifest.scripts ?? {}, 'smoke:plan6b-i')).toBe(false);
  });

  it('accepts only the exact owned project, tag, paths, loopback hosts, and ephemeral ports', () => {
    expect(() => validateProductionSmokeManifest(manifest())).not.toThrow();
    for (const mutate of [
      (value: ProductionSmokeManifest) => ({ ...value, project: 'default' }),
      (value: ProductionSmokeManifest) => ({ ...value, imageTag: 'pale-orbit:latest' }),
      (value: ProductionSmokeManifest) => ({ ...value, stage: '6b-i' as '6b-ii' }),
      (value: ProductionSmokeManifest) => ({ ...value, version: 1 as 2 }),
      (value: ProductionSmokeManifest) => ({ ...value, tempDirectory: tmpdir() }),
      (value: ProductionSmokeManifest) => ({ ...value, overrideFile: join(tmpdir(), 'foreign.yaml') }),
      (value: ProductionSmokeManifest) => ({ ...value, httpHost: '0.0.0.0' as '127.0.0.1' }),
      (value: ProductionSmokeManifest) => ({ ...value, httpPort: 80 }),
      (value: ProductionSmokeManifest) => ({ ...value, httpsPort: value.httpPort })
    ]) expect(() => validateProductionSmokeManifest(mutate(manifest()))).toThrow();
  });

  it('destroys accepted TCP connections through the trapped default adapter', async () => {
    let connectionHandler: TcpConnectionHandler | undefined;
    const server = {
      once: vi.fn(() => server),
      listen: vi.fn((_options: unknown, listening: () => void) => {
        listening();
        return server;
      }),
      removeListener: vi.fn(() => server),
      address: vi.fn(() => ({ address: '127.0.0.1', family: 'IPv4', port: 51_500 })),
      close: vi.fn((closed: (error?: Error) => void) => {
        closed();
        return server;
      })
    };
    socketAdapterTraps.state.tcpFactory = (handler) => {
      connectionHandler = handler;
      return server;
    };
    socketAdapterTraps.state.expectedTcpCalls = 1;

    await expect(
      assertLoopbackPortAvailable('127.0.0.1', 51_500)
    ).resolves.toBeUndefined();
    expect(socketAdapterTraps.createSocket).not.toHaveBeenCalled();
    expect(connectionHandler).toBeTypeOf('function');

    const acceptedSocket = { destroy: vi.fn() };
    connectionHandler?.(acceptedSocket);
    expect(acceptedSocket.destroy).toHaveBeenCalledOnce();
  });

  it.each(allocationCases)('$name', async ({
    options, requireUdp, excludedPort, expectedPort, expectedError, trace
  }) => {
    const fake = createFakePortRuntime(options);
    const allocation = fake.operations.allocateLoopbackPort(requireUdp, excludedPort);

    if (expectedError) {
      await expect(allocation).rejects.toThrow(expectedError);
    } else {
      await expect(allocation).resolves.toBe(expectedPort);
    }
    expect(fake.trace).toEqual(trace);
  });

  it.each(probeCases)('$name', async ({
    port, requireUdp, options, expectedError, trace
  }) => {
    const fake = createFakePortRuntime(options);
    const probe = fake.operations.probeLoopbackPort('127.0.0.1', port, requireUdp);

    if (expectedError) {
      await expect(probe).rejects.toThrow(expectedError);
    } else {
      await expect(probe).resolves.toBeUndefined();
    }
    expect(fake.trace).toEqual(trace);
  });

  it('bounds randomized TCP and UDP allocation attempts', async () => {
    const fake = createFakePortRuntime({
      randomPorts: Array.from({ length: 32 }, (_, index) => 53_000 + index),
      tcpOutcomes: Array.from({ length: 32 }, () => 'conflict' as const)
    });

    await expect(fake.operations.allocateLoopbackPort(true)).rejects.toThrow(
      '[plan6b-smoke] failed to reserve an ephemeral TCP and UDP loopback port'
    );
    expect(fake.runtime.randomInteger).toHaveBeenCalledTimes(32);
    expect(fake.runtime.leaseTcpLoopback).toHaveBeenCalledTimes(32);
    expect(fake.runtime.leaseUdpLoopback).not.toHaveBeenCalled();
  });

  it('revalidates HTTP over TCP and HTTPS over both TCP and UDP in order', async () => {
    const owned = manifest();
    const assertPortAvailable = vi.fn(async () => undefined);
    const docker = createProductionSmokeDockerOperations(owned, {
      command: {
        run: vi.fn(async () => undefined),
        capture: vi.fn(async () => ({ status: 0, stdout: '' }))
      },
      environment: { PATH: 'safe-path' },
      assertPortAvailable,
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    await docker.revalidatePorts(owned);

    expect(assertPortAvailable.mock.calls).toEqual([
      [owned.httpHost, owned.httpPort, false],
      [owned.httpsHost, owned.httpsPort, true]
    ]);
  });

  it('allocates manifest HTTP over TCP and HTTPS over both TCP and UDP', async () => {
    const fake = createFakePortRuntime({
      randomPorts: [54_001],
      tcpOutcomes: [54_000, 54_001],
      udpOutcomes: [54_001]
    });
    const owned = await createProductionSmokeManifest('6b-ii', fake.operations);
    try {
      expect({ httpPort: owned.httpPort, httpsPort: owned.httpsPort }).toEqual({
        httpPort: 54_000,
        httpsPort: 54_001
      });
      expect(fake.runtime.leaseUdpLoopback).toHaveBeenCalledExactlyOnceWith(54_001);
    } finally {
      await rm(owned.tempDirectory, { recursive: true, force: true });
    }
  });

  it('renders only loopback host publication with the exact unique image and ownership labels', () => {
    const source = renderProductionSmokeOverride(manifest());
    expect(source).toContain('127.0.0.1:49152:80');
    expect(source).toContain('127.0.0.1:49153:443');
    expect(source).toContain('127.0.0.1:49153:443/udp');
    expect(source).toContain('pale-orbit:plan6b-6b-ii-smoke-0123456789abcdef');
    expect(source).toContain('com.paleorbit.plan6b-smoke.stage: 6b-ii');
    expect(source).toContain('com.paleorbit.plan6b-smoke.run: 0123456789abcdef');
    expect(source).toContain(`com.paleorbit.plan6b-smoke.owner: ${'f'.repeat(32)}`);
    expect(source).not.toContain('0.0.0.0:80');
    expect(source).not.toContain('0.0.0.0:443');
  });

  it('builds, migrates twice without drift, checks disabled runtime, and always cleans up', async () => {
    const trace: string[] = [];
    await expect(executeProductionSmoke(manifest(), operations(trace))).resolves.toEqual({
      migrationState: migrationState(),
      image: { digest: `sha256:${'a'.repeat(64)}`, sizeBytes: 42 }
    });
    expect(trace).toEqual([
      'build', 'ports', 'database', 'migrate', 'snapshot', 'migrate', 'snapshot',
      'ports', 'runtime', 'inspect-runtime', 'inspect-image', 'cleanup'
    ]);
  });

  it('leases the validated production image only before owned cleanup', async () => {
    const trace: string[] = [];
    const result = await executeProductionSmoke(
      manifest(),
      operations(trace),
      async (lease) => {
        trace.push('consume-image');
        expect(lease).toEqual({
          version: 2,
          stage: '6b-ii',
          sourceTag: manifest().imageTag,
          productionRunId: manifest().runId,
          productionOwnershipToken: manifest().ownershipToken,
          digest: `sha256:${'a'.repeat(64)}`,
          sizeBytes: 42
        });
      }
    );

    expect(result.image.digest).toBe(`sha256:${'a'.repeat(64)}`);
    expect(trace.slice(-3)).toEqual(['inspect-image', 'consume-image', 'cleanup']);
  });

  it('rejects stale checkpoint-I manifests and production image leases', () => {
    const owned = manifest();
    const currentLease: VerifiedProductionImageLease = {
      version: 2,
      stage: '6b-ii',
      sourceTag: owned.imageTag,
      productionRunId: owned.runId,
      productionOwnershipToken: owned.ownershipToken,
      digest: `sha256:${'a'.repeat(64)}`,
      sizeBytes: 42
    };
    expect(() => validateVerifiedProductionImageLease(currentLease)).not.toThrow();

    const staleManifest = {
      ...owned,
      version: 1,
      project: `pale-orbit-plan6b-smoke-${owned.runId}`,
      imageTag: `pale-orbit:plan6b-i-smoke-${owned.runId}`
    };
    delete (staleManifest as Partial<ProductionSmokeManifest>).stage;
    expect(() => validateProductionSmokeManifest(
      staleManifest as unknown as ProductionSmokeManifest
    )).toThrow();
    expect(() => validateProductionSmokeManifest({
      ...owned,
      imageTag: `pale-orbit:plan6b-i-smoke-${owned.runId}`
    })).toThrow();
    expect(() => validateProductionSmokeManifest({
      ...owned,
      project: `pale-orbit-plan6b-smoke-${owned.runId}`
    })).toThrow();

    const legacyLease = {
      version: 1,
      sourceTag: `pale-orbit:plan6b-i-smoke-${owned.runId}`,
      productionRunId: owned.runId,
      productionOwnershipToken: owned.ownershipToken,
      digest: currentLease.digest,
      sizeBytes: currentLease.sizeBytes
    };
    for (const staleLease of [
      legacyLease,
      { ...currentLease, stage: '6b-i' },
      { ...currentLease, sourceTag: `pale-orbit:plan6b-i-smoke-${owned.runId}` }
    ]) {
      expect(() => validateVerifiedProductionImageLease(
        staleLease as unknown as VerifiedProductionImageLease
      )).toThrow();
    }
  });

  it('cleans the production source image when its lease consumer fails', async () => {
    const trace: string[] = [];
    await expect(executeProductionSmoke(
      manifest(),
      operations(trace),
      async () => {
        trace.push('consume-image');
        throw new Error('private-fixture-failure');
      }
    )).rejects.toThrow('[plan6b-smoke] smoke verification failed');
    expect(trace.slice(-3)).toEqual(['inspect-image', 'consume-image', 'cleanup']);
  });

  it('cleans the exact owned manifest when post-manifest setup fails', async () => {
    const owned = manifest();
    const cleanupSetupFailure = vi.fn(async () => undefined);
    const dependencies: ProductionSmokeRunDependencies = {
      createManifest: vi.fn(async (stage) => {
        expect(stage).toBe('6b-ii');
        return owned;
      }),
      createOperations: vi.fn(async () => {
        throw new Error('private-secret-read-failure');
      }),
      cleanupSetupFailure,
      report: vi.fn()
    };

    await expect(runProductionSmoke('6b-ii', undefined, dependencies)).rejects.toThrow(
      '[plan6b-smoke] smoke verification failed'
    );
    expect(cleanupSetupFailure).toHaveBeenCalledExactlyOnceWith(owned);
    expect(dependencies.report).not.toHaveBeenCalled();
  });

  it('rejects an unsupported programmatic stage before allocating a manifest', async () => {
    const dependencies: ProductionSmokeRunDependencies = {
      createManifest: vi.fn(async () => manifest()),
      createOperations: vi.fn(async () => operations([])),
      cleanupSetupFailure: vi.fn(async () => undefined),
      report: vi.fn()
    };

    await expect(runProductionSmoke(
      '6b-i' as '6b-ii',
      undefined,
      dependencies
    )).rejects.toThrow('[plan6b-smoke] stage is invalid');
    expect(dependencies.createManifest).not.toHaveBeenCalled();
    expect(dependencies.createOperations).not.toHaveBeenCalled();
    expect(dependencies.cleanupSetupFailure).not.toHaveBeenCalled();
  });

  it.each([
    'build', 'ports', 'database', 'migrate', 'snapshot', 'runtime', 'inspect-runtime', 'inspect-image'
  ])('cleans the exact owned run when %s fails', async (failAt) => {
    const trace: string[] = [];
    await expect(executeProductionSmoke(manifest(), operations(trace, failAt))).rejects.toThrow();
    expect(trace.at(-1)).toBe('cleanup');
  });

  it('rejects migration drift and unsafe disabled-runtime evidence before reporting success', async () => {
    const trace: string[] = [];
    const drift = operations(trace);
    vi.mocked(drift.snapshotMigrationState)
      .mockResolvedValueOnce(migrationState())
      .mockResolvedValueOnce(migrationState({ migrationCount: 8, migrationMax: 8 }));
    await expect(executeProductionSmoke(manifest(), drift)).rejects.toThrow(
      '[plan6b-smoke] smoke verification failed'
    );
    expect(trace.at(-1)).toBe('cleanup');

    for (const unsafe of [
      { appStripeEnabled: true }, { workerFixtureMode: true }, { appHasStripeSecret: true },
      { appDatabaseRoleIsWeb: false }, { workerDatabaseRoleIsWorker: false },
      { postgresHostPublished: true }, { workerReady: false }, { providerBackedJobCount: 1 },
      { classificationRootCount: 2 }, { classificationRootUnsafeCount: 1 },
      { classificationContinuationCount: 0 },
      { classificationContinuationCompletedCount: 0 },
      { classificationContinuationUnsafeCount: 1 },
      { classificationRunCount: 0 }, { classificationRunCompletedCount: 0 },
      { pendingProjectionVersionCount: 1 },
      { activeClassifierVersion: 2 }, { activeAllocationAlgorithmVersion: 1 },
      { storefrontStatus: 200 }, { commerceStatus: 200 }
    ]) {
      const calls: string[] = [];
      const runtime = operations(calls);
      vi.mocked(runtime.inspectDisabledRuntime).mockResolvedValue({ ...safeRuntime(), ...unsafe });
      await expect(executeProductionSmoke(manifest(), runtime)).rejects.toThrow(
        '[plan6b-smoke] smoke verification failed'
      );
      expect(calls.at(-1)).toBe('cleanup');
    }
  });

  it('requires the exact active c1/a1 projection-version singleton before runtime startup', async () => {
    for (const unsafe of [
      { projectionVersionCount: 0 },
      { projectionVersionCount: 2 },
      { activeClassifierVersion: 2 },
      { activeAllocationAlgorithmVersion: 2 }
    ]) {
      const trace: string[] = [];
      const smoke = operations(trace);
      vi.mocked(smoke.snapshotMigrationState).mockResolvedValue(migrationState(unsafe));
      await expect(executeProductionSmoke(manifest(), smoke)).rejects.toThrow(
        '[plan6b-smoke] smoke verification failed'
      );
      expect(smoke.startRuntime).not.toHaveBeenCalled();
      expect(trace.at(-1)).toBe('cleanup');
    }
  });

  it('requires the sole local replay root to complete against an empty provider ledger', async () => {
    for (const unsafe of [
      { classificationRootCompletedCount: 0, providerLedgerSubjectCount: 0 },
      { classificationContinuationCompletedCount: 0, providerLedgerSubjectCount: 0 },
      { classificationRunCompletedCount: 0, providerLedgerSubjectCount: 0 },
      { pendingProjectionVersionCount: 1, providerLedgerSubjectCount: 0 },
      { classificationRootCompletedCount: 1, providerLedgerSubjectCount: 1 }
    ]) {
      const trace: string[] = [];
      const runtime = operations(trace);
      vi.mocked(runtime.inspectDisabledRuntime).mockResolvedValue({
        ...safeRuntime(),
        ...unsafe
      });
      await expect(executeProductionSmoke(manifest(), runtime)).rejects.toThrow(
        '[plan6b-smoke] smoke verification failed'
      );
      expect(trace.at(-1)).toBe('cleanup');
    }
  });

  it('queries the actual provider-ledger tables with valid JSON argument separation', async () => {
    const source = await readFile(
      new URL('./plan6b-production-smoke.ts', import.meta.url),
      'utf8'
    );
    expect(source).toMatch(/ {10}\),\r?\n {10}'providerLedgerSubjectCount',/u);
    expect(source).toContain('from stripe_balance_transactions');
    expect(source).toContain('from stripe_balance_transaction_fee_details');
    expect(source).not.toContain('from financial_balance_transactions');
    expect(source).not.toContain('from financial_balance_transaction_fee_details');
  });

  it('recognizes the exact composite replay job payload kind in disabled mode', async () => {
    const source = await readFile(
      new URL('./plan6b-production-smoke.ts', import.meta.url),
      'utf8'
    );
    expect(source).toContain("payload->>'kind' = 'composite_replay'");
    expect(source).toContain("payload->>'kind' = 'continuation'");
    expect(source).toContain("'classification_replay_page', 'classification_replay_finalize'");
    expect(source).toContain("'classificationContinuationCompletedCount'");
    expect(source).toContain('from financial_scan_runs');
    expect(source).toContain("'pendingProjectionVersionCount'");
    expect(source).not.toContain("coalesce(payload->>'kind', '') <> 'composite_replay'");
    expect(source).not.toContain("payload->>'kind' = 'classification_replay'");
    expect(source).not.toContain("coalesce(payload->>'kind', '') <> 'classification_replay'");
  });

  it('does not expose operation messages or causes across the smoke boundary', async () => {
    const trace: string[] = [];
    const runtime = operations(trace);
    vi.mocked(runtime.startRuntime).mockRejectedValue(
      Object.assign(new Error('sk_test_private_runtime'), { cause: 'whsec_private_cause' })
    );
    const error = await executeProductionSmoke(manifest(), runtime).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toBe('Error: [plan6b-smoke] smoke verification failed');
    expect(Object.hasOwn(error as object, 'cause')).toBe(false);
  });

  it('command runtime retains fixed stderr for a successfully spawned allowed failure', async () => {
    commandAdapterTraps.spawnSync.mockReturnValueOnce({
      status: 1,
      stdout: '',
      stderr: '[worker-health] unhealthy\n',
      error: undefined,
      signal: null
    });

    await expect(createProductionSmokeCommandRuntime().capture(
      ['compose', 'exec', '-T', 'worker', 'node', 'build/services/worker-health.js'],
      { PATH: 'safe-path' },
      true
    )).resolves.toEqual({
      status: 1,
      stdout: '',
      stderr: '[worker-health] unhealthy\n'
    });
  });

  it('command runtime rejects a spawn error even when command failure is allowed', async () => {
    commandAdapterTraps.spawnSync.mockReturnValueOnce({
      status: null,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' }),
      signal: null
    });

    await expect(createProductionSmokeCommandRuntime().capture(
      ['compose', 'exec', '-T', 'worker', 'node', 'build/services/worker-health.js'],
      { PATH: '' },
      true
    )).rejects.toThrow('[plan6b-smoke] Docker command failed');
  });

  it('refuses an unsafe manifest before invoking cleanup or another operation', async () => {
    const trace: string[] = [];
    await expect(executeProductionSmoke(
      { ...manifest(), project: '*' }, operations(trace)
    )).rejects.toThrow(/manifest|project/u);
    expect(trace).toEqual([]);
  });

  it('invokes Docker without shell interpolation or inherited Stripe secrets', async () => {
    const calls: Array<{ kind: 'run' | 'capture'; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const command: ProductionSmokeCommandRuntime = {
      run: vi.fn(async (args, env) => {
        calls.push({ kind: 'run', args, env });
      }),
      capture: vi.fn(async (args, env) => {
        calls.push({ kind: 'capture', args, env });
        return { status: 0, stdout: '' };
      })
    };
    const owned = manifest();
    const docker = createProductionSmokeDockerOperations(owned, {
      command,
      environment: {
        PATH: 'safe-path',
        STRIPE_SECRET_KEY: 'sk_test_private_canary',
        STRIPE_WEBHOOK_SECRET: 'whsec_private_canary'
      },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    await docker.build(owned);

    expect(calls.find((call) => call.kind === 'run')?.args).toEqual([
      'build', '--target', 'production', '--label',
      'com.paleorbit.plan6b-smoke.stage=6b-ii', '--label',
      'com.paleorbit.plan6b-smoke.run=0123456789abcdef', '--label',
      `com.paleorbit.plan6b-smoke.owner=${'f'.repeat(32)}`, '--tag',
      'pale-orbit:plan6b-6b-ii-smoke-0123456789abcdef', '.'
    ]);
    expect(JSON.stringify(calls)).not.toContain('sk_test_private_canary');
    expect(JSON.stringify(calls)).not.toContain('whsec_private_canary');
    expect(calls.every((call) => !Object.keys(call.env).some((key) => key.startsWith('STRIPE_'))))
      .toBe(true);
    expect(calls.every((call) => call.env.ORIGIN === 'https://plan6b-smoke.invalid'))
      .toBe(true);
  });

  it('provisions the fourth role before exercising production cleanup wiring', async () => {
    const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const owned = manifest();
    const docker = createProductionSmokeDockerOperations(owned, {
      command: {
        run: vi.fn(async (args, env) => { calls.push({ args, env }); }),
        capture: vi.fn(async () => ({ status: 0, stdout: '' }))
      },
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    await docker.migrate(owned);

    expect(calls.map((call) => call.args.at(-1))).toEqual([
      'migrate',
      'database-role-provision',
      'storage-cleanup'
    ]);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) =>
      call.env.DATABASE_STORAGE_CLEANUP_USER ===
        'plan6b_smoke_storage_cleanup_0123456789abcdef'
    )).toBe(true);
  });

  it('materializes a private cleanup database secret with the owned smoke manifest', async () => {
    const owned = await createProductionSmokeManifest('6b-ii', deterministicPortOperations());
    try {
      await expect(readFile(
        join(owned.secretDirectory, 'database_storage_cleanup_password'),
        'utf8'
      )).resolves.toMatch(/^[a-f0-9]{48}$/u);
    } finally {
      await rm(owned.tempDirectory, { recursive: true, force: true });
    }
  });

  it('refuses a Docker project collision before building or cleaning foreign resources', async () => {
    const command: ProductionSmokeCommandRuntime = {
      run: vi.fn(async () => undefined),
      capture: vi.fn(async (args) => ({
        status: 0,
        stdout: args[0] === 'ps' ? `${'a'.repeat(64)}\n` : ''
      }))
    };
    const owned = manifest();
    const docker = createProductionSmokeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    await expect(docker.build(owned)).rejects.toThrow(/collides/u);
    expect(command.run).not.toHaveBeenCalled();
  });

  it.each([
    ['container', (owned: ReturnType<typeof manifest>) => `${owned.project}-postgres-1`],
    ['network', (owned: ReturnType<typeof manifest>) => `${owned.project}_default`],
    ['volume', (owned: ReturnType<typeof manifest>) => `${owned.project}_postgres_data`]
  ] as const)('refuses a foreign exact-name %s before the first Docker mutation', async (
    resource,
    expectedName
  ) => {
    const owned = manifest();
    const name = expectedName(owned);
    const command: ProductionSmokeCommandRuntime = {
      run: vi.fn(async () => undefined),
      capture: vi.fn(async (args) => ({
        status: 0,
        stdout: args[0] === (resource === 'container' ? 'ps' : resource) &&
          args.includes(`name=${name}`) ? `${name}\n` : ''
      }))
    };
    const docker = createProductionSmokeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    await expect(docker.build(owned)).rejects.toThrow(/exact-name|collid/iu);
    expect(command.run).not.toHaveBeenCalled();
  });

  it('rechecks exact-name collisions immediately before Compose startup', async () => {
    const owned = manifest();
    const exactVolumeName = `${owned.project}_postgres_data`;
    const command: ProductionSmokeCommandRuntime = {
      run: vi.fn(async () => undefined),
      capture: vi.fn(async (args) => ({
        status: 0,
        stdout: args[0] === 'volume' && args.includes(`name=${exactVolumeName}`)
          ? `${exactVolumeName}\n`
          : ''
      }))
    };
    const docker = createProductionSmokeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    await expect(docker.startDatabase(owned)).rejects.toThrow(/exact-name|collid/iu);
    expect(command.run).not.toHaveBeenCalled();
  });

  it('fails closed when Docker resource inventory cannot be read', async () => {
    const command: ProductionSmokeCommandRuntime = {
      run: vi.fn(async () => undefined),
      capture: vi.fn(async (args) => ({
        status: args[0] === 'ps' ? 1 : args[0] === 'image' ? 1 : 0,
        stdout: ''
      }))
    };
    const owned = manifest();
    const docker = createProductionSmokeDockerOperations(owned, {
      command, environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    await expect(docker.build(owned)).rejects.toThrow(/inventory/u);
    expect(command.run).not.toHaveBeenCalled();
  });

  it('fails closed when the exact image-tag inventory cannot be read', async () => {
    const command: ProductionSmokeCommandRuntime = {
      run: vi.fn(async () => undefined),
      capture: vi.fn(async (args) => ({
        status: args[0] === 'image' ? 1 : 0,
        stdout: ''
      }))
    };
    const owned = manifest();
    const docker = createProductionSmokeDockerOperations(owned, {
      command, environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    await expect(docker.build(owned)).rejects.toThrow(/image.*inventory/iu);
    expect(command.run).not.toHaveBeenCalled();
  });

  it('never removes a pre-existing image tag after refusing its collision', async () => {
    const owned = await createProductionSmokeManifest('6b-ii', deterministicPortOperations());
    const calls: string[][] = [];
    const imageId = `sha256:${'a'.repeat(64)}`;
    const command: ProductionSmokeCommandRuntime = {
      run: vi.fn(async (args) => { calls.push([...args]); }),
      capture: vi.fn(async (args) => {
        if (args[0] === 'image' && args[1] === 'ls') {
          return { status: 0, stdout: `${imageId}\n` };
        }
        if (args[0] === 'image' && args[1] === 'inspect') {
          return {
            status: 0,
            stdout: JSON.stringify({
              Id: imageId,
              Size: 42,
              Config: { Labels: {
                'com.paleorbit.plan6b-smoke.run': owned.runId,
                'com.paleorbit.plan6b-smoke.stage': owned.stage,
                'com.paleorbit.plan6b-smoke.owner': owned.ownershipToken
              } }
            })
          };
        }
        return { status: 0, stdout: '' };
      })
    };
    const docker = createProductionSmokeDockerOperations(owned, {
      command, environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    try {
      await expect(executeProductionSmoke(owned, docker)).rejects.toThrow(
        '[plan6b-smoke] smoke verification failed'
      );
      expect(calls).not.toContainEqual(['image', 'rm', owned.imageTag]);
      await expect(stat(owned.tempDirectory)).rejects.toThrow();
    } finally {
      await rm(owned.tempDirectory, { recursive: true, force: true });
    }
  });

  it('revalidates loopback ports immediately before starting the runtime', async () => {
    const trace: string[] = [];
    const smoke = operations(trace);
    await executeProductionSmoke(manifest(), smoke);
    expect(trace).toEqual([
      'build', 'ports', 'database', 'migrate', 'snapshot', 'migrate', 'snapshot',
      'ports', 'runtime', 'inspect-runtime', 'inspect-image', 'cleanup'
    ]);
  });

  it('captures the canonical projection-version seed in stable migration evidence', async () => {
    const queries: string[] = [];
    const command: ProductionSmokeCommandRuntime = {
      run: vi.fn(async () => undefined),
      capture: vi.fn(async (args) => {
        if (args.includes('psql')) queries.push(String(args.at(-1)));
        return { status: args[0] === 'image' ? 1 : 0, stdout: '{}' };
      })
    };
    const owned = manifest();
    const docker = createProductionSmokeDockerOperations(owned, {
      command, environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    await docker.snapshotMigrationState(owned);
    expect(queries[0]).toContain("'projectionVersionCount'");
    expect(queries[0]).toContain("'activeClassifierVersion'");
    expect(queries[0]).toContain("'activeAllocationAlgorithmVersion'");
  });

  it('rejects transport exit 125 during the stale worker-health rehearsal', async () => {
    const owned = manifest();
    const docker = createProductionSmokeDockerOperations(owned, {
      command: runtimeInspectionCommand(() => ({
        status: 125,
        stdout: '',
        stderr: '[worker-health] unhealthy\n'
      })),
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    await expect(docker.inspectDisabledRuntime(owned)).rejects.toThrow(
      /stale worker health rehearsal/u
    );
  });

  it('rejects exit one without validator stderr during the missing-slot rehearsal', async () => {
    const owned = manifest();
    const docker = createProductionSmokeDockerOperations(owned, {
      command: runtimeInspectionCommand((readyFileOverride) => ({
        status: 1,
        stdout: '',
        stderr: readyFileOverride.includes('stale-')
          ? '[worker-health] unhealthy\n'
          : ''
      })),
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    await expect(docker.inspectDisabledRuntime(owned)).rejects.toThrow(
      /missing-slot worker health rehearsal/u
    );
  });

  it('inspects app and worker mounts plus /run/secrets instead of trusting environment alone', async () => {
    const runs: readonly string[][] = [];
    const mutableRuns = runs as string[][];
    const captures: Array<{
      readonly args: readonly string[];
      readonly allowFailure: boolean | undefined;
    }> = [];
    const queries: string[] = [];
    const appId = 'a'.repeat(64);
    const workerId = 'b'.repeat(64);
    const postgresId = 'c'.repeat(64);
    const command: ProductionSmokeCommandRuntime = {
      run: vi.fn(async (args) => {
        mutableRuns.push([...args]);
      }),
      capture: vi.fn(async (args, _environment, allowFailure) => {
        captures.push({ args: [...args], allowFailure });
        if (args.includes('ps') && args.includes('--quiet')) {
          const service = args.at(-1);
          return {
            status: 0,
            stdout: `${service === 'app' ? appId : service === 'worker' ? workerId : postgresId}\n`
          };
        }
        if (args[0] === 'inspect' && args.includes('{{json .Config.Env}}')) {
          return {
            status: 0,
            stdout: args.at(-1) === workerId
              ? JSON.stringify([
                  'WORKER_CONCURRENCY=2',
                  'WORKER_HEARTBEAT_INTERVAL_MS=5000',
                  'WORKER_HEARTBEAT_MAX_AGE_MS=20000'
                ])
              : '[]'
          };
        }
        if (args[0] === 'inspect' && args.includes('{{json .Mounts}}')) {
          return {
            status: 0,
            stdout: args.at(-1) === appId
              ? JSON.stringify([{ Destination: '/run/secrets/stripe_api_key' }])
              : '[]'
          };
        }
        if (args[0] === 'port') return { status: 0, stdout: '' };
        if (args.includes('build/services/worker-health.js')) {
          return args.includes('--env')
            ? { status: 1, stdout: '', stderr: '[worker-health] unhealthy\n' }
            : { status: 0, stdout: '' };
        }
        if (args.includes('psql')) {
          queries.push(String(args.at(-1)));
          return {
            status: 0,
            stdout: JSON.stringify({
              providerBackedJobCount: 0,
              classificationRootCount: 1,
              classificationRootCompletedCount: 1,
              classificationRootUnsafeCount: 0,
              classificationContinuationCount: 1,
              classificationContinuationCompletedCount: 1,
              classificationContinuationUnsafeCount: 0,
              classificationRunCount: 1,
              classificationRunCompletedCount: 1,
              pendingProjectionVersionCount: 0,
              activeClassifierVersion: 1,
              activeAllocationAlgorithmVersion: 2,
              providerLedgerSubjectCount: 0
            })
          };
        }
        return { status: 0, stdout: '' };
      })
    };
    const owned = manifest();
    const docker = createProductionSmokeDockerOperations(owned, {
      command, environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined),
      now: () => new Date('2026-08-26T12:00:00.000Z')
    });

    await expect(docker.inspectDisabledRuntime(owned)).resolves.toMatchObject({
      appHasStripeSecret: true,
      workerHasStripeSecret: false
    });
    expect(queries[0]).toContain("'activeClassifierVersion'");
    expect(queries[0]).toContain("'activeAllocationAlgorithmVersion'");
    for (const service of ['app', 'worker']) {
      expect(mutableRuns.some((args) =>
        args.includes('exec') && args.includes(service) && args.some((arg) => arg.includes('/run/secrets'))
      )).toBe(true);
    }

    const healthCaptures = captures.filter(({ args }) =>
      args.includes('build/services/worker-health.js')
    );
    expect(healthCaptures).toHaveLength(3);
    expect(healthCaptures[0]?.args).toEqual(expect.arrayContaining([
      'exec', '-T', 'worker', 'node', 'build/services/worker-health.js'
    ]));
    expect(healthCaptures[0]?.args).not.toContain('--env');
    expect(healthCaptures.every(({ allowFailure }) => allowFailure === true)).toBe(true);

    const stalePath = `/tmp/worker-heartbeat-stale-${owned.runId}.json`;
    const missingSlotPath = `/tmp/worker-heartbeat-missing-slot-${owned.runId}.json`;
    expect(healthCaptures[1]?.args).toEqual(expect.arrayContaining([
      '--env', `WORKER_READY_FILE=${stalePath}`, 'worker', 'node',
      'build/services/worker-health.js'
    ]));
    expect(healthCaptures[2]?.args).toEqual(expect.arrayContaining([
      '--env', `WORKER_READY_FILE=${missingSlotPath}`, 'worker', 'node',
      'build/services/worker-health.js'
    ]));

    const writtenRecord = (path: string): string => {
      const call = runs.find((args) => args.includes(path) && args.at(-1) !== path);
      expect(call, path).toBeDefined();
      return Buffer.from(call!.at(-1)!, 'base64url').toString('utf8');
    };
    const staleRaw = writtenRecord(stalePath);
    const missingSlotRaw = writtenRecord(missingSlotPath);
    expect(staleRaw).toBe(
      '{"version":1,"workerId":"worker:plan6b-smoke-stale",' +
      '"processStartedAt":"2026-08-26T11:59:39.999Z",' +
      '"publishedAt":"2026-08-26T11:59:39.999Z","sequence":1,' +
      '"configuredSlots":2,"slots":[' +
      '{"slotId":0,"state":"idle","lastSuccessfulPollAt":"2026-08-26T11:59:39.999Z",' +
      '"lastProgressAt":"2026-08-26T11:59:39.999Z"},' +
      '{"slotId":1,"state":"idle","lastSuccessfulPollAt":"2026-08-26T11:59:39.999Z",' +
      '"lastProgressAt":"2026-08-26T11:59:39.999Z"}]}'
    );
    expect(missingSlotRaw).toBe(
      '{"version":1,"workerId":"worker:plan6b-smoke-missing-slot",' +
      '"processStartedAt":"2026-08-26T12:00:00.000Z",' +
      '"publishedAt":"2026-08-26T12:00:00.000Z","sequence":1,' +
      '"configuredSlots":2,"slots":[' +
      '{"slotId":1,"state":"idle","lastSuccessfulPollAt":"2026-08-26T12:00:00.000Z",' +
      '"lastProgressAt":"2026-08-26T12:00:00.000Z"}]}'
    );
    for (const path of [stalePath, missingSlotPath]) {
      expect(runs.filter((args) => args.includes(path))).toHaveLength(2);
    }
    expect(runs.some((args) => args.includes('/tmp/worker-ready'))).toBe(false);
  });

  it('does not remove a synthetic heartbeat path when exclusive creation collides', async () => {
    const owned = manifest();
    const stalePath = `/tmp/worker-heartbeat-stale-${owned.runId}.json`;
    const missingSlotPath = `/tmp/worker-heartbeat-missing-slot-${owned.runId}.json`;
    const appId = 'a'.repeat(64);
    const workerId = 'b'.repeat(64);
    const postgresId = 'c'.repeat(64);
    const runs: string[][] = [];
    const command: ProductionSmokeCommandRuntime = {
      run: vi.fn(async (args) => {
        runs.push([...args]);
        if (args.includes(stalePath) && args.at(-1) !== stalePath) {
          throw new Error('exclusive synthetic path collision');
        }
      }),
      capture: vi.fn(async (args) => {
        if (args.includes('ps') && args.includes('--quiet')) {
          const service = args.at(-1);
          return {
            status: 0,
            stdout: `${service === 'app' ? appId : service === 'worker' ? workerId : postgresId}\n`
          };
        }
        if (args[0] === 'inspect' && args.includes('{{json .Config.Env}}')) {
          return {
            status: 0,
            stdout: args.at(-1) === workerId
              ? JSON.stringify([
                  'WORKER_CONCURRENCY=1',
                  'WORKER_HEARTBEAT_MAX_AGE_MS=20000'
                ])
              : '[]'
          };
        }
        if (args[0] === 'inspect' && args.includes('{{json .Mounts}}')) {
          return { status: 0, stdout: '[]' };
        }
        if (args[0] === 'port') return { status: 0, stdout: '' };
        if (args.includes('build/services/worker-health.js')) {
          return args.includes('--env')
            ? { status: 1, stdout: '', stderr: '[worker-health] unhealthy\n' }
            : { status: 0, stdout: '' };
        }
        if (args.includes('psql')) {
          return {
            status: 0,
            stdout: JSON.stringify({
              providerBackedJobCount: 0,
              classificationRootCount: 1,
              classificationRootCompletedCount: 1,
              classificationRootUnsafeCount: 0,
              classificationContinuationCount: 1,
              classificationContinuationCompletedCount: 1,
              classificationContinuationUnsafeCount: 0,
              classificationRunCount: 1,
              classificationRunCompletedCount: 1,
              pendingProjectionVersionCount: 0,
              activeClassifierVersion: 1,
              activeAllocationAlgorithmVersion: 2,
              providerLedgerSubjectCount: 0
            })
          };
        }
        return { status: 0, stdout: '' };
      })
    };
    const docker = createProductionSmokeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    await expect(docker.inspectDisabledRuntime(owned)).rejects.toThrow(
      'exclusive synthetic path collision'
    );
    expect(runs.filter((args) => args.includes(stalePath))).toHaveLength(1);
    expect(runs.some((args) => args.at(-1) === stalePath)).toBe(false);
    expect(runs.some((args) => args.includes(missingSlotPath))).toBe(false);
  });

  it('fails closed when PostgreSQL host-port inspection cannot be read', async () => {
    const appId = 'a'.repeat(64);
    const workerId = 'b'.repeat(64);
    const postgresId = 'c'.repeat(64);
    const command: ProductionSmokeCommandRuntime = {
      run: vi.fn(async () => undefined),
      capture: vi.fn(async (args) => {
        if (args.includes('ps') && args.includes('--quiet')) {
          const service = args.at(-1);
          return {
            status: 0,
            stdout: `${service === 'app' ? appId : service === 'worker' ? workerId : postgresId}\n`
          };
        }
        if (args[0] === 'inspect' && args.includes('{{json .Config.Env}}')) {
          return {
            status: 0,
            stdout: args.at(-1) === workerId
              ? JSON.stringify([
                  'WORKER_CONCURRENCY=1',
                  'WORKER_HEARTBEAT_MAX_AGE_MS=20000'
                ])
              : '[]'
          };
        }
        if (args[0] === 'inspect' && args.includes('{{json .Mounts}}')) {
          return { status: 0, stdout: '[]' };
        }
        if (args[0] === 'port') return { status: 1, stdout: '' };
        if (args.includes('psql')) {
          return {
            status: 0,
            stdout: JSON.stringify({
              providerBackedJobCount: 0,
              classificationRootCount: 1,
              classificationRootCompletedCount: 1,
              classificationRootUnsafeCount: 0,
              classificationContinuationCount: 1,
              classificationContinuationCompletedCount: 1,
              classificationContinuationUnsafeCount: 0,
              classificationRunCount: 1,
              classificationRunCompletedCount: 1,
              pendingProjectionVersionCount: 0,
              providerLedgerSubjectCount: 0
            })
          };
        }
        return { status: 0, stdout: '' };
      })
    };
    const owned = manifest();
    const docker = createProductionSmokeDockerOperations(owned, {
      command, environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    await expect(docker.inspectDisabledRuntime(owned)).rejects.toThrow(/port.*evidence/iu);
  });

  it('waits a bounded interval for the disabled composite replay finalizer to complete', async () => {
    const appId = 'a'.repeat(64);
    const workerId = 'b'.repeat(64);
    const postgresId = 'c'.repeat(64);
    let jobSnapshot = 0;
    const wait = vi.fn(async () => undefined);
    const command: ProductionSmokeCommandRuntime = {
      run: vi.fn(async () => undefined),
      capture: vi.fn(async (args) => {
        if (args.includes('ps') && args.includes('--quiet')) {
          const service = args.at(-1);
          return {
            status: 0,
            stdout: `${service === 'app' ? appId : service === 'worker' ? workerId : postgresId}\n`
          };
        }
        if (args[0] === 'inspect' && args.includes('{{json .Config.Env}}')) {
          return {
            status: 0,
            stdout: args.at(-1) === workerId
              ? JSON.stringify([
                  'WORKER_CONCURRENCY=1',
                  'WORKER_HEARTBEAT_MAX_AGE_MS=20000'
                ])
              : '[]'
          };
        }
        if (args[0] === 'inspect' && args.includes('{{json .Mounts}}')) {
          return { status: 0, stdout: '[]' };
        }
        if (args[0] === 'port') return { status: 0, stdout: '' };
        if (args.includes('build/services/worker-health.js')) {
          return args.includes('--env')
            ? { status: 1, stdout: '', stderr: '[worker-health] unhealthy\n' }
            : { status: 0, stdout: '' };
        }
        if (args.includes('psql')) {
          jobSnapshot += 1;
          return {
            status: 0,
            stdout: JSON.stringify({
              providerBackedJobCount: 0,
              classificationRootCount: 1,
              classificationRootCompletedCount: jobSnapshot === 1 ? 0 : 1,
              classificationRootUnsafeCount: 0,
              classificationContinuationCount: jobSnapshot === 1 ? 0 : 1,
              classificationContinuationCompletedCount: jobSnapshot === 1 ? 0 : 1,
              classificationContinuationUnsafeCount: 0,
              classificationRunCount: 1,
              classificationRunCompletedCount: jobSnapshot === 1 ? 0 : 1,
              pendingProjectionVersionCount: 0,
              activeClassifierVersion: 1,
              activeAllocationAlgorithmVersion: jobSnapshot === 1 ? 1 : 2,
              providerLedgerSubjectCount: 0
            })
          };
        }
        return { status: 0, stdout: '' };
      })
    };
    const owned = manifest();
    const docker = createProductionSmokeDockerOperations(owned, {
      command, environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait
    });

    await expect(docker.inspectDisabledRuntime(owned)).resolves.toMatchObject({
      classificationRootCompletedCount: 1,
      classificationContinuationCompletedCount: 1,
      classificationRunCompletedCount: 1,
      pendingProjectionVersionCount: 0
    });
    expect(jobSnapshot).toBe(2);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it('removes and verifies only the exact owned production image tag', async () => {
    const owned = await createProductionSmokeManifest('6b-ii', deterministicPortOperations());
    let imagePresent = false;
    const imageInventories: string[][] = [];
    const command: ProductionSmokeCommandRuntime = {
      run: vi.fn(async (args) => {
        if (args[0] === 'build') imagePresent = true;
        if (args[0] === 'image' && args[1] === 'rm') imagePresent = false;
      }),
      capture: vi.fn(async (args) => {
        if (args[0] === 'image' && args[1] === 'ls') {
          imageInventories.push([...args]);
          return { status: 0, stdout: imagePresent ? `sha256:${'a'.repeat(64)}\n` : '' };
        }
        if (args[0] === 'image' && args[1] === 'inspect') {
          return {
            status: 0,
            stdout: JSON.stringify({
              Id: `sha256:${'a'.repeat(64)}`,
              Size: 42,
              Config: { Labels: {
                'com.paleorbit.plan6b-smoke.run': owned.runId,
                'com.paleorbit.plan6b-smoke.stage': owned.stage,
                'com.paleorbit.plan6b-smoke.owner': owned.ownershipToken
              } }
            })
          };
        }
        return { status: 0, stdout: '' };
      })
    };
    const docker = createProductionSmokeDockerOperations(owned, {
      command, environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    try {
      await docker.build(owned);
      await docker.cleanup(owned);
      expect(imageInventories).toHaveLength(3);
      expect(command.run).toHaveBeenCalledWith(['image', 'rm', owned.imageTag], expect.any(Object));
      expect(imagePresent).toBe(false);
      await expect(stat(owned.tempDirectory)).rejects.toThrow();
    } finally {
      await rm(owned.tempDirectory, { recursive: true, force: true });
    }
  });

  it('fails cleanup when Compose down succeeds but an owned volume remains', async () => {
    const owned = await createProductionSmokeManifest('6b-ii', deterministicPortOperations());
    const volumeId = 'plan6b-owned-volume';
    let downCalled = false;
    const labels = {
      'com.docker.compose.project': owned.project,
      'com.paleorbit.plan6b-smoke.stage': owned.stage,
      'com.paleorbit.plan6b-smoke.run': owned.runId,
      'com.paleorbit.plan6b-smoke.owner': owned.ownershipToken
    };
    const command: ProductionSmokeCommandRuntime = {
      run: vi.fn(async (args) => {
        if (args[0] === 'compose' && args.includes('down')) downCalled = true;
      }),
      capture: vi.fn(async (args) => {
        if (args[0] === 'volume' && args[1] === 'ls') {
          return { status: 0, stdout: `${volumeId}\n` };
        }
        if (args[0] === 'volume' && args[1] === 'inspect') {
          return { status: 0, stdout: JSON.stringify(labels) };
        }
        return { status: 0, stdout: '' };
      })
    };
    const docker = createProductionSmokeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    try {
      await expect(docker.cleanup(owned)).rejects.toThrow(/resource|volume|cleanup/u);
      expect(downCalled).toBe(true);
      expect(await readFile(owned.manifestFile, 'utf8')).toContain(owned.project);
    } finally {
      await rm(owned.tempDirectory, { recursive: true, force: true });
    }
  });

  it('refuses cleanup before Compose down when an exact-name volume has a foreign stage', async () => {
    const owned = await createProductionSmokeManifest('6b-ii', deterministicPortOperations());
    const exactVolumeName = `${owned.project}_postgres_data`;
    let downCalled = false;
    const command: ProductionSmokeCommandRuntime = {
      run: vi.fn(async (args) => {
        if (args[0] === 'compose' && args.includes('down')) downCalled = true;
      }),
      capture: vi.fn(async (args) => {
        if (args[0] === 'volume' && args[1] === 'ls' &&
          args.includes(`name=${exactVolumeName}`)) {
          return { status: 0, stdout: `${exactVolumeName}\n` };
        }
        if (args[0] === 'volume' && args[1] === 'inspect') {
          return {
            status: 0,
            stdout: JSON.stringify({
              'com.docker.compose.project': owned.project,
              'com.paleorbit.plan6b-smoke.stage': '6b-i',
              'com.paleorbit.plan6b-smoke.run': owned.runId,
              'com.paleorbit.plan6b-smoke.owner': owned.ownershipToken
            })
          };
        }
        return { status: 0, stdout: '' };
      })
    };
    const docker = createProductionSmokeDockerOperations(owned, {
      command,
      environment: { PATH: 'safe-path' },
      assertPortAvailable: vi.fn(async () => undefined),
      requestStatus: vi.fn(async () => 503),
      wait: vi.fn(async () => undefined)
    });

    try {
      await expect(docker.cleanup(owned)).rejects.toThrow(/foreign|volume|cleanup/u);
      expect(downCalled).toBe(false);
      expect(await readFile(owned.manifestFile, 'utf8')).toContain(owned.project);
    } finally {
      await rm(owned.tempDirectory, { recursive: true, force: true });
    }
  });
});
