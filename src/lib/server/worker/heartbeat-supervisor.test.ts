import { describe, expect, it, vi } from 'vitest';

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import {
	open as openFile,
	mkdtemp,
	readFile,
	rename as renameFile,
	rm as removeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorkerSlotProgressEvent } from '../jobs/runner-observer';
import { parseWorkerHeartbeat } from './heartbeat-contract';
import {
	createWorkerHeartbeatSupervisor,
	WorkerHeartbeatPublicationError,
	type WorkerHeartbeatFileHandle,
	type WorkerHeartbeatFilesystem
} from './heartbeat-supervisor';

const PROCESS_STARTED_MS = Date.parse('2026-08-26T12:00:00.000Z');

interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

class MemoryFilesystem implements WorkerHeartbeatFilesystem {
	readonly files = new Map<string, string>();
	readonly operations: string[] = [];
	readonly publications: string[] = [];
	readonly #publicationWaiters = new Map<number, Deferred<void>>();
	readonly #operationWaiters = new Map<number, Deferred<void>>();
	readonly failures = new Map<'open' | 'write' | 'sync' | 'close' | 'rename' | 'rm', unknown>();
	readonly renameFailures: unknown[] = [];
	readonly rmFailures = new Map<string, Error[]>();
	renameGate: Deferred<void> | undefined;
	openHandles = 0;
	maximumOpenHandles = 0;

	#recordOperation(value: string): void {
		this.operations.push(value);
		this.#operationWaiters.get(this.operations.length)?.resolve();
	}

	#fail(operation: 'open' | 'write' | 'sync' | 'close' | 'rename' | 'rm'): void {
		if (this.failures.has(operation)) throw this.failures.get(operation);
	}

	async open(path: string, flags: 'wx', mode: number): Promise<WorkerHeartbeatFileHandle> {
		this.#recordOperation(`open:${path}:${flags}:${mode.toString(8)}`);
		this.#fail('open');
		if (this.files.has(path)) throw new Error('exclusive open failed');
		this.files.set(path, '');
		let closed = false;
		this.openHandles += 1;
		this.maximumOpenHandles = Math.max(this.maximumOpenHandles, this.openHandles);
		return {
			writeFile: async (value, options) => {
				if (closed) throw new Error('write after close');
				this.#recordOperation(`write:${path}:${options.encoding}`);
				this.#fail('write');
				this.files.set(path, value);
			},
			sync: async () => {
				if (closed) throw new Error('sync after close');
				this.#recordOperation(`sync:${path}`);
				this.#fail('sync');
			},
			close: async () => {
				if (closed) throw new Error('duplicate close');
				closed = true;
				this.openHandles -= 1;
				this.#recordOperation(`close:${path}`);
				this.#fail('close');
			}
		};
	}

	async rename(from: string, to: string): Promise<void> {
		this.#recordOperation(`rename:${from}:${to}`);
		if (this.renameGate !== undefined) await this.renameGate.promise;
		if (this.renameFailures.length > 0) throw this.renameFailures.shift();
		this.#fail('rename');
		const value = this.files.get(from);
		if (value === undefined) throw new Error('missing rename source');
		this.files.delete(from);
		this.files.set(to, value);
		this.publications.push(value);
		this.#publicationWaiters.get(this.publications.length)?.resolve();
	}

	async rm(path: string, options: { readonly force: true }): Promise<void> {
		this.#recordOperation(`rm:${path}:${String(options.force)}`);
		const pathFailures = this.rmFailures.get(path);
		const pathFailure = pathFailures?.shift();
		if (pathFailure !== undefined) throw pathFailure;
		this.#fail('rm');
		this.files.delete(path);
	}

	waitForOperation(count: number): Promise<void> {
		if (this.operations.length >= count) return Promise.resolve();
		let waiter = this.#operationWaiters.get(count);
		if (waiter === undefined) {
			waiter = deferred<void>();
			this.#operationWaiters.set(count, waiter);
		}
		return waiter.promise;
	}

	waitForPublication(count: number): Promise<void> {
		if (this.publications.length >= count) return Promise.resolve();
		let waiter = this.#publicationWaiters.get(count);
		if (waiter === undefined) {
			waiter = deferred<void>();
			this.#publicationWaiters.set(count, waiter);
		}
		return waiter.promise;
	}

	record(index = this.publications.length - 1) {
		const publication = this.publications[index];
		if (publication === undefined) throw new Error('expected a heartbeat publication');
		return parseWorkerHeartbeat(publication);
	}
}

function controlledSleep() {
	const calls: Array<{
		readonly milliseconds: number;
		readonly signal: AbortSignal;
		readonly gate: Deferred<void>;
	}> = [];
	const callWaiters = new Map<number, Deferred<void>>();
	return {
		calls,
		sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
			const gate = deferred<void>();
			calls.push({ milliseconds, signal, gate });
			callWaiters.get(calls.length)?.resolve();
			if (signal.aborted) gate.resolve();
			else signal.addEventListener('abort', () => gate.resolve(), { once: true });
			return gate.promise;
		},
		waitForCall(count: number): Promise<void> {
			if (calls.length >= count) return Promise.resolve();
			let waiter = callWaiters.get(count);
			if (waiter === undefined) {
				waiter = deferred<void>();
				callWaiters.set(count, waiter);
			}
			return waiter.promise;
		},
		release(index: number): void {
			const call = calls[index];
			if (call === undefined) throw new Error(`missing sleep call ${index}`);
			call.gate.resolve();
		}
	};
}

