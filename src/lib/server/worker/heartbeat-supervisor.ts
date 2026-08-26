import {
	open as openFile,
	rename as renameFile,
	rm as removeFile
} from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { isPositiveSignedInt32, isWorkerId } from '../observability/contracts';
import type { WorkerSlotProgressEvent } from '../jobs/runner-observer';
import { encodeWorkerHeartbeat } from './heartbeat-contract';
import type {
	WorkerHeartbeatRecord,
	WorkerHeartbeatSlotRecord,
	WorkerSlotState
} from './heartbeat-contract';

export class WorkerHeartbeatPublicationError extends Error {
	constructor(cause: unknown) {
		super('Worker heartbeat publication failed', { cause });
		this.name = 'WorkerHeartbeatPublicationError';
	}
}

export interface WorkerHeartbeatSupervisor {
	readonly firstHealthyPublication: Promise<void>;
	prepare(): Promise<void>;
	reportSlotProgress(event: WorkerSlotProgressEvent): void;
	run(signal: AbortSignal): Promise<void>;
	sealProgress(): void;
	removeEvidence(): Promise<void>;
}

export interface WorkerHeartbeatFileHandle {
	writeFile(value: string, options: { readonly encoding: 'utf8' }): Promise<void>;
	sync(): Promise<void>;
	close(): Promise<void>;
}

export interface WorkerHeartbeatFilesystem {
	open(path: string, flags: 'wx', mode: number): Promise<WorkerHeartbeatFileHandle>;
	rename(from: string, to: string): Promise<void>;
	rm(path: string, options: { readonly force: true }): Promise<void>;
}

interface MutableSlotState {
	readonly slotId: number;
	state: WorkerSlotState;
	lastSuccessfulPollAt?: string;
	lastProgressAt?: string;
}

const INVALID_SUPERVISOR = 'invalid worker heartbeat supervisor';
const INVALID_PROGRESS = 'invalid worker slot progress';
const INVALID_LIFECYCLE = 'invalid worker heartbeat lifecycle';
const MAX_SEQUENCE = 2_147_483_647;
const MAX_RENAME_RETRY_WINDOW_MS = 1_000;
const RENAME_RETRY_WAIT_MS = 10;

const defaultFilesystem: WorkerHeartbeatFilesystem = {
	async open(path, flags, mode) {
		return openFile(path, flags, mode);
	},
	rename: renameFile,
	rm: removeFile
};

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timeout = setTimeout(finish, milliseconds);
		function finish(): void {
			clearTimeout(timeout);
			signal.removeEventListener('abort', finish);
			resolve();
		}
		signal.addEventListener('abort', finish, { once: true });
	});
}

function defaultRetryWait(milliseconds: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const timeout = setTimeout(finish, milliseconds);
		function finish(): void {
			clearTimeout(timeout);
			signal.removeEventListener('abort', finish);
			resolve();
		}
		signal.addEventListener('abort', finish, { once: true });
	});
}

function defaultMonotonicNow(): number {
	return performance.now();
}

function isTransientRenameContention(error: unknown): boolean {
	if (error === null || typeof error !== 'object') return false;
	let descriptor: PropertyDescriptor | undefined;
	try {
		descriptor = Object.getOwnPropertyDescriptor(error, 'code');
	} catch {
		return false;
	}
	if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return false;
	return descriptor.value === 'EPERM' ||
		descriptor.value === 'EACCES' ||
		descriptor.value === 'EBUSY';
}

function dateMilliseconds(value: unknown, message: string): number {
	try {
		if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Date.prototype) {
			throw new TypeError(message);
		}
		const milliseconds = Date.prototype.getTime.call(value) as number;
		if (!Number.isFinite(milliseconds)) throw new TypeError(message);
		return milliseconds;
	} catch {
		throw new TypeError(message);
	}
}

