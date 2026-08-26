import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { encodeWorkerHeartbeat } from './heartbeat-contract';
import type { WorkerHeartbeatRecord } from './heartbeat-contract';
import {
	runWorkerHealthCheck,
	type WorkerHealthCheckOptions,
	type WorkerHealthFileHandle,
	type WorkerHealthFileStat,
	type WorkerHealthFilesystem
} from './health-check';

const UNHEALTHY_LINE = '[worker-health] unhealthy';
const HEARTBEAT_PATH = 'C:\\private\\worker-heartbeat-privacy-canary';
const ERROR_CANARY = 'private-error-privacy-canary';
const WORKER_CANARY = 'worker-private-privacy-canary';
const PROCESS_STARTED_AT = '2026-08-26T12:00:00.000Z';
const PUBLISHED_AT = '2026-08-26T12:00:05.000Z';
const NOW = new Date('2026-08-26T12:00:06.000Z');

interface FilesystemHarnessOptions {
	readonly raw?: string;
	readonly size?: number;
	readonly regular?: boolean;
	readonly stat?: WorkerHealthFileStat;
	readonly openError?: unknown;
	readonly statError?: unknown;
	readonly readError?: unknown;
	readonly closeError?: unknown;
}

function heartbeatRecord(
	overrides: Partial<WorkerHeartbeatRecord> = {}
): WorkerHeartbeatRecord {
	return {
		version: 1,
		workerId: WORKER_CANARY,
		processStartedAt: PROCESS_STARTED_AT,
		publishedAt: PUBLISHED_AT,
		sequence: 1,
		configuredSlots: 1,
		slots: [
			{
				slotId: 0,
				state: 'idle',
				lastSuccessfulPollAt: '2026-08-26T12:00:01.000Z',
				lastProgressAt: '2026-08-26T12:00:04.000Z'
			}
		],
		...overrides
	};
}

function filesystemHarness(options: FilesystemHarnessOptions = {}) {
	const raw = options.raw ?? encodeWorkerHeartbeat(heartbeatRecord());
	const operations: string[] = [];
	const stat: WorkerHealthFileStat = options.stat ?? {
		size: options.size ?? Buffer.byteLength(raw, 'utf8'),
		isFile: vi.fn(() => options.regular ?? true)
	};
	const handle: WorkerHealthFileHandle = {
		stat: vi.fn(async () => {
			operations.push('stat');
			if (options.statError !== undefined) throw options.statError;
			return stat;
		}),
		readFile: vi.fn(async (readOptions) => {
			operations.push(`read:${readOptions.encoding}`);
			if (options.readError !== undefined) throw options.readError;
			return raw;
		}),
		close: vi.fn(async () => {
			operations.push('close');
			if (options.closeError !== undefined) throw options.closeError;
		})
	};
	const filesystem: WorkerHealthFilesystem = {
		open: vi.fn(async (path, flags) => {
			operations.push(`open:${path}:${flags}`);
			if (options.openError !== undefined) throw options.openError;
			return handle;
		})
	};
	return { filesystem, handle, operations, raw, stat };
}

function checkOptions(
	filesystem: WorkerHealthFilesystem,
	stderr: (line: string) => void,
	overrides: Partial<WorkerHealthCheckOptions> = {}
): WorkerHealthCheckOptions {
	return {
		heartbeatFile: HEARTBEAT_PATH,
		configuredSlots: 1,
		maxAgeMs: 10_000,
		now: () => new Date(NOW),
		filesystem,
		stderr,
		...overrides
	};
}

async function expectUnhealthy(
	harness: ReturnType<typeof filesystemHarness>,
	overrides: Partial<WorkerHealthCheckOptions> = {}
): Promise<readonly string[]> {
	const lines: string[] = [];
	await expect(
		runWorkerHealthCheck(checkOptions(harness.filesystem, (line) => lines.push(line), overrides))
	).resolves.toBe(1);
	expect(lines).toEqual([UNHEALTHY_LINE]);
	const output = lines.join('\n');
	for (const privateValue of [
		HEARTBEAT_PATH,
		ERROR_CANARY,
		WORKER_CANARY,
		PROCESS_STARTED_AT,
		PUBLISHED_AT,
		harness.raw
	]) {
		expect(output).not.toContain(privateValue);
	}
	return lines;
}

