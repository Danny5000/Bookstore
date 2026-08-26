import { Buffer } from 'node:buffer';

import {
	isNonnegativeSignedInt32,
	isPositiveSignedInt32,
	isWorkerId
} from '../observability/contracts';

export type WorkerSlotState = 'polling' | 'idle' | 'handling';

export interface WorkerHeartbeatSlotRecord {
	readonly slotId: number;
	readonly state: WorkerSlotState;
	readonly lastSuccessfulPollAt: string;
	readonly lastProgressAt: string;
}

export interface WorkerHeartbeatRecord {
	readonly version: 1;
	readonly workerId: string;
	readonly processStartedAt: string;
	readonly publishedAt: string;
	readonly sequence: number;
	readonly configuredSlots: number;
	readonly slots: readonly WorkerHeartbeatSlotRecord[];
}

export const WORKER_HEARTBEAT_MAX_BYTES = 65_536;
export const WORKER_HEARTBEAT_FUTURE_TOLERANCE_MS = 5_000;

const INVALID_HEARTBEAT_MESSAGE = 'invalid worker heartbeat';
const RECORD_KEYS = [
	'version',
	'workerId',
	'processStartedAt',
	'publishedAt',
	'sequence',
	'configuredSlots',
	'slots'
] as const;
const SLOT_KEYS = [
	'slotId',
	'state',
	'lastSuccessfulPollAt',
	'lastProgressAt'
] as const;
const FRESHNESS_OPTION_KEYS = ['now', 'configuredSlots', 'maxAgeMs'] as const;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function invalidHeartbeat(): never {
	throw new TypeError(INVALID_HEARTBEAT_MESSAGE);
}

function ownDataPropertyValue(object: object, key: PropertyKey): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return invalidHeartbeat();
	return descriptor.value;
}

function propertySnapshot(
	descriptors: object,
	key: PropertyKey,
	expectedEnumerable: boolean
): unknown {
	const descriptor = ownDataPropertyValue(descriptors, key);
	if (descriptor === null || typeof descriptor !== 'object') return invalidHeartbeat();
	if (ownDataPropertyValue(descriptor, 'enumerable') !== expectedEnumerable) return invalidHeartbeat();
	return ownDataPropertyValue(descriptor, 'value');
}

function plainObjectSnapshot(value: unknown, expectedKeys: readonly string[]): readonly unknown[] {
	try {
		if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalidHeartbeat();
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return invalidHeartbeat();

		const descriptors = Object.getOwnPropertyDescriptors(value);
		const actualKeys = Reflect.ownKeys(descriptors);
		if (actualKeys.length !== expectedKeys.length) return invalidHeartbeat();
		for (let index = 0; index < actualKeys.length; index += 1) {
			if (typeof actualKeys[index] !== 'string') return invalidHeartbeat();
		}

		const snapshot: unknown[] = new Array(expectedKeys.length);
		for (let index = 0; index < expectedKeys.length; index += 1) {
			const key = expectedKeys[index];
			if (key === undefined || !Object.hasOwn(descriptors, key)) return invalidHeartbeat();
			Object.defineProperty(snapshot, index, {
				configurable: true,
				enumerable: true,
				value: propertySnapshot(descriptors, key, true),
				writable: true
			});
		}
		return snapshot;
	} catch {
		return invalidHeartbeat();
	}
}

function arraySnapshot(value: unknown, expectedLength: number): readonly unknown[] {
	try {
		if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return invalidHeartbeat();
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const length = propertySnapshot(descriptors, 'length', false);
		if (length !== expectedLength || Reflect.ownKeys(descriptors).length !== expectedLength + 1) {
			return invalidHeartbeat();
		}

		const snapshot: unknown[] = new Array(expectedLength);
		for (let index = 0; index < expectedLength; index += 1) {
			Object.defineProperty(snapshot, index, {
				configurable: true,
				enumerable: true,
				value: propertySnapshot(descriptors, String(index), true),
				writable: true
			});
		}
		return snapshot;
	} catch {
		return invalidHeartbeat();
	}
}

interface CanonicalTimestamp {
	readonly value: string;
	readonly milliseconds: number;
}