function eventSnapshot(event: WorkerSlotProgressEvent): {
	readonly type: WorkerSlotProgressEvent['type'];
	readonly slotId: number;
	readonly claimed?: boolean;
} {
	try {
		if (event === null || typeof event !== 'object' || Array.isArray(event)) {
			throw new TypeError(INVALID_PROGRESS);
		}
		const prototype = Object.getPrototypeOf(event);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError(INVALID_PROGRESS);
		}
		const descriptors = Object.getOwnPropertyDescriptors(event);
		const keys = Reflect.ownKeys(descriptors);
		const typeDescriptor = descriptors.type;
		const slotDescriptor = descriptors.slotId;
		if (
			typeDescriptor === undefined ||
			slotDescriptor === undefined ||
			!Object.hasOwn(typeDescriptor, 'value') ||
			!Object.hasOwn(slotDescriptor, 'value') ||
			typeDescriptor.enumerable !== true ||
			slotDescriptor.enumerable !== true
		) {
			throw new TypeError(INVALID_PROGRESS);
		}
		const type = typeDescriptor.value as unknown;
		const slotId = slotDescriptor.value as unknown;
		if (
			!Number.isInteger(slotId) ||
			!Number.isSafeInteger(slotId) ||
			Object.is(slotId, -0) ||
			(slotId as number) < 0 ||
			(slotId as number) > MAX_SEQUENCE
		) {
			throw new TypeError(INVALID_PROGRESS);
		}
		if (type === 'poll_succeeded') {
			const claimedDescriptor = descriptors.claimed;
			if (
				keys.length !== 3 ||
				claimedDescriptor === undefined ||
				!Object.hasOwn(claimedDescriptor, 'value') ||
				claimedDescriptor.enumerable !== true ||
				typeof claimedDescriptor.value !== 'boolean'
			) {
				throw new TypeError(INVALID_PROGRESS);
			}
			return { type, slotId: slotId as number, claimed: claimedDescriptor.value };
		}
		if (
			(type !== 'polling' &&
				type !== 'lease_renewed' &&
				type !== 'terminal_settled' &&
				type !== 'lease_lost') ||
			keys.length !== 2
		) {
			throw new TypeError(INVALID_PROGRESS);
		}
		return { type, slotId: slotId as number };
	} catch {
		throw new TypeError(INVALID_PROGRESS);
	}
}