describe('runWorkerHealthCheck', () => {
	const temporaryDirectories: string[] = [];

	afterEach(async () => {
		await Promise.all(
			temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
		);
	});

	it('exposes exactly the bounded stateless filesystem contract', () => {
		expectTypeOf<WorkerHealthFileStat>().toEqualTypeOf<{
			readonly size: number;
			isFile(): boolean;
		}>();
		expectTypeOf<WorkerHealthFileHandle>().toEqualTypeOf<{
			stat(): Promise<WorkerHealthFileStat>;
			readFile(options: { readonly encoding: 'utf8' }): Promise<string>;
			close(): Promise<void>;
		}>();
		expectTypeOf<WorkerHealthFilesystem>().toEqualTypeOf<{
			open(path: string, flags: 'r'): Promise<WorkerHealthFileHandle>;
		}>();
		expectTypeOf<WorkerHealthCheckOptions>().toEqualTypeOf<{
			readonly heartbeatFile: string;
			readonly configuredSlots: number;
			readonly maxAgeMs: number;
			readonly now?: () => Date;
			readonly filesystem?: WorkerHealthFilesystem;
			readonly stderr?: (line: string) => void;
		}>();
		expectTypeOf(runWorkerHealthCheck).toEqualTypeOf<
			(options: WorkerHealthCheckOptions) => Promise<0 | 1>
		>();
	});

	it('opens once read-only and validates one coherent handle snapshot', async () => {
		const harness = filesystemHarness();
		const lines: string[] = [];

		await expect(
			runWorkerHealthCheck(checkOptions(harness.filesystem, (line) => lines.push(line)))
		).resolves.toBe(0);

		expect(lines).toEqual([]);
		expect(harness.filesystem.open).toHaveBeenCalledTimes(1);
		expect(harness.filesystem.open).toHaveBeenCalledWith(HEARTBEAT_PATH, 'r');
		expect(harness.operations).toEqual([
			`open:${HEARTBEAT_PATH}:r`,
			'stat',
			'read:utf8',
			'close'
		]);
		expect(harness.handle.stat).toHaveBeenCalledTimes(1);
		expect(harness.handle.readFile).toHaveBeenCalledWith({ encoding: 'utf8' });
		expect(harness.handle.close).toHaveBeenCalledTimes(1);
	});

	it('snapshots file size once before validating the bounded metadata', async () => {
		const raw = encodeWorkerHeartbeat(heartbeatRecord());
		let sizeReads = 0;
		const stat = {
			get size() {
				sizeReads += 1;
				return sizeReads === 1 ? 65_537 : Buffer.byteLength(raw, 'utf8');
			},
			isFile: vi.fn(() => true)
		} satisfies WorkerHealthFileStat;
		const harness = filesystemHarness({ raw, stat });

		await expectUnhealthy(harness);
		expect(sizeReads).toBe(1);
		expect(stat.isFile).toHaveBeenCalledTimes(1);
		expect(harness.handle.readFile).not.toHaveBeenCalled();
		expect(harness.handle.close).toHaveBeenCalledTimes(1);
	});

	it('requires isFile to return the boolean true', async () => {
		const raw = encodeWorkerHeartbeat(heartbeatRecord());
		const isFile = vi.fn(() => 'yes');
		const stat = {
			size: Buffer.byteLength(raw, 'utf8'),
			isFile
		} as unknown as WorkerHealthFileStat;
		const harness = filesystemHarness({ raw, stat });

		await expectUnhealthy(harness);
		expect(isFile).toHaveBeenCalledTimes(1);
		expect(harness.handle.readFile).not.toHaveBeenCalled();
		expect(harness.handle.close).toHaveBeenCalledTimes(1);
	});

	it('uses the default Node adapter without reopening the path', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'worker-health-'));
		temporaryDirectories.push(directory);
		const path = join(directory, 'heartbeat');
		await writeFile(path, encodeWorkerHeartbeat(heartbeatRecord()), 'utf8');
		const lines: string[] = [];

		await expect(
			runWorkerHealthCheck({
				heartbeatFile: path,
				configuredSlots: 1,
				maxAgeMs: 10_000,
				now: () => new Date(NOW),
				stderr: (line) => lines.push(line)
			})
		).resolves.toBe(0);
		expect(lines).toEqual([]);
	});

	it.each([
		['missing target', { openError: new Error(`${ERROR_CANARY}: missing`) }],
		['inaccessible target', { openError: new Error(`${ERROR_CANARY}: denied`) }],
		['stat failure', { statError: new Error(`${ERROR_CANARY}: stat`) }],
		['read failure', { readError: new Error(`${ERROR_CANARY}: read`) }]
	] satisfies readonly (readonly [string, FilesystemHarnessOptions])[])(
		'fails closed without details for $name',
		async (_name, failure) => {
			const harness = filesystemHarness(failure);
			await expectUnhealthy(harness);
			if ('openError' in failure) expect(harness.handle.close).not.toHaveBeenCalled();
			else expect(harness.handle.close).toHaveBeenCalledTimes(1);
		}
	);

	it.each([
		['nonregular', { regular: false }],
		['empty', { size: 0 }],
		['oversized', { size: 65_537 }],
		['negative size', { size: -1 }],
		['fractional size', { size: 1.5 }],
		['nonfinite size', { size: Number.POSITIVE_INFINITY }]
	] satisfies readonly (readonly [string, FilesystemHarnessOptions])[])(
		'rejects a $name handle before reading content',
		async (_name, fileOptions) => {
			const harness = filesystemHarness(fileOptions);
			await expectUnhealthy(harness);
			expect(harness.handle.readFile).not.toHaveBeenCalled();
			expect(harness.handle.close).toHaveBeenCalledTimes(1);
		}
	);

	it('accepts an exact 65,536-byte canonical record boundary', async () => {
		const slots = Array.from({ length: 528 }, (_, slotId) => ({
			slotId,
			state: 'idle' as const,
			lastSuccessfulPollAt: '2026-08-26T12:00:01.000Z',
			lastProgressAt: '2026-08-26T12:00:04.000Z'
		}));
		const raw = encodeWorkerHeartbeat(
			heartbeatRecord({
				workerId: `w${'x'.repeat(14)}`,
				configuredSlots: slots.length,
				slots
			})
		);
		const harness = filesystemHarness({ raw });
		const lines: string[] = [];

		await expect(
			runWorkerHealthCheck(
				checkOptions(harness.filesystem, (line) => lines.push(line), {
					configuredSlots: slots.length
				})
			)
		).resolves.toBe(0);
		expect(Buffer.byteLength(raw, 'utf8')).toBe(65_536);
		expect(lines).toEqual([]);
	});

	it('rejects a short UTF-8 read before parsing', async () => {
		const raw = encodeWorkerHeartbeat(heartbeatRecord());
		const harness = filesystemHarness({ raw, size: Buffer.byteLength(raw, 'utf8') + 1 });

		await expectUnhealthy(harness);
		expect(harness.handle.readFile).toHaveBeenCalledTimes(1);
		expect(harness.handle.close).toHaveBeenCalledTimes(1);
	});

	it.each([
		['malformed', `{"workerId":"${WORKER_CANARY}"`],
		['noncanonical', `${encodeWorkerHeartbeat(heartbeatRecord())}\n`],
		[
			'wrong-slot',
			encodeWorkerHeartbeat(heartbeatRecord()).replace('"slotId":0', '"slotId":1')
		]
	])('rejects %s content without exposing it', async (_name, raw) => {
		await expectUnhealthy(filesystemHarness({ raw }));
	});

	it('rejects a configured-slot mismatch independently of the record', async () => {
		await expectUnhealthy(filesystemHarness(), { configuredSlots: 2 });
	});

	it('rejects stale publication and slot progress', async () => {
		const old = '2026-08-26T11:59:00.000Z';
		const raw = encodeWorkerHeartbeat(
			heartbeatRecord({
				processStartedAt: old,
				publishedAt: old,
				slots: [
					{
						slotId: 0,
						state: 'idle',
						lastSuccessfulPollAt: old,
						lastProgressAt: old
					}
				]
			})
		);
		await expectUnhealthy(filesystemHarness({ raw }));
	});

	it('rejects timestamps beyond the future tolerance', async () => {
		const future = '2026-08-26T12:00:11.001Z';
		const raw = encodeWorkerHeartbeat(
			heartbeatRecord({
				processStartedAt: future,
				publishedAt: future,
				slots: [
					{
						slotId: 0,
						state: 'polling',
						lastSuccessfulPollAt: future,
						lastProgressAt: future
					}
				]
			})
		);
		await expectUnhealthy(filesystemHarness({ raw }));
	});

	it.each([
		['zero slots', { configuredSlots: 0 }],
		['fractional slots', { configuredSlots: 1.5 }],
		['zero maximum age', { maxAgeMs: 0 }],
		['fractional maximum age', { maxAgeMs: 1.5 }],
		['invalid clock', { now: () => new Date(Number.NaN) }],
		['throwing clock', { now: () => { throw new Error(ERROR_CANARY); } }]
	] satisfies readonly (readonly [string, Partial<WorkerHealthCheckOptions>])[])(
		'fails closed for independently supplied $name',
		async (_name, overrides) => {
			await expectUnhealthy(filesystemHarness(), overrides);
		}
	);

	it('treats close failure as unhealthy after otherwise valid work', async () => {
		const harness = filesystemHarness({ closeError: new Error(`${ERROR_CANARY}: close`) });
		await expectUnhealthy(harness);
		expect(harness.operations.at(-1)).toBe('close');
	});

	it('closes once and emits once when an operation and close both fail', async () => {
		const harness = filesystemHarness({
			readError: new Error(`${ERROR_CANARY}: primary`),
			closeError: new Error(`${ERROR_CANARY}: close`)
		});
		const lines = await expectUnhealthy(harness);

		expect(harness.operations).toEqual([
			`open:${HEARTBEAT_PATH}:r`,
			'stat',
			'read:utf8',
			'close'
		]);
		expect(harness.handle.close).toHaveBeenCalledTimes(1);
		expect(lines).toHaveLength(1);
	});

	it('never throws even if the injected stderr sink fails', async () => {
		const harness = filesystemHarness({ openError: new Error(ERROR_CANARY) });
		await expect(
			runWorkerHealthCheck(
				checkOptions(harness.filesystem, () => {
					throw new Error(`${ERROR_CANARY}: stderr`);
				})
			)
		).resolves.toBe(1);
	});

	it('awaits and absorbs an asynchronously rejected stderr sink', async () => {
		const harness = filesystemHarness({ openError: new Error(ERROR_CANARY) });
		const lines: string[] = [];
		const unhandled: unknown[] = [];
		let rejectSink!: (reason: unknown) => void;
		let returnedSink: Promise<void> | undefined;
		let rejected = false;
		const sinkGate = new Promise<void>((_resolve, reject) => {
			rejectSink = reject;
		});
		const onUnhandled = (reason: unknown): void => {
			unhandled.push(reason);
		};
		process.on('unhandledRejection', onUnhandled);

		try {
			const run = runWorkerHealthCheck(
				checkOptions(harness.filesystem, (line) => {
					lines.push(line);
					returnedSink = sinkGate.then(() => undefined);
					return returnedSink;
				})
			);
			let settled = false;
			void run.then(
				() => { settled = true; },
				() => { settled = true; }
			);
			await Promise.resolve();
			await Promise.resolve();
			expect(settled).toBe(false);

			rejectSink(new Error(ERROR_CANARY));
			rejected = true;
			await expect(run).resolves.toBe(1);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(lines).toEqual([UNHEALTHY_LINE]);
			expect(lines.join('\n')).not.toContain(ERROR_CANARY);
			expect(unhandled).toEqual([]);
		} finally {
			if (!rejected) rejectSink(new Error(ERROR_CANARY));
			await returnedSink?.catch(() => undefined);
			process.off('unhandledRejection', onUnhandled);
		}
	});

	it('maps CLI configuration failures to the same fixed private result', () => {
		const result = spawnSync(
			process.execPath,
			['--import', 'tsx', 'src/worker-health.ts'],
			{
				cwd: process.cwd(),
				encoding: 'utf8',
				env: {
					PATH: process.env.PATH,
					SystemRoot: process.env.SystemRoot,
					TEMP: process.env.TEMP,
					TMP: process.env.TMP,
					WORKER_READY_FILE: HEARTBEAT_PATH,
					WORKER_CONCURRENCY: ERROR_CANARY,
					JOB_POLL_INTERVAL_MS: '1000',
					JOB_LEASE_MS: '30000'
				}
			}
		);

		expect(result.status).toBe(1);
		expect(result.signal).toBeNull();
		expect(result.stdout).toBe('');
		expect(result.stderr.replace(/\r\n?/gu, '\n')).toBe(`${UNHEALTHY_LINE}\n`);
		expect(result.stderr).not.toContain(ERROR_CANARY);
		expect(result.stderr).not.toContain(HEARTBEAT_PATH);
	});

	it('maps CLI heartbeat failures to the same fixed private result', () => {
		const result = spawnSync(
			process.execPath,
			['--import', 'tsx', 'src/worker-health.ts'],
			{
				cwd: process.cwd(),
				encoding: 'utf8',
				env: {
					PATH: process.env.PATH,
					SystemRoot: process.env.SystemRoot,
					TEMP: process.env.TEMP,
					TMP: process.env.TMP,
					WORKER_READY_FILE: HEARTBEAT_PATH,
					WORKER_CONCURRENCY: '1',
					JOB_POLL_INTERVAL_MS: '1000',
					JOB_LEASE_MS: '30000'
				}
			}
		);

		expect(result.status).toBe(1);
		expect(result.signal).toBeNull();
		expect(result.stdout).toBe('');
		expect(result.stderr.replace(/\r\n?/gu, '\n')).toBe(`${UNHEALTHY_LINE}\n`);
		expect(result.stderr).not.toContain(HEARTBEAT_PATH);
	});
});