function canonicalTimestamp(value: unknown): CanonicalTimestamp {
	if (typeof value !== 'string' || !CANONICAL_TIMESTAMP.test(value)) return invalidHeartbeat();
	try {
		const milliseconds = new Date(value).getTime();
		if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
			return invalidHeartbeat();
		}
		return { value, milliseconds };
	} catch {
		return invalidHeartbeat();
	}
}

function workerSlotState(value: unknown): WorkerSlotState {
	if (value === 'polling' || value === 'idle' || value === 'handling') return value;
	return invalidHeartbeat();
}

function reconstructSlot(
	value: unknown,
	expectedSlotId: number,
	processStartedMilliseconds: number,
	publishedMilliseconds: number
): WorkerHeartbeatSlotRecord {
	const values = plainObjectSnapshot(value, SLOT_KEYS);
	const slotId = values[0];
	const state = values[1];
	const lastSuccessfulPollAtValue = values[2];
	const lastProgressAtValue = values[3];
	if (
		!isNonnegativeSignedInt32(slotId) ||
		Object.is(slotId, -0) ||
		slotId !== expectedSlotId
	) {
		return invalidHeartbeat();
	}
	const lastSuccessfulPollAt = canonicalTimestamp(lastSuccessfulPollAtValue);
	const lastProgressAt = canonicalTimestamp(lastProgressAtValue);
	if (
		processStartedMilliseconds > lastSuccessfulPollAt.milliseconds ||
		lastSuccessfulPollAt.milliseconds > lastProgressAt.milliseconds ||
		lastProgressAt.milliseconds > publishedMilliseconds
	) {
		return invalidHeartbeat();
	}

	return Object.freeze({
		slotId,
		state: workerSlotState(state),
		lastSuccessfulPollAt: lastSuccessfulPollAt.value,
		lastProgressAt: lastProgressAt.value
	});
}

function reconstructHeartbeat(value: unknown): WorkerHeartbeatRecord {
	const values = plainObjectSnapshot(value, RECORD_KEYS);
	const version = values[0];
	const workerId = values[1];
	const processStartedAtValue = values[2];
	const publishedAtValue = values[3];
	const sequence = values[4];
	const configuredSlots = values[5];
	const slotsValue = values[6];
	if (version !== 1 || !isWorkerId(workerId)) return invalidHeartbeat();
	if (!isPositiveSignedInt32(sequence) || !isPositiveSignedInt32(configuredSlots)) {
		return invalidHeartbeat();
	}

	const processStartedAt = canonicalTimestamp(processStartedAtValue);
	const publishedAt = canonicalTimestamp(publishedAtValue);
	if (processStartedAt.milliseconds > publishedAt.milliseconds) return invalidHeartbeat();

	const slotValues = arraySnapshot(slotsValue, configuredSlots);
	const slots: WorkerHeartbeatSlotRecord[] = new Array(configuredSlots);
	for (let slotId = 0; slotId < configuredSlots; slotId += 1) {
		Object.defineProperty(slots, slotId, {
			configurable: true,
			enumerable: true,
			value: reconstructSlot(
				slotValues[slotId],
				slotId,
				processStartedAt.milliseconds,
				publishedAt.milliseconds
			),
			writable: true
		});
	}

	return Object.freeze({
		version: 1,
		workerId,
		processStartedAt: processStartedAt.value,
		publishedAt: publishedAt.value,
		sequence,
		configuredSlots,
		slots: Object.freeze(slots)
	});
}

function jsonString(value: string): string {
	const encoded = JSON.stringify(value);
	if (typeof encoded !== 'string') return invalidHeartbeat();
	return encoded;
}

function serializeHeartbeat(record: WorkerHeartbeatRecord): string {
	let slots = '';
	for (let index = 0; index < record.slots.length; index += 1) {
		const slot = record.slots[index];
		if (slot === undefined) return invalidHeartbeat();
		if (index > 0) slots += ',';
		slots +=
			`{"slotId":${slot.slotId},"state":${jsonString(slot.state)},` +
			`"lastSuccessfulPollAt":${jsonString(slot.lastSuccessfulPollAt)},` +
			`"lastProgressAt":${jsonString(slot.lastProgressAt)}}`;
	}
	return (
		`{"version":1,"workerId":${jsonString(record.workerId)},` +
		`"processStartedAt":${jsonString(record.processStartedAt)},` +
		`"publishedAt":${jsonString(record.publishedAt)},"sequence":${record.sequence},` +
		`"configuredSlots":${record.configuredSlots},"slots":[${slots}]}`
	);
}