export function createWorkerHeartbeatSupervisor(options: {
	readonly workerId: string;
	readonly configuredSlots: number;
	readonly heartbeatFile: string;
	readonly intervalMs: number;
	readonly processStartedAt: Date;
	readonly now?: () => Date;
	readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
	readonly monotonicNow?: () => number;
	readonly retryWait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
	readonly filesystem?: WorkerHeartbeatFilesystem;
}): WorkerHeartbeatSupervisor {
	const workerId = options.workerId;
	const configuredSlots = options.configuredSlots;
	const heartbeatFile = options.heartbeatFile;
	const intervalMs = options.intervalMs;
	const processStartedAtInput = options.processStartedAt;
	const now = options.now ?? (() => new Date());
	const sleep = options.sleep ?? defaultSleep;
	const monotonicNow = options.monotonicNow ?? defaultMonotonicNow;
	const retryWait = options.retryWait ?? defaultRetryWait;
	const filesystem = options.filesystem ?? defaultFilesystem;
	if (
		!isWorkerId(workerId) ||
		!isPositiveSignedInt32(configuredSlots) ||
		typeof heartbeatFile !== 'string' ||
		heartbeatFile.length === 0 ||
		!isPositiveSignedInt32(intervalMs)
	) {
		throw new TypeError(INVALID_SUPERVISOR);
	}

	const processStartedMilliseconds = dateMilliseconds(
		processStartedAtInput,
		INVALID_SUPERVISOR
	);
	const processStartedAt = new Date(processStartedMilliseconds).toISOString();
	const temporaryFile = `${heartbeatFile}.tmp`;
	const readiness = Promise.withResolvers<void>();
	const firstPublication = Promise.withResolvers<void>();
	void firstPublication.promise.catch(() => undefined);
	const slots: MutableSlotState[] = Array.from(
		{ length: configuredSlots },
		(_, slotId) => ({ slotId, state: 'polling' })
	);

	let lastAcceptedMilliseconds = processStartedMilliseconds;
	let sequence = 0;
	let ready = false;
	let prepared = false;
	let runStarted = false;
	let runSettled = false;
	let sealed = false;
	let firstPublicationSettled = false;
	let preparation: Promise<void> | undefined;
	let removal: Promise<void> | undefined;

	function acceptNow(message: string): string {
		let milliseconds: number;
		try {
			milliseconds = dateMilliseconds(now(), message);
		} catch {
			throw new TypeError(message);
		}
		if (milliseconds < lastAcceptedMilliseconds) throw new TypeError(message);
		lastAcceptedMilliseconds = milliseconds;
		return new Date(milliseconds).toISOString();
	}

	function updateReadiness(): void {
		if (ready || slots.some((slot) => slot.lastSuccessfulPollAt === undefined)) return;
		ready = true;
		readiness.resolve();
	}

	function reportSlotProgress(event: WorkerSlotProgressEvent): void {
		if (sealed) throw new TypeError(INVALID_LIFECYCLE);
		const snapshot = eventSnapshot(event);
		if (snapshot.slotId >= slots.length) throw new TypeError(INVALID_PROGRESS);
		const slot = slots[snapshot.slotId];
		if (slot === undefined) throw new TypeError(INVALID_PROGRESS);

		switch (snapshot.type) {
			case 'polling':
				if (slot.state === 'handling') throw new TypeError(INVALID_PROGRESS);
				break;
			case 'poll_succeeded':
				if (slot.state !== 'polling') throw new TypeError(INVALID_PROGRESS);
				break;
			case 'lease_renewed':
			case 'terminal_settled':
			case 'lease_lost':
				if (slot.state !== 'handling') throw new TypeError(INVALID_PROGRESS);
				break;
		}

		const acceptedAt = acceptNow(INVALID_PROGRESS);
		switch (snapshot.type) {
			case 'polling':
				slot.state = 'polling';
				break;
			case 'poll_succeeded':
				slot.state = snapshot.claimed === true ? 'handling' : 'idle';
				slot.lastSuccessfulPollAt = acceptedAt;
				slot.lastProgressAt = acceptedAt;
				updateReadiness();
				break;
			case 'lease_renewed':
				slot.lastProgressAt = acceptedAt;
				break;
			case 'terminal_settled':
				slot.state = 'idle';
				slot.lastProgressAt = acceptedAt;
				break;
			case 'lease_lost':
				slot.state = 'idle';
				break;
		}
	}

	function snapshotSlots(): readonly WorkerHeartbeatSlotRecord[] {
		return slots.map((slot) => {
			if (slot.lastSuccessfulPollAt === undefined || slot.lastProgressAt === undefined) {
				throw new TypeError(INVALID_LIFECYCLE);
			}
			return {
				slotId: slot.slotId,
				state: slot.state,
				lastSuccessfulPollAt: slot.lastSuccessfulPollAt,
				lastProgressAt: slot.lastProgressAt
			};
		});
	}

	function readMonotonicMilliseconds(previous?: number): number {
		let milliseconds: number;
		try {
			milliseconds = monotonicNow();
		} catch {
			throw new TypeError(INVALID_LIFECYCLE);
		}
		if (
			!Number.isFinite(milliseconds) ||
			milliseconds < 0 ||
			(previous !== undefined && milliseconds < previous)
		) {
			throw new TypeError(INVALID_LIFECYCLE);
		}
		return milliseconds;
	}

	async function renamePreparedPublication(signal: AbortSignal): Promise<boolean> {
		let observedAt = readMonotonicMilliseconds();
		const retryWindow = Math.min(intervalMs, MAX_RENAME_RETRY_WINDOW_MS);
		const deadline = observedAt + retryWindow;
		if (!Number.isFinite(deadline) || deadline < observedAt) {
			throw new TypeError(INVALID_LIFECYCLE);
		}
		let retrying = false;

		while (true) {
			if (retrying && (signal.aborted || sealed)) return false;
			try {
				await filesystem.rename(temporaryFile, heartbeatFile);
				if (retrying && (signal.aborted || sealed)) return false;
				return true;
			} catch (error) {
				if (retrying && (signal.aborted || sealed)) return false;
				if (!isTransientRenameContention(error)) throw error;
				if (signal.aborted || sealed) return false;
				observedAt = readMonotonicMilliseconds(observedAt);
				const remaining = deadline - observedAt;
				if (remaining <= 0) throw error;
				try {
					await retryWait(Math.min(RENAME_RETRY_WAIT_MS, remaining), signal);
				} catch (waitError) {
					if (signal.aborted || sealed) return false;
					throw waitError;
				}
				if (signal.aborted || sealed) return false;
				observedAt = readMonotonicMilliseconds(observedAt);
				if (observedAt >= deadline) throw error;
				retrying = true;
			}
		}
	}

	async function publish(signal: AbortSignal): Promise<boolean> {
		const publishedAt = acceptNow(INVALID_LIFECYCLE);
		if (sequence === MAX_SEQUENCE) throw new RangeError(INVALID_LIFECYCLE);
		sequence += 1;
		const record: WorkerHeartbeatRecord = {
			version: 1,
			workerId,
			processStartedAt,
			publishedAt,
			sequence,
			configuredSlots,
			slots: snapshotSlots()
		};
		const encoded = encodeWorkerHeartbeat(record);
		let handle: WorkerHeartbeatFileHandle | undefined;
		let publicationFailed = false;
		let publicationFailure: unknown;
		try {
			handle = await filesystem.open(temporaryFile, 'wx', 0o600);
		} catch (error) {
			publicationFailed = true;
			publicationFailure = error;
		}

		if (handle !== undefined) {
			try {
				await handle.writeFile(encoded, { encoding: 'utf8' });
				await handle.sync();
			} catch (error) {
				publicationFailed = true;
				publicationFailure = error;
			}

			try {
				await handle.close();
			} catch (error) {
				if (!publicationFailed) {
					publicationFailed = true;
					publicationFailure = error;
				}
			}
		}

		if (!publicationFailed) {
			try {
				if (!(await renamePreparedPublication(signal))) {
					try {
						await filesystem.rm(temporaryFile, { force: true });
					} catch {
						// Final evidence removal remains authoritative during shutdown.
					}
					return false;
				}
			} catch (error) {
				publicationFailed = true;
				publicationFailure = error;
			}
		}

		if (publicationFailed) {
			try {
				await filesystem.rm(temporaryFile, { force: true });
			} catch {
				// The publication failure remains authoritative.
			}
			throw publicationFailure;
		}
		return true;
	}

	function waitForReadiness(signal: AbortSignal): Promise<boolean> {
		if (signal.aborted || sealed) return Promise.resolve(false);
		if (ready) return Promise.resolve(true);
		return new Promise((resolve) => {
			function aborted(): void {
				resolve(false);
			}
			signal.addEventListener('abort', aborted, { once: true });
			void readiness.promise.then(() => {
				signal.removeEventListener('abort', aborted);
				resolve(!signal.aborted && !sealed);
			});
		});
	}

	async function run(signal: AbortSignal): Promise<void> {
		if (!prepared || sealed || runStarted) throw new TypeError(INVALID_LIFECYCLE);
		runStarted = true;
		try {
			if (!(await waitForReadiness(signal)) || signal.aborted || sealed) return;
			if (!(await publish(signal))) return;
			firstPublicationSettled = true;
			firstPublication.resolve();

			while (!signal.aborted && !sealed) {
				try {
					await sleep(intervalMs, signal);
				} catch (error) {
					if (signal.aborted) return;
					throw error;
				}
				if (signal.aborted || sealed) return;
				if (!(await publish(signal))) return;
			}
		} catch (error) {
			const failure = new WorkerHeartbeatPublicationError(error);
			if (!firstPublicationSettled) {
				firstPublicationSettled = true;
				firstPublication.reject(failure);
			}
			throw failure;
		} finally {
			runSettled = true;
		}
	}

	async function removeOwnedPaths(): Promise<void> {
		let failed = false;
		let primaryFailure: unknown;
		try {
			await filesystem.rm(heartbeatFile, { force: true });
		} catch (error) {
			failed = true;
			primaryFailure = error;
		}
		try {
			await filesystem.rm(temporaryFile, { force: true });
		} catch (error) {
			if (!failed) {
				failed = true;
				primaryFailure = error;
			}
		}
		if (failed) throw primaryFailure;
	}

	async function prepare(): Promise<void> {
		if (runStarted || sealed) throw new TypeError(INVALID_LIFECYCLE);
		if (prepared) return;
		if (preparation === undefined) {
			const attempt = removeOwnedPaths().then(
				() => {
					prepared = true;
				},
				(error: unknown) => {
					throw new WorkerHeartbeatPublicationError(error);
				}
			);
			preparation = attempt;
			void attempt.catch(() => {
				if (preparation === attempt) preparation = undefined;
			});
		}
		return preparation;
	}

	function sealProgress(): void {
		sealed = true;
	}

	async function removeEvidence(): Promise<void> {
		if (!prepared) throw new TypeError(INVALID_LIFECYCLE);
		if (runStarted && !runSettled) throw new TypeError(INVALID_LIFECYCLE);
		sealed = true;
		if (removal === undefined) {
			const attempt = removeOwnedPaths();
			removal = attempt;
			void attempt.catch(() => {
				if (removal === attempt) removal = undefined;
			});
		}
		return removal;
	}

	return Object.freeze({
		firstHealthyPublication: firstPublication.promise,
		prepare,
		reportSlotProgress,
		run,
		sealProgress,
		removeEvidence
	});
}