function createHarness(
	configuredSlots = 1,
	options: {
		readonly intervalMs?: number;
		readonly monotonicNow?: () => number;
		readonly retryWait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
	} = {}
) {
	let nowMs = PROCESS_STARTED_MS;
	const filesystem = new MemoryFilesystem();
	const sleeper = controlledSleep();
	const supervisor = createWorkerHeartbeatSupervisor({
		workerId: 'worker:heartbeat-test',
		configuredSlots,
		heartbeatFile: 'heartbeat.json',
		intervalMs: options.intervalMs ?? 5_000,
		processStartedAt: new Date(PROCESS_STARTED_MS),
		now: () => new Date(nowMs),
		sleep: sleeper.sleep,
		...(options.monotonicNow === undefined
			? {}
			: { monotonicNow: options.monotonicNow }),
		...(options.retryWait === undefined ? {} : { retryWait: options.retryWait }),
		filesystem
	});
	return {
		filesystem,
		sleeper,
		supervisor,
		setNow(value: number) {
			nowMs = value;
		}
	};
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function capturePublicationFailure(
	promise: Promise<unknown>
): Promise<WorkerHeartbeatPublicationError> {
	try {
		await promise;
		throw new Error('expected a worker heartbeat publication failure');
	} catch (error: unknown) {
		expect(error).toBeInstanceOf(WorkerHeartbeatPublicationError);
		return error as WorkerHeartbeatPublicationError;
	}
}

function expectFixedPublicationFailure(
	failure: WorkerHeartbeatPublicationError,
	cause: unknown
): void {
	expect(failure.message).toBe('Worker heartbeat publication failed');
	expect(failure.message).not.toContain(String(cause));
	expect(failure.cause).toBe(cause);
}

function errorWithCode(code: string): Error & { readonly code: string } {
	return Object.assign(new Error(`filesystem ${code}`), { code });
}

async function reachSecondPublication(input: {
	readonly harness: ReturnType<typeof createHarness>;
	readonly controller: AbortController;
	readonly run: Promise<void>;
}): Promise<void> {
	await input.harness.sleeper.waitForCall(1);
	input.harness.setNow(PROCESS_STARTED_MS + 1_000);
	input.harness.sleeper.release(0);
	const published = await Promise.race([
		input.harness.filesystem.waitForPublication(2).then(() => true),
		input.run.then(() => false, () => false)
	]);
	expect(published).toBe(true);
	input.controller.abort();
	await expect(input.run).resolves.toBeUndefined();
}

describe('worker heartbeat supervisor state and readiness', () => {
	it('publishes nothing until every slot has successfully polled, then publishes immediately', async () => {
		const harness = createHarness(3);
		await harness.supervisor.prepare();
		const controller = new AbortController();
		const run = harness.supervisor.run(controller.signal);

		harness.supervisor.reportSlotProgress({ type: 'polling', slotId: 2 });
		harness.supervisor.reportSlotProgress({ type: 'polling', slotId: 2 });
		harness.setNow(PROCESS_STARTED_MS + 1_000);
		harness.supervisor.reportSlotProgress({
			type: 'poll_succeeded',
			slotId: 2,
			claimed: false
		});
		harness.setNow(PROCESS_STARTED_MS + 2_000);
		harness.supervisor.reportSlotProgress({
			type: 'poll_succeeded',
			slotId: 0,
			claimed: true
		});
		await flushMicrotasks();

		expect(harness.filesystem.publications).toEqual([]);
		expect(harness.filesystem.files.has('heartbeat.json')).toBe(false);

		harness.setNow(PROCESS_STARTED_MS + 3_000);
		harness.supervisor.reportSlotProgress({
			type: 'poll_succeeded',
			slotId: 1,
			claimed: false
		});
		await harness.supervisor.firstHealthyPublication;

		expect(harness.filesystem.record()).toEqual({
			version: 1,
			workerId: 'worker:heartbeat-test',
			processStartedAt: '2026-08-26T12:00:00.000Z',
			publishedAt: '2026-08-26T12:00:03.000Z',
			sequence: 1,
			configuredSlots: 3,
			slots: [
				{
					slotId: 0,
					state: 'handling',
					lastSuccessfulPollAt: '2026-08-26T12:00:02.000Z',
					lastProgressAt: '2026-08-26T12:00:02.000Z'
				},
				{
					slotId: 1,
					state: 'idle',
					lastSuccessfulPollAt: '2026-08-26T12:00:03.000Z',
					lastProgressAt: '2026-08-26T12:00:03.000Z'
				},
				{
					slotId: 2,
					state: 'idle',
					lastSuccessfulPollAt: '2026-08-26T12:00:01.000Z',
					lastProgressAt: '2026-08-26T12:00:01.000Z'
				}
			]
		});

		controller.abort();
		await run;
	});

	it('implements every allowed transition and never lets publication refresh slot progress', async () => {
		const harness = createHarness();
		await harness.supervisor.prepare();
		const controller = new AbortController();
		const run = harness.supervisor.run(controller.signal);

		harness.supervisor.reportSlotProgress({ type: 'polling', slotId: 0 });
		harness.supervisor.reportSlotProgress({ type: 'polling', slotId: 0 });
		harness.setNow(PROCESS_STARTED_MS + 100);
		harness.supervisor.reportSlotProgress({
			type: 'poll_succeeded',
			slotId: 0,
			claimed: true
		});
		await harness.supervisor.firstHealthyPublication;
		expect(harness.filesystem.record().slots[0]).toMatchObject({
			state: 'handling',
			lastSuccessfulPollAt: '2026-08-26T12:00:00.100Z',
			lastProgressAt: '2026-08-26T12:00:00.100Z'
		});

		harness.setNow(PROCESS_STARTED_MS + 200);
		harness.supervisor.reportSlotProgress({ type: 'lease_renewed', slotId: 0 });
		harness.setNow(PROCESS_STARTED_MS + 300);
		await harness.sleeper.waitForCall(1);
		harness.sleeper.release(0);
		await harness.filesystem.waitForPublication(2);
		expect(harness.filesystem.record()).toMatchObject({
			publishedAt: '2026-08-26T12:00:00.300Z',
			sequence: 2,
			slots: [
				{
					state: 'handling',
					lastSuccessfulPollAt: '2026-08-26T12:00:00.100Z',
					lastProgressAt: '2026-08-26T12:00:00.200Z'
				}
			]
		});

		harness.setNow(PROCESS_STARTED_MS + 400);
		harness.supervisor.reportSlotProgress({ type: 'terminal_settled', slotId: 0 });
		harness.supervisor.reportSlotProgress({ type: 'polling', slotId: 0 });
		harness.setNow(PROCESS_STARTED_MS + 500);
		harness.supervisor.reportSlotProgress({
			type: 'poll_succeeded',
			slotId: 0,
			claimed: false
		});
		harness.setNow(PROCESS_STARTED_MS + 600);
		await harness.sleeper.waitForCall(2);
		harness.sleeper.release(1);
		await harness.filesystem.waitForPublication(3);
		expect(harness.filesystem.record().slots[0]).toEqual({
			slotId: 0,
			state: 'idle',
			lastSuccessfulPollAt: '2026-08-26T12:00:00.500Z',
			lastProgressAt: '2026-08-26T12:00:00.500Z'
		});

		harness.setNow(PROCESS_STARTED_MS + 700);
		harness.supervisor.reportSlotProgress({ type: 'polling', slotId: 0 });
		harness.supervisor.reportSlotProgress({
			type: 'poll_succeeded',
			slotId: 0,
			claimed: true
		});
		harness.setNow(PROCESS_STARTED_MS + 800);
		harness.supervisor.reportSlotProgress({ type: 'lease_lost', slotId: 0 });
		harness.setNow(PROCESS_STARTED_MS + 900);
		await harness.sleeper.waitForCall(3);
		harness.sleeper.release(2);
		await harness.filesystem.waitForPublication(4);
		expect(harness.filesystem.record().slots[0]).toEqual({
			slotId: 0,
			state: 'idle',
			lastSuccessfulPollAt: '2026-08-26T12:00:00.700Z',
			lastProgressAt: '2026-08-26T12:00:00.700Z'
		});

		controller.abort();
		await run;
	});

	it('rejects every event from an invalid prior state without creating evidence', async () => {
		const harness = createHarness();
		await harness.supervisor.prepare();
		const controller = new AbortController();
		const run = harness.supervisor.run(controller.signal);

		for (const event of [
			{ type: 'lease_renewed', slotId: 0 },
			{ type: 'terminal_settled', slotId: 0 },
			{ type: 'lease_lost', slotId: 0 }
		] as const) {
			expect(() => harness.supervisor.reportSlotProgress(event)).toThrow();
		}

		harness.supervisor.reportSlotProgress({
			type: 'poll_succeeded',
			slotId: 0,
			claimed: false
		});
		await harness.supervisor.firstHealthyPublication;
		expect(() =>
			harness.supervisor.reportSlotProgress({
				type: 'poll_succeeded',
				slotId: 0,
				claimed: false
			})
		).toThrow();

		harness.supervisor.reportSlotProgress({ type: 'polling', slotId: 0 });
		harness.supervisor.reportSlotProgress({
			type: 'poll_succeeded',
			slotId: 0,
			claimed: true
		});
		expect(() =>
			harness.supervisor.reportSlotProgress({ type: 'polling', slotId: 0 })
		).toThrow();

		controller.abort();
		await run;
		expect(harness.filesystem.publications).toHaveLength(1);
	});

	it.each([0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER, 2_147_483_648])(
		'rejects invalid configuredSlots %p without touching the filesystem',
		(configuredSlots) => {
			const filesystem = new MemoryFilesystem();
			expect(() =>
				createWorkerHeartbeatSupervisor({
					workerId: 'worker:test',
					configuredSlots,
					heartbeatFile: 'heartbeat.json',
					intervalMs: 5_000,
					processStartedAt: new Date(PROCESS_STARTED_MS),
					filesystem
				})
			).toThrow();
			expect(filesystem.operations).toEqual([]);
		}
	);

	it('rejects unknown slots, malformed exact events, time regression, and nonfinite time', () => {
		const harness = createHarness(2);
		for (const event of [
			{ type: 'polling', slotId: -1 },
			{ type: 'polling', slotId: 2 },
			{ type: 'polling', slotId: 0, extra: true },
			{ type: 'poll_succeeded', slotId: 0 },
			{ type: 'poll_succeeded', slotId: 0, claimed: 'yes' },
			{ type: 'unknown', slotId: 0 }
		]) {
			expect(() =>
				harness.supervisor.reportSlotProgress(event as unknown as WorkerSlotProgressEvent)
			).toThrow();
		}

		harness.setNow(PROCESS_STARTED_MS + 100);
		harness.supervisor.reportSlotProgress({ type: 'polling', slotId: 0 });
		harness.setNow(PROCESS_STARTED_MS + 99);
		expect(() =>
			harness.supervisor.reportSlotProgress({ type: 'polling', slotId: 0 })
		).toThrow();

		harness.setNow(Number.NaN);
		expect(() =>
			harness.supervisor.reportSlotProgress({ type: 'polling', slotId: 0 })
		).toThrow();
	});

	it('accepts only plain exact enumerable event data without invoking accessors', () => {
		const harness = createHarness();
		const customPrototype = Object.assign(Object.create({ inherited: true }) as object, {
			type: 'polling',
			slotId: 0
		});
		const nonenumerable = {};
		Object.defineProperties(nonenumerable, {
			type: { enumerable: true, value: 'polling' },
			slotId: { enumerable: false, value: 0 }
		});
		let accessorReads = 0;
		const accessor = {
			get type() {
				accessorReads += 1;
				return 'polling';
			},
			slotId: 0
		};

		for (const event of [customPrototype, nonenumerable, accessor]) {
			expect(() =>
				harness.supervisor.reportSlotProgress(event as WorkerSlotProgressEvent)
			).toThrow();
		}
		expect(accessorReads).toBe(0);
	});

	it('refuses an unprepared run, a second run, starts after sealing, and reports after sealing', async () => {
		const harness = createHarness();
		const controller = new AbortController();
		await expect(harness.supervisor.run(controller.signal)).rejects.toThrow();
		await harness.supervisor.prepare();
		controller.abort();
		await harness.supervisor.run(controller.signal);
		await expect(harness.supervisor.run(controller.signal)).rejects.toThrow();

		harness.supervisor.sealProgress();
		harness.supervisor.sealProgress();
		expect(() =>
			harness.supervisor.reportSlotProgress({ type: 'polling', slotId: 0 })
		).toThrow();
		const sealed = createHarness();
		await sealed.supervisor.prepare();
		sealed.supervisor.sealProgress();
		await expect(sealed.supervisor.run(controller.signal)).rejects.toThrow();
	});
});

async function promiseState(promise: Promise<unknown>): Promise<'pending' | 'resolved' | 'rejected'> {
	let state: 'pending' | 'resolved' | 'rejected' = 'pending';
	void promise.then(
		() => {
			state = 'resolved';
		},
		() => {
			state = 'rejected';
		}
	);
	await flushMicrotasks();
	return state;
}

type PublicationFailurePoint = 'open' | 'write' | 'sync' | 'close' | 'rename';

const failureOperations: Readonly<Record<PublicationFailurePoint, readonly string[]>> = {
	open: ['open:heartbeat.json.tmp:wx:600', 'rm:heartbeat.json.tmp:true'],
	write: [
		'open:heartbeat.json.tmp:wx:600',
		'write:heartbeat.json.tmp:utf8',
		'close:heartbeat.json.tmp',
		'rm:heartbeat.json.tmp:true'
	],
	sync: [
		'open:heartbeat.json.tmp:wx:600',
		'write:heartbeat.json.tmp:utf8',
		'sync:heartbeat.json.tmp',
		'close:heartbeat.json.tmp',
		'rm:heartbeat.json.tmp:true'
	],
	close: [
		'open:heartbeat.json.tmp:wx:600',
		'write:heartbeat.json.tmp:utf8',
		'sync:heartbeat.json.tmp',
		'close:heartbeat.json.tmp',
		'rm:heartbeat.json.tmp:true'
	],
	rename: [
		'open:heartbeat.json.tmp:wx:600',
		'write:heartbeat.json.tmp:utf8',
		'sync:heartbeat.json.tmp',
		'close:heartbeat.json.tmp',
		'rename:heartbeat.json.tmp:heartbeat.json',
		'rm:heartbeat.json.tmp:true'
	]
};

describe('worker heartbeat supervisor atomic filesystem and lifecycle', () => {
	it('does not publish when readiness predates a pre-aborted run signal', async () => {
		const harness = createHarness();
		harness.supervisor.reportSlotProgress({
			type: 'poll_succeeded',
			slotId: 0,
			claimed: false
		});
		await harness.supervisor.prepare();
		const controller = new AbortController();
		controller.abort();

		await expect(harness.supervisor.run(controller.signal)).resolves.toBeUndefined();

		expect(harness.filesystem.publications).toEqual([]);
		expect(await promiseState(harness.supervisor.firstHealthyPublication)).toBe('pending');
	});

	it('rechecks abort after final readiness resolves but before the run continuation', async () => {
		const harness = createHarness();
		await harness.supervisor.prepare();
		const controller = new AbortController();
		const run = harness.supervisor.run(controller.signal);

		harness.supervisor.reportSlotProgress({
			type: 'poll_succeeded',
			slotId: 0,
			claimed: false
		});
		queueMicrotask(() => controller.abort());
		await expect(run).resolves.toBeUndefined();

		expect(harness.filesystem.publications).toEqual([]);
		expect(await promiseState(harness.supervisor.firstHealthyPublication)).toBe('pending');
	});

	it('does not publish another interval after progress is sealed while sleeping', async () => {
		const harness = createHarness();
		await harness.supervisor.prepare();
		const controller = new AbortController();
		const run = harness.supervisor.run(controller.signal);
		harness.supervisor.reportSlotProgress({
			type: 'poll_succeeded',
			slotId: 0,
			claimed: false
		});
		await harness.supervisor.firstHealthyPublication;
		await harness.sleeper.waitForCall(1);

		harness.supervisor.sealProgress();
		harness.sleeper.release(0);
		await flushMicrotasks();
		await flushMicrotasks();

		expect(harness.filesystem.publications).toHaveLength(1);
		controller.abort();
		await run;
	});

	it('prepare attempts both owned paths, preserves primary failure, and retries after rejection', async () => {
		const harness = createHarness();
		const targetFailure = new Error('target-remove-primary');
		const tempFailure = new Error('temp-remove-secondary');
		harness.filesystem.files.set('heartbeat.json', 'stale-target');
		harness.filesystem.files.set('heartbeat.json.tmp', 'stale-temp');
		harness.filesystem.files.set('neighbor', 'preserved');
		harness.filesystem.rmFailures.set('heartbeat.json', [targetFailure]);
		harness.filesystem.rmFailures.set('heartbeat.json.tmp', [tempFailure]);

		const preparationFailure = await capturePublicationFailure(
			harness.supervisor.prepare()
		);
		expectFixedPublicationFailure(preparationFailure, targetFailure);
		expect(harness.filesystem.operations).toEqual([
			'rm:heartbeat.json:true',
			'rm:heartbeat.json.tmp:true'
		]);

		await expect(harness.supervisor.prepare()).resolves.toBeUndefined();
		expect(harness.filesystem.operations).toEqual([
			'rm:heartbeat.json:true',
			'rm:heartbeat.json.tmp:true',
			'rm:heartbeat.json:true',
			'rm:heartbeat.json.tmp:true'
		]);
		expect([...harness.filesystem.files]).toEqual([['neighbor', 'preserved']]);
	});

	it('removeEvidence attempts both owned paths, preserves primary failure, and retries rejection', async () => {
		const harness = createHarness();
		await harness.supervisor.prepare();
		const targetFailure = new Error('target-remove-primary');
		const tempFailure = new Error('temp-remove-secondary');
		harness.filesystem.files.set('heartbeat.json', 'current-target');
		harness.filesystem.files.set('heartbeat.json.tmp', 'current-temp');
		harness.filesystem.files.set('neighbor', 'preserved');
		harness.filesystem.rmFailures.set('heartbeat.json', [targetFailure]);
		harness.filesystem.rmFailures.set('heartbeat.json.tmp', [tempFailure]);
		const beforeRemoval = harness.filesystem.operations.length;

		await expect(harness.supervisor.removeEvidence()).rejects.toBe(targetFailure);
		expect(harness.filesystem.operations.slice(beforeRemoval)).toEqual([
			'rm:heartbeat.json:true',
			'rm:heartbeat.json.tmp:true'
		]);

		await expect(harness.supervisor.removeEvidence()).resolves.toBeUndefined();
		expect(harness.filesystem.operations.slice(beforeRemoval)).toEqual([
			'rm:heartbeat.json:true',
			'rm:heartbeat.json.tmp:true',
			'rm:heartbeat.json:true',
			'rm:heartbeat.json.tmp:true'
		]);
		expect([...harness.filesystem.files]).toEqual([['neighbor', 'preserved']]);
	});

	it('snapshots constructor identity, timing, and owned paths before asynchronous use', async () => {
		let nowMs = PROCESS_STARTED_MS;
		const filesystem = new MemoryFilesystem();
		const sleeper = controlledSleep();
		const options = {
			workerId: 'worker:snapshot',
			configuredSlots: 1,
			heartbeatFile: 'heartbeat.json',
			intervalMs: 5_000,
			processStartedAt: new Date(PROCESS_STARTED_MS),
			now: () => new Date(nowMs),
			sleep: sleeper.sleep,
			filesystem
		};
		const supervisor = createWorkerHeartbeatSupervisor(options);
		options.workerId = 'invalid mutated worker';
		options.configuredSlots = 2;
		options.heartbeatFile = 'mutated.json';
		options.intervalMs = 1;
		options.processStartedAt.setTime(PROCESS_STARTED_MS + 60_000);

		await supervisor.prepare();
		const controller = new AbortController();
		const run = supervisor.run(controller.signal);
		supervisor.reportSlotProgress({ type: 'poll_succeeded', slotId: 0, claimed: false });
		await supervisor.firstHealthyPublication;
		await sleeper.waitForCall(1);

		expect(filesystem.record()).toMatchObject({
			workerId: 'worker:snapshot',
			configuredSlots: 1,
			processStartedAt: '2026-08-26T12:00:00.000Z'
		});
		expect(filesystem.files.has('heartbeat.json')).toBe(true);
		expect(filesystem.files.has('mutated.json')).toBe(false);
		expect(sleeper.calls[0]?.milliseconds).toBe(5_000);

		nowMs += 1;
		controller.abort();
		await run;
	});

	it('prepares only the exact target and deterministic sibling, idempotently, before run', async () => {
		const harness = createHarness();
		harness.filesystem.files.set('heartbeat.json', 'stale-target');
		harness.filesystem.files.set('heartbeat.json.tmp', 'stale-temp');
		harness.filesystem.files.set('heartbeat.json.other', 'neighbor');

		await Promise.all([harness.supervisor.prepare(), harness.supervisor.prepare()]);
		await harness.supervisor.prepare();

		expect(harness.filesystem.operations).toEqual([
			'rm:heartbeat.json:true',
			'rm:heartbeat.json.tmp:true'
		]);
		expect([...harness.filesystem.files]).toEqual([['heartbeat.json.other', 'neighbor']]);
	});

	it('uses the exact serialized exclusive-create, write, sync, close, and rename sequence', async () => {
		const harness = createHarness();
		await harness.supervisor.prepare();
		const controller = new AbortController();
		const run = harness.supervisor.run(controller.signal);
		harness.supervisor.reportSlotProgress({
			type: 'poll_succeeded',
			slotId: 0,
			claimed: false
		});
		await harness.supervisor.firstHealthyPublication;

		expect(harness.filesystem.operations).toEqual([
			'rm:heartbeat.json:true',
			'rm:heartbeat.json.tmp:true',
			'open:heartbeat.json.tmp:wx:600',
			'write:heartbeat.json.tmp:utf8',
			'sync:heartbeat.json.tmp',
			'close:heartbeat.json.tmp',
			'rename:heartbeat.json.tmp:heartbeat.json'
		]);
		expect(harness.filesystem.openHandles).toBe(0);
		expect(harness.filesystem.maximumOpenHandles).toBe(1);
		expect(harness.filesystem.files.has('heartbeat.json.tmp')).toBe(false);
		expect(harness.filesystem.record().sequence).toBe(1);

		await harness.sleeper.waitForCall(1);
		harness.setNow(PROCESS_STARTED_MS + 1_000);
		harness.sleeper.release(0);
		await harness.filesystem.waitForPublication(2);
		expect(harness.filesystem.record().sequence).toBe(2);
		expect(harness.filesystem.maximumOpenHandles).toBe(1);
		expect(harness.filesystem.openHandles).toBe(0);

		controller.abort();
		await run;
	});

	it('resolves firstHealthyPublication only after the atomic rename completes', async () => {
		const harness = createHarness();
		await harness.supervisor.prepare();
		const renameGate = deferred<void>();
		harness.filesystem.renameGate = renameGate;
		const controller = new AbortController();
		const run = harness.supervisor.run(controller.signal);
		harness.supervisor.reportSlotProgress({
			type: 'poll_succeeded',
			slotId: 0,
			claimed: false
		});
		await harness.filesystem.waitForOperation(7);

		expect(await promiseState(harness.supervisor.firstHealthyPublication)).toBe('pending');
		expect(harness.filesystem.files.has('heartbeat.json')).toBe(false);
		expect(harness.filesystem.files.has('heartbeat.json.tmp')).toBe(true);
		expect(harness.filesystem.openHandles).toBe(0);

		renameGate.resolve();
		await harness.supervisor.firstHealthyPublication;
		expect(harness.filesystem.files.has('heartbeat.json')).toBe(true);
		controller.abort();
		await run;
	});

	it.each(['EPERM', 'EACCES', 'EBUSY'])(
		'retries only the same final rename for transient %s contention',
		async (code) => {
			let monotonicMilliseconds = 0;
			const retryWait = vi.fn(async (milliseconds: number, signal: AbortSignal) => {
				expect(signal.aborted).toBe(false);
				monotonicMilliseconds += milliseconds;
			});
			const harness = createHarness(1, {
				monotonicNow: () => monotonicMilliseconds,
				retryWait
			});
			await harness.supervisor.prepare();
			const controller = new AbortController();
			const run = harness.supervisor.run(controller.signal);
			harness.supervisor.reportSlotProgress({
				type: 'poll_succeeded',
				slotId: 0,
				claimed: false
			});
			await harness.supervisor.firstHealthyPublication;
			const priorTarget = harness.filesystem.files.get('heartbeat.json');
			const beforeSecondPublication = harness.filesystem.operations.length;
			harness.filesystem.renameFailures.push(errorWithCode(code));
			await reachSecondPublication({ harness, controller, run });

			expect(retryWait).toHaveBeenCalledOnce();
			expect(retryWait).toHaveBeenCalledWith(10, controller.signal);
			expect(harness.filesystem.operations.slice(beforeSecondPublication))
				.toEqual([
					'open:heartbeat.json.tmp:wx:600',
					'write:heartbeat.json.tmp:utf8',
					'sync:heartbeat.json.tmp',
					'close:heartbeat.json.tmp',
					'rename:heartbeat.json.tmp:heartbeat.json',
					'rename:heartbeat.json.tmp:heartbeat.json'
				]);
			expect(harness.filesystem.record().sequence).toBe(2);
			expect(harness.filesystem.files.get('heartbeat.json')).not.toBe(priorTarget);
			expect(harness.filesystem.files.has('heartbeat.json.tmp')).toBe(false);
		}
	);

	it('keeps the previous target coherent while a transient rename waits', async () => {
		let monotonicMilliseconds = 0;
		const retryEntered = deferred<void>();
		const releaseRetry = deferred<void>();
		const retryWait = vi.fn(async (milliseconds: number) => {
			retryEntered.resolve();
			await releaseRetry.promise;
			monotonicMilliseconds += milliseconds;
		});
		const harness = createHarness(1, {
			monotonicNow: () => monotonicMilliseconds,
			retryWait
		});
		await harness.supervisor.prepare();
		const controller = new AbortController();
		const run = harness.supervisor.run(controller.signal);
		harness.supervisor.reportSlotProgress({
			type: 'poll_succeeded',
			slotId: 0,
			claimed: false
		});
		await harness.supervisor.firstHealthyPublication;
		const priorTarget = harness.filesystem.files.get('heartbeat.json');
		harness.filesystem.renameFailures.push(errorWithCode('EPERM'));
		await harness.sleeper.waitForCall(1);
		harness.setNow(PROCESS_STARTED_MS + 1_000);
		harness.sleeper.release(0);
		const retryObserved = await Promise.race([
			retryEntered.promise.then(() => true),
			run.then(() => false, () => false)
		]);
		expect(retryObserved).toBe(true);

		expect(harness.filesystem.files.get('heartbeat.json')).toBe(priorTarget);
		expect(parseWorkerHeartbeat(
			harness.filesystem.files.get('heartbeat.json.tmp') ?? ''
		).sequence).toBe(2);
		releaseRetry.resolve();
		await harness.filesystem.waitForPublication(2);
		controller.abort();
		await expect(run).resolves.toBeUndefined();
	});

	it('does not retry a nontransient rename failure', async () => {
		const retryWait = vi.fn().mockResolvedValue(undefined);
		const harness = createHarness(1, {
			monotonicNow: () => 0,
			retryWait
		});
		await harness.supervisor.prepare();
		const controller = new AbortController();
		const run = harness.supervisor.run(controller.signal);
		harness.supervisor.reportSlotProgress({
			type: 'poll_succeeded',
			slotId: 0,
			claimed: false
		});
		await harness.supervisor.firstHealthyPublication;
		const priorTarget = harness.filesystem.files.get('heartbeat.json');
		const failure = errorWithCode('EIO');
		harness.filesystem.failures.set('rename', failure);
		await harness.sleeper.waitForCall(1);
		harness.sleeper.release(0);

		const observed = await capturePublicationFailure(run);
		expectFixedPublicationFailure(observed, failure);
		expect(retryWait).not.toHaveBeenCalled();
		expect(harness.filesystem.files.get('heartbeat.json')).toBe(priorTarget);
		expect(harness.filesystem.files.has('heartbeat.json.tmp')).toBe(false);
	});

	it('does not invoke or retry an accessor rename code', async () => {
		let codeInspection = 0;
		const failure = Object.defineProperty(new Error('accessor-code'), 'code', {
			get() {
				codeInspection += 1;
				return 'EPERM';
			}
		});
		const retryWait = vi.fn().mockResolvedValue(undefined);
		const harness = createHarness(1, {
			monotonicNow: () => 0,
			retryWait
		});
		await harness.supervisor.prepare();
		const controller = new AbortController();
		const run = harness.supervisor.run(controller.signal);
		harness.supervisor.reportSlotProgress({
			type: 'poll_succeeded',
			slotId: 0,
			claimed: false
		});
		await harness.supervisor.firstHealthyPublication;
		harness.filesystem.failures.set('rename', failure);
		await harness.sleeper.waitForCall(1);
		harness.sleeper.release(0);

		const observed = await capturePublicationFailure(run);
		expectFixedPublicationFailure(observed, failure);
		expect(codeInspection).toBe(0);
		expect(retryWait).not.toHaveBeenCalled();
	});

	it('does not invoke proxy traps or retry a proxy-reported transient code', async () => {
		let codeInspection = 0;
		const failure = new Proxy(new Error('proxy-code'), {
			getOwnPropertyDescriptor(target, property) {
				codeInspection += 1;
				if (property === 'code') {
					return {
						configurable: true,
						enumerable: true,
						value: 'EPERM',
						writable: true
					};
				}
				return Reflect.getOwnPropertyDescriptor(target, property);
			}
		});
		let monotonicMilliseconds = 0;
		const retryWait = vi.fn(async (milliseconds: number) => {
			monotonicMilliseconds += milliseconds;
		});
		const harness = createHarness(1, {
			intervalMs: 10,
			monotonicNow: () => monotonicMilliseconds,
			retryWait
		});
		await harness.supervisor.prepare();
		const controller = new AbortController();
		const run = harness.supervisor.run(controller.signal);
		harness.supervisor.reportSlotProgress({
			type: 'poll_succeeded',
			slotId: 0,
			claimed: false
		});
		await harness.supervisor.firstHealthyPublication;
		harness.filesystem.failures.set('rename', failure);
		await harness.sleeper.waitForCall(1);
		harness.sleeper.release(0);

		const observed = await capturePublicationFailure(run);
		expect(observed.cause).toBe(failure);
		expect(codeInspection).toBe(0);
		expect(retryWait).not.toHaveBeenCalled();
	});

	it('treats a revoked proxy rename error as nonretryable', async () => {
		const revocable = Proxy.revocable(new Error('revoked-proxy'), {});
		const failure = revocable.proxy;
		revocable.revoke();
		const retryWait = vi.fn().mockResolvedValue(undefined);
		const harness = createHarness(1, {
			monotonicNow: () => 0,
			retryWait
		});
		await harness.supervisor.prepare();
		const controller = new AbortController();
		const run = harness.supervisor.run(controller.signal);
		harness.supervisor.reportSlotProgress({
			type: 'poll_succeeded',
			slotId: 0,
			claimed: false
		});
		await harness.supervisor.firstHealthyPublication;
		harness.filesystem.failures.set('rename', failure);
		await harness.sleeper.waitForCall(1);
		harness.sleeper.release(0);

		const observed = await capturePublicationFailure(run);
		expect(observed.cause).toBe(failure);
		expect(retryWait).not.toHaveBeenCalled();
	});

	it('expires persistent transient rename contention at the exact monotonic deadline', async () => {
		let monotonicMilliseconds = 0;
		const retryWait = vi.fn(async (milliseconds: number) => {
			monotonicMilliseconds += milliseconds;
		});
		const harness = createHarness(1, {
			intervalMs: 25,
			monotonicNow: () => monotonicMilliseconds,
			retryWait
		});
		await harness.supervisor.prepare();
		const controller = new AbortController();
		const run = harness.supervisor.run(controller.signal);
		harness.supervisor.reportSlotProgress({
			type: 'poll_succeeded',
			slotId: 0,
			claimed: false
		});
		await harness.supervisor.firstHealthyPublication;
		const priorTarget = harness.filesystem.files.get('heartbeat.json');
		const beforeSecondPublication = harness.filesystem.operations.length;
		const failure = errorWithCode('EBUSY');
		harness.filesystem.failures.set('rename', failure);
		await harness.sleeper.waitForCall(1);
		harness.sleeper.release(0);

		const observed = await capturePublicationFailure(run);
		expectFixedPublicationFailure(observed, failure);
		expect(retryWait.mock.calls.map(([milliseconds]) => milliseconds))
			.toEqual([10, 10, 5]);
		expect(harness.filesystem.operations.slice(beforeSecondPublication))
			.toEqual([
				'open:heartbeat.json.tmp:wx:600',
				'write:heartbeat.json.tmp:utf8',
				'sync:heartbeat.json.tmp',
				'close:heartbeat.json.tmp',
				'rename:heartbeat.json.tmp:heartbeat.json',
				'rename:heartbeat.json.tmp:heartbeat.json',
				'rename:heartbeat.json.tmp:heartbeat.json',
				'rm:heartbeat.json.tmp:true'
			]);
		expect(harness.filesystem.files.get('heartbeat.json')).toBe(priorTarget);
		expect(harness.filesystem.files.has('heartbeat.json.tmp')).toBe(false);
	});

	it.each(['abort', 'seal'])(
		'treats %s during a transient rename wait as normal and removes the temp',
		async (shutdown) => {
			let monotonicMilliseconds = 0;
			const retryEntered = deferred<void>();
			const retryRelease = deferred<void>();
			const retryWait = vi.fn(async (milliseconds: number, signal: AbortSignal) => {
				retryEntered.resolve();
				if (signal.aborted) return;
				await Promise.race([
					retryRelease.promise,
					new Promise<void>((resolve) =>
						signal.addEventListener('abort', () => resolve(), { once: true })
					)
				]);
				monotonicMilliseconds += milliseconds;
			});
			const harness = createHarness(1, {
				monotonicNow: () => monotonicMilliseconds,
				retryWait
			});
			await harness.supervisor.prepare();
			const controller = new AbortController();
			const run = harness.supervisor.run(controller.signal);
			harness.supervisor.reportSlotProgress({
				type: 'poll_succeeded',
				slotId: 0,
				claimed: false
			});
			await harness.supervisor.firstHealthyPublication;
			const priorTarget = harness.filesystem.files.get('heartbeat.json');
			harness.filesystem.failures.set('rename', errorWithCode('EPERM'));
			await harness.sleeper.waitForCall(1);
			harness.sleeper.release(0);
			const retryObserved = await Promise.race([
				retryEntered.promise.then(() => true),
				run.then(() => false, () => false)
			]);
			expect(retryObserved).toBe(true);

			if (shutdown === 'abort') controller.abort();
			else harness.supervisor.sealProgress();
			retryRelease.resolve();
			await expect(run).resolves.toBeUndefined();
			expect(harness.filesystem.files.get('heartbeat.json')).toBe(priorTarget);
			expect(harness.filesystem.files.has('heartbeat.json.tmp')).toBe(false);
			await harness.supervisor.removeEvidence();
			expect(harness.filesystem.files.has('heartbeat.json')).toBe(false);
		}
	);

	it.each([
		{ shutdown: 'abort', outcome: 'success' },
		{ shutdown: 'abort', outcome: 'nontransient failure' },
		{ shutdown: 'seal', outcome: 'success' },
		{ shutdown: 'seal', outcome: 'nontransient failure' }
	])(
		'treats $shutdown during an in-flight retry $outcome as normal',
		async ({ shutdown, outcome }) => {
			let monotonicMilliseconds = 0;
			const retryState: { filesystem?: MemoryFilesystem } = {};
			const retryRenameGate = deferred<void>();
			const harness = createHarness(1, {
				monotonicNow: () => monotonicMilliseconds,
				retryWait: async (milliseconds) => {
					monotonicMilliseconds += milliseconds;
					if (retryState.filesystem === undefined) {
						throw new Error('missing retry filesystem');
					}
					retryState.filesystem.renameGate = retryRenameGate;
				}
			});
			retryState.filesystem = harness.filesystem;
			await harness.supervisor.prepare();
			const controller = new AbortController();
			const run = harness.supervisor.run(controller.signal);
			harness.supervisor.reportSlotProgress({
				type: 'poll_succeeded',
				slotId: 0,
				claimed: false
			});
			await harness.supervisor.firstHealthyPublication;
			const priorTarget = harness.filesystem.files.get('heartbeat.json');
			const beforeSecondPublication = harness.filesystem.operations.length;
			harness.filesystem.renameFailures.push(errorWithCode('EPERM'));
			if (outcome === 'nontransient failure') {
				harness.filesystem.renameFailures.push(errorWithCode('EIO'));
			}
			await harness.sleeper.waitForCall(1);
			harness.setNow(PROCESS_STARTED_MS + 1_000);
			harness.sleeper.release(0);
			await harness.filesystem.waitForOperation(beforeSecondPublication + 6);

			if (shutdown === 'abort') controller.abort();
			else harness.supervisor.sealProgress();
			retryRenameGate.resolve();
			await expect(run).resolves.toBeUndefined();
			expect(harness.filesystem.operations.at(-1))
				.toBe('rm:heartbeat.json.tmp:true');
			expect(harness.filesystem.files.has('heartbeat.json.tmp')).toBe(false);
			if (outcome === 'success') {
				expect(harness.filesystem.record().sequence).toBe(2);
			} else {
				expect(harness.filesystem.files.get('heartbeat.json')).toBe(priorTarget);
			}
			await harness.supervisor.removeEvidence();
			expect(harness.filesystem.files.has('heartbeat.json')).toBe(false);
		}
	);

	it('keeps an active retry-wait rejection fatal and preserves the prior target', async () => {
		const retryFailure = new Error('retry-wait-failure');
		const retryWait = vi.fn(async () => {
			throw retryFailure;
		});
		const harness = createHarness(1, {
			monotonicNow: () => 0,
			retryWait
		});
		await harness.supervisor.prepare();
		const controller = new AbortController();
		const run = harness.supervisor.run(controller.signal);
		harness.supervisor.reportSlotProgress({
			type: 'poll_succeeded',
			slotId: 0,
			claimed: false
		});
		await harness.supervisor.firstHealthyPublication;
		const priorTarget = harness.filesystem.files.get('heartbeat.json');
		harness.filesystem.failures.set('rename', errorWithCode('EACCES'));
		await harness.sleeper.waitForCall(1);
		harness.sleeper.release(0);

		const observed = await capturePublicationFailure(run);
		expectFixedPublicationFailure(observed, retryFailure);
		expect(retryWait).toHaveBeenCalledOnce();
		expect(harness.filesystem.files.get('heartbeat.json')).toBe(priorTarget);
		expect(harness.filesystem.files.has('heartbeat.json.tmp')).toBe(false);
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, 99])(
		'fails closed when the retry monotonic clock becomes %p',
		async (invalidMilliseconds) => {
			const clockValues = [0, 100, 100, invalidMilliseconds];
			const monotonicNow = vi.fn(() => clockValues.shift() ?? invalidMilliseconds);
			const retryWait = vi.fn().mockResolvedValue(undefined);
			const harness = createHarness(1, { monotonicNow, retryWait });
			await harness.supervisor.prepare();
			const controller = new AbortController();
			const run = harness.supervisor.run(controller.signal);
			harness.supervisor.reportSlotProgress({
				type: 'poll_succeeded',
				slotId: 0,
				claimed: false
			});
			await harness.supervisor.firstHealthyPublication;
			const priorTarget = harness.filesystem.files.get('heartbeat.json');
			harness.filesystem.failures.set('rename', errorWithCode('EPERM'));
			await harness.sleeper.waitForCall(1);
			harness.sleeper.release(0);

			const observed = await capturePublicationFailure(run);
			expect(observed.cause).toBeInstanceOf(TypeError);
			expect(retryWait).toHaveBeenCalledOnce();
			expect(harness.filesystem.files.get('heartbeat.json')).toBe(priorTarget);
			expect(harness.filesystem.files.has('heartbeat.json.tmp')).toBe(false);
		}
	);

	it('fails closed when a positive retry wait makes no monotonic progress', async () => {
		const controller = new AbortController();
		let waitCalls = 0;
		const retryWait = vi.fn(async () => {
			waitCalls += 1;
			if (waitCalls > 1) controller.abort();
		});
		const harness = createHarness(1, {
			intervalMs: 25,
			monotonicNow: () => 100,
			retryWait
		});
		await harness.supervisor.prepare();
		const run = harness.supervisor.run(controller.signal);
		harness.supervisor.reportSlotProgress({
			type: 'poll_succeeded',
			slotId: 0,
			claimed: false
		});
		await harness.supervisor.firstHealthyPublication;
		const priorTarget = harness.filesystem.files.get('heartbeat.json');
		harness.filesystem.failures.set('rename', errorWithCode('EBUSY'));
		await harness.sleeper.waitForCall(1);
		harness.sleeper.release(0);

		const outcome = await run.then(
			() => undefined,
			(error: unknown) => error
		);
		expect(outcome).toBeInstanceOf(WorkerHeartbeatPublicationError);
		expect((outcome as WorkerHeartbeatPublicationError).cause)
			.toBeInstanceOf(TypeError);
		expect(retryWait).toHaveBeenCalledOnce();
		expect(harness.filesystem.files.get('heartbeat.json')).toBe(priorTarget);
		expect(harness.filesystem.files.has('heartbeat.json.tmp')).toBe(false);
	});

	it.skipIf(process.platform !== 'win32')(
		'retries a native Windows replace after a held reader releases without wall sleep',
		async () => {
			const root = await mkdtemp(join(tmpdir(), 'worker-heartbeat-native-'));
			const heartbeatFile = join(root, 'worker.ready');
			const sleeper = controlledSleep();
			const retryEntered = deferred<void>();
			const secondRename = deferred<void>();
			let successfulRenames = 0;
			let monotonicMilliseconds = 0;
			let reader: ChildProcessWithoutNullStreams | undefined;
			let readerStderr = '';
			const filesystem: WorkerHeartbeatFilesystem = {
				async open(path, flags, mode) {
					return openFile(path, flags, mode);
				},
				async rename(from, to) {
					await renameFile(from, to);
					successfulRenames += 1;
					if (successfulRenames === 2) secondRename.resolve();
				},
				rm: removeFile
			};
			const retryWait = vi.fn(async (milliseconds: number) => {
				retryEntered.resolve();
				if (reader === undefined) throw new Error('missing native reader');
				const exited = once(reader, 'exit');
				if (!reader.kill()) throw new Error('native reader did not accept termination');
				await exited;
				monotonicMilliseconds += milliseconds;
			});
			const supervisor = createWorkerHeartbeatSupervisor({
				workerId: 'worker:native-windows',
				configuredSlots: 1,
				heartbeatFile,
				intervalMs: 1_000,
				processStartedAt: new Date(PROCESS_STARTED_MS),
				now: () => new Date(PROCESS_STARTED_MS + successfulRenames * 1_000),
				sleep: sleeper.sleep,
				monotonicNow: () => monotonicMilliseconds,
				retryWait,
				filesystem
			});
			const controller = new AbortController();
			let run: Promise<void> | undefined;
			try {
				await supervisor.prepare();
				run = supervisor.run(controller.signal);
				supervisor.reportSlotProgress({
					type: 'poll_succeeded',
					slotId: 0,
					claimed: false
				});
				await supervisor.firstHealthyPublication;
				expect(parseWorkerHeartbeat(await readFile(heartbeatFile, 'utf8')).sequence)
					.toBe(1);

				const script = [
					'$handle = [IO.File]::Open($env:WORKER_HEARTBEAT_NATIVE_TARGET, [IO.FileMode]::Open,',
					'  [IO.FileAccess]::Read, [IO.FileShare]::None)',
					'try {',
					"  [Console]::Out.WriteLine('locked')",
					'  [Console]::Out.Flush()',
					'  [Threading.Thread]::Sleep([Threading.Timeout]::Infinite)',
					'} finally {',
					'  $handle.Dispose()',
					'}'
				].join('\n');
				reader = spawn('powershell.exe', [
					'-NoLogo',
					'-NoProfile',
					'-NonInteractive',
					'-Command',
					script
				], {
					stdio: 'pipe',
					env: {
						...process.env,
						WORKER_HEARTBEAT_NATIVE_TARGET: heartbeatFile
					}
				});
				reader.stderr.setEncoding('utf8');
				reader.stderr.on('data', (chunk: string) => {
					readerStderr += chunk;
				});
				const lockResult = await Promise.race([
					once(reader.stdout, 'data').then(([output]) => ({
						kind: 'locked' as const,
						output
					})),
					once(reader, 'exit').then(([exitCode]) => ({
						kind: 'exited' as const,
						exitCode
					}))
				]);
				if (lockResult.kind === 'exited') {
					throw new Error(
						`native reader exited with ${String(lockResult.exitCode)}: ${readerStderr}`
					);
				}
				expect(String(lockResult.output)).toContain('locked');

				await sleeper.waitForCall(1);
				sleeper.release(0);
				const retryObserved = await Promise.race([
					retryEntered.promise.then(() => true),
					run.then(() => false, () => false)
				]);
				expect(retryObserved).toBe(true);
				await secondRename.promise;
				expect(retryWait).toHaveBeenCalledOnce();
				expect(parseWorkerHeartbeat(await readFile(heartbeatFile, 'utf8')).sequence)
					.toBe(2);
				controller.abort();
				await expect(run).resolves.toBeUndefined();
				await supervisor.removeEvidence();
			} finally {
				controller.abort();
				if (
					reader !== undefined &&
					reader.exitCode === null &&
					reader.signalCode === null
				) {
					const exited = once(reader, 'exit');
					reader.kill();
					await exited;
				}
				if (run !== undefined) await run.catch(() => undefined);
				await supervisor.removeEvidence().catch(() => undefined);
				await removeFile(root, { recursive: true, force: true });
			}
		}
	);

	it.each<PublicationFailurePoint>(['open', 'write', 'sync', 'close', 'rename'])(
		'rejects an unresolved first publication and cleans only the temp on %s failure',
		async (failurePoint) => {
			const harness = createHarness();
			await harness.supervisor.prepare();
			const failure = new Error(`${failurePoint}-failure`);
			harness.filesystem.failures.set(failurePoint, failure);
			const controller = new AbortController();
			const run = harness.supervisor.run(controller.signal);
			const runFailure = capturePublicationFailure(run);
			const readinessFailure = capturePublicationFailure(
				harness.supervisor.firstHealthyPublication
			);

			harness.supervisor.reportSlotProgress({
				type: 'poll_succeeded',
				slotId: 0,
				claimed: false
			});
			const [observedRunFailure, observedReadinessFailure] = await Promise.all([
				runFailure,
				readinessFailure
			]);
			expect(observedRunFailure).toBe(observedReadinessFailure);
			expectFixedPublicationFailure(observedRunFailure, failure);

			expect(harness.filesystem.operations.slice(2)).toEqual(
				failureOperations[failurePoint]
			);
			expect(harness.filesystem.files.has('heartbeat.json')).toBe(false);
			expect(harness.filesystem.files.has('heartbeat.json.tmp')).toBe(false);
			expect(harness.filesystem.openHandles).toBe(0);
			expect(harness.filesystem.maximumOpenHandles).toBeLessThanOrEqual(1);
		}
	);

	it.each<PublicationFailurePoint>(['open', 'write', 'sync', 'close', 'rename'])(
		'preserves the previous good target when a later %s fails',
		async (failurePoint) => {
			const harness = createHarness();
			await harness.supervisor.prepare();
			const controller = new AbortController();
			const run = harness.supervisor.run(controller.signal);
			harness.supervisor.reportSlotProgress({
				type: 'poll_succeeded',
				slotId: 0,
				claimed: false
			});
			await harness.supervisor.firstHealthyPublication;
			const priorTarget = harness.filesystem.files.get('heartbeat.json');
			expect(priorTarget).toBeTypeOf('string');

			const failure = new Error(`${failurePoint}-later-failure`);
			harness.filesystem.failures.set(failurePoint, failure);
			await harness.sleeper.waitForCall(1);
			harness.sleeper.release(0);
			const observedFailure = await capturePublicationFailure(run);
			expectFixedPublicationFailure(observedFailure, failure);

			expect(harness.filesystem.files.get('heartbeat.json')).toBe(priorTarget);
			expect(harness.filesystem.files.has('heartbeat.json.tmp')).toBe(false);
			expect(harness.filesystem.openHandles).toBe(0);
		}
	);

	it('preserves the write failure over a later close and cleanup failure', async () => {
		const harness = createHarness();
		await harness.supervisor.prepare();
		const writeFailure = new Error('write-primary');
		harness.filesystem.failures.set('write', writeFailure);
		harness.filesystem.failures.set('close', new Error('close-secondary'));
		harness.filesystem.failures.set('rm', new Error('cleanup-secondary'));
		const controller = new AbortController();
		const run = harness.supervisor.run(controller.signal);
		const readiness = capturePublicationFailure(
			harness.supervisor.firstHealthyPublication
		);
		harness.supervisor.reportSlotProgress({
			type: 'poll_succeeded',
			slotId: 0,
			claimed: false
		});

		const [runFailure, readinessFailure] = await Promise.all([
			capturePublicationFailure(run),
			readiness
		]);
		expect(runFailure).toBe(readinessFailure);
		expectFixedPublicationFailure(runFailure, writeFailure);
		expect(harness.filesystem.openHandles).toBe(0);
		expect(harness.filesystem.operations.slice(-2)).toEqual([
			'close:heartbeat.json.tmp',
			'rm:heartbeat.json.tmp:true'
		]);
	});

	it.each<PublicationFailurePoint>(['open', 'close', 'rename'])(
		'does not let temp-cleanup failure mask the primary %s failure',
		async (failurePoint) => {
			const harness = createHarness();
			await harness.supervisor.prepare();
			const primary = new Error(`${failurePoint}-primary`);
			harness.filesystem.failures.set(failurePoint, primary);
			harness.filesystem.failures.set('rm', new Error('cleanup-secondary'));
			const controller = new AbortController();
			const run = harness.supervisor.run(controller.signal);
			const readiness = capturePublicationFailure(
				harness.supervisor.firstHealthyPublication
			);
			harness.supervisor.reportSlotProgress({
				type: 'poll_succeeded',
				slotId: 0,
				claimed: false
			});

			const [runFailure, readinessFailure] = await Promise.all([
				capturePublicationFailure(run),
				readiness
			]);
			expect(runFailure).toBe(readinessFailure);
			expectFixedPublicationFailure(runFailure, primary);
		}
	);

	it('treats abort before readiness as normal and accepts reports until explicit sealing', async () => {
		const harness = createHarness(2);
		await harness.supervisor.prepare();
		const controller = new AbortController();
		const run = harness.supervisor.run(controller.signal);
		controller.abort();
		await expect(run).resolves.toBeUndefined();

		expect(await promiseState(harness.supervisor.firstHealthyPublication)).toBe('pending');
		harness.supervisor.reportSlotProgress({
			type: 'poll_succeeded',
			slotId: 0,
			claimed: false
		});
		expect(harness.filesystem.publications).toEqual([]);
		harness.supervisor.sealProgress();
		expect(() =>
			harness.supervisor.reportSlotProgress({ type: 'polling', slotId: 0 })
		).toThrow();
	});

	it('treats abort while sleeping as normal and leaves progress open while the runner unwinds', async () => {
		const harness = createHarness();
		await harness.supervisor.prepare();
		const controller = new AbortController();
		const run = harness.supervisor.run(controller.signal);
		harness.supervisor.reportSlotProgress({
			type: 'poll_succeeded',
			slotId: 0,
			claimed: true
		});
		await harness.supervisor.firstHealthyPublication;
		await harness.sleeper.waitForCall(1);

		controller.abort();
		await expect(run).resolves.toBeUndefined();
		harness.setNow(PROCESS_STARTED_MS + 1_000);
		expect(() =>
			harness.supervisor.reportSlotProgress({ type: 'lease_renewed', slotId: 0 })
		).not.toThrow();
		harness.supervisor.sealProgress();
		expect(() =>
			harness.supervisor.reportSlotProgress({ type: 'terminal_settled', slotId: 0 })
		).toThrow();
	});

	it('removes final evidence idempotently after run and seals starts and reports', async () => {
		const harness = createHarness();
		await harness.supervisor.prepare();
		const controller = new AbortController();
		const run = harness.supervisor.run(controller.signal);
		harness.supervisor.reportSlotProgress({
			type: 'poll_succeeded',
			slotId: 0,
			claimed: false
		});
		await harness.supervisor.firstHealthyPublication;
		controller.abort();
		await run;
		const beforeRemoval = harness.filesystem.operations.length;

		await Promise.all([
			harness.supervisor.removeEvidence(),
			harness.supervisor.removeEvidence()
		]);
		await harness.supervisor.removeEvidence();

		expect(harness.filesystem.operations.slice(beforeRemoval)).toEqual([
			'rm:heartbeat.json:true',
			'rm:heartbeat.json.tmp:true'
		]);
		expect(harness.filesystem.files.has('heartbeat.json')).toBe(false);
		expect(() =>
			harness.supervisor.reportSlotProgress({ type: 'polling', slotId: 0 })
		).toThrow();
		await expect(harness.supervisor.run(controller.signal)).rejects.toThrow();
	});

	it('removes evidence after prepare without run and leaves never-achieved readiness pending', async () => {
		const harness = createHarness();
		await harness.supervisor.prepare();
		harness.filesystem.files.set('heartbeat.json', 'external-test-target');
		harness.filesystem.files.set('heartbeat.json.tmp', 'external-test-temp');
		harness.filesystem.files.set('neighbor', 'preserved');

		await harness.supervisor.removeEvidence();
		await harness.supervisor.removeEvidence();

		expect(harness.filesystem.operations).toEqual([
			'rm:heartbeat.json:true',
			'rm:heartbeat.json.tmp:true',
			'rm:heartbeat.json:true',
			'rm:heartbeat.json.tmp:true'
		]);
		expect([...harness.filesystem.files]).toEqual([['neighbor', 'preserved']]);
		expect(await promiseState(harness.supervisor.firstHealthyPublication)).toBe('pending');
		expect(() =>
			harness.supervisor.reportSlotProgress({ type: 'polling', slotId: 0 })
		).toThrow();
		await expect(harness.supervisor.run(new AbortController().signal)).rejects.toThrow();
	});

	it('rejects publication clock regression and nonfinite publication time before file creation', async () => {
		for (const invalidNow of [PROCESS_STARTED_MS + 99, Number.NaN]) {
			const harness = createHarness();
			harness.setNow(PROCESS_STARTED_MS + 100);
			harness.supervisor.reportSlotProgress({
				type: 'poll_succeeded',
				slotId: 0,
				claimed: false
			});
			harness.setNow(invalidNow);
			await harness.supervisor.prepare();
			const run = harness.supervisor.run(new AbortController().signal);
			const readiness = capturePublicationFailure(
				harness.supervisor.firstHealthyPublication
			);

			await Promise.all([capturePublicationFailure(run), readiness]);
			expect(harness.filesystem.operations).toEqual([
				'rm:heartbeat.json:true',
				'rm:heartbeat.json.tmp:true'
			]);
		}
	});

	it('guards the unreachable signed-int32 sequence overflow without exposing a test seed', () => {
		expect(createWorkerHeartbeatSupervisor.toString()).toContain(
			'sequence === MAX_SEQUENCE'
		);
	});

	it('does not convert an injected non-abort sleep failure into a normal shutdown', async () => {
		const sleepFailure = new Error('sleep-failure');
		const filesystem = new MemoryFilesystem();
		const supervisor = createWorkerHeartbeatSupervisor({
			workerId: 'worker:sleep-test',
			configuredSlots: 1,
			heartbeatFile: 'heartbeat.json',
			intervalMs: 5_000,
			processStartedAt: new Date(PROCESS_STARTED_MS),
			now: () => new Date(PROCESS_STARTED_MS),
			sleep: async () => {
				throw sleepFailure;
			},
			filesystem
		});
		await supervisor.prepare();
		const run = supervisor.run(new AbortController().signal);
		supervisor.reportSlotProgress({
			type: 'poll_succeeded',
			slotId: 0,
			claimed: false
		});
		await supervisor.firstHealthyPublication;

		const observedFailure = await capturePublicationFailure(run);
		expectFixedPublicationFailure(observedFailure, sleepFailure);
		await expect(supervisor.firstHealthyPublication).resolves.toBeUndefined();
	});
});