function encodeReconstructed(record: WorkerHeartbeatRecord): string {
	const encoded = serializeHeartbeat(record);
	if (Buffer.byteLength(encoded, 'utf8') > WORKER_HEARTBEAT_MAX_BYTES) return invalidHeartbeat();
	return encoded;
}

export function encodeWorkerHeartbeat(record: WorkerHeartbeatRecord): string {
	try {
		return encodeReconstructed(reconstructHeartbeat(record));
	} catch {
		return invalidHeartbeat();
	}
}

export function parseWorkerHeartbeat(raw: string): WorkerHeartbeatRecord {
	if (typeof raw !== 'string') return invalidHeartbeat();
	try {
		if (Buffer.byteLength(raw, 'utf8') > WORKER_HEARTBEAT_MAX_BYTES) return invalidHeartbeat();
	} catch {
		return invalidHeartbeat();
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		return invalidHeartbeat();
	}

	try {
		const record = reconstructHeartbeat(parsed);
		if (encodeReconstructed(record) !== raw) return invalidHeartbeat();
		return record;
	} catch {
		return invalidHeartbeat();
	}
}

function dateMilliseconds(value: unknown): number {
	try {
		if (
			value === null ||
			typeof value !== 'object' ||
			Object.getPrototypeOf(value) !== Date.prototype ||
			Reflect.ownKeys(value).length !== 0
		) {
			return invalidHeartbeat();
		}
		const milliseconds = Date.prototype.getTime.call(value) as number;
		return Number.isFinite(milliseconds) ? milliseconds : invalidHeartbeat();
	} catch {
		return invalidHeartbeat();
	}
}

export function validateWorkerHeartbeatFreshness(
	record: WorkerHeartbeatRecord,
	options: {
		readonly now: Date;
		readonly configuredSlots: number;
		readonly maxAgeMs: number;
	}
): void {
	try {
		const optionValues = plainObjectSnapshot(options, FRESHNESS_OPTION_KEYS);
		const nowValue = optionValues[0];
		const expectedConfiguredSlots = optionValues[1];
		const maxAgeMs = optionValues[2];
		const now = dateMilliseconds(nowValue);
		if (
			!isPositiveSignedInt32(expectedConfiguredSlots) ||
			!isPositiveSignedInt32(maxAgeMs)
		) {
			return invalidHeartbeat();
		}

		const reconstructed = reconstructHeartbeat(record);
		if (reconstructed.configuredSlots !== expectedConfiguredSlots) return invalidHeartbeat();

		const oldestAllowed = now - maxAgeMs;
		const newestAllowed = now + WORKER_HEARTBEAT_FUTURE_TOLERANCE_MS;
		const processStartedAt = canonicalTimestamp(reconstructed.processStartedAt).milliseconds;
		const publishedAt = canonicalTimestamp(reconstructed.publishedAt).milliseconds;
		if (publishedAt < oldestAllowed || publishedAt > newestAllowed || processStartedAt > newestAllowed) {
			return invalidHeartbeat();
		}

		for (let index = 0; index < reconstructed.slots.length; index += 1) {
			const slot = reconstructed.slots[index];
			if (slot === undefined) return invalidHeartbeat();
			const lastSuccessfulPollAt = canonicalTimestamp(slot.lastSuccessfulPollAt).milliseconds;
			const lastProgressAt = canonicalTimestamp(slot.lastProgressAt).milliseconds;
			if (
				lastSuccessfulPollAt > newestAllowed ||
				lastProgressAt < oldestAllowed ||
				lastProgressAt > newestAllowed
			) {
				return invalidHeartbeat();
			}
		}
	} catch {
		return invalidHeartbeat();
	}
}
