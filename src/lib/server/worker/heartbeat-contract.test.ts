import { describe, expect, test, vi } from 'vitest';

import {
	WORKER_HEARTBEAT_FUTURE_TOLERANCE_MS,
	WORKER_HEARTBEAT_MAX_BYTES,
	encodeWorkerHeartbeat,
	parseWorkerHeartbeat,
	validateWorkerHeartbeatFreshness
} from './heartbeat-contract';
import type {
	WorkerHeartbeatRecord,
	WorkerHeartbeatSlotRecord,
	WorkerSlotState
} from './heartbeat-contract';

const PROCESS_STARTED_AT = '2026-08-24T12:00:00.000Z';
const PUBLISHED_AT = '2026-08-24T12:00:05.000Z';
const INVALID_HEARTBEAT_MESSAGE = 'invalid worker heartbeat';

function slot(
	slotId: number,
	state: WorkerSlotState,
	lastSuccessfulPollAt = '2026-08-24T12:00:01.000Z',
	lastProgressAt = '2026-08-24T12:00:02.000Z'
): WorkerHeartbeatSlotRecord {
	return { slotId, state, lastSuccessfulPollAt, lastProgressAt };
}

function record(overrides: Partial<WorkerHeartbeatRecord> = {}): WorkerHeartbeatRecord {
	return {
		version: 1,
		workerId: 'worker:42:abc_DEF-1.2',
		processStartedAt: PROCESS_STARTED_AT,
		publishedAt: PUBLISHED_AT,
		sequence: 7,
		configuredSlots: 3,
		slots: [
			slot(0, 'polling'),
			slot(1, 'idle', '2026-08-24T12:00:02.000Z', '2026-08-24T12:00:03.000Z'),
			slot(2, 'handling', '2026-08-24T12:00:03.000Z', '2026-08-24T12:00:04.000Z')
		],
		...overrides
	};
}

const encodeUnknown = encodeWorkerHeartbeat as (value: unknown) => string;
const parseUnknown = parseWorkerHeartbeat as (value: unknown) => WorkerHeartbeatRecord;
const validateUnknown = validateWorkerHeartbeatFreshness as (
	record: unknown,
	options: unknown
) => void;

function captureInvalid(callback: () => unknown): Error {
	let caught: unknown;
	try {
		callback();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(TypeError);
	if (!(caught instanceof Error)) throw new Error('expected heartbeat validation to fail');
	expect(caught.message).toBe(INVALID_HEARTBEAT_MESSAGE);
	return caught;
}

function parsedObject(raw = encodeWorkerHeartbeat(record())): Record<string, unknown> {
	return JSON.parse(raw) as Record<string, unknown>;
}

function iso(milliseconds: number): string {
	return new Date(milliseconds).toISOString();
}

describe('worker heartbeat contract', () => {
	test('exports the exact constants and accepts all three slot states', () => {
		expect(WORKER_HEARTBEAT_MAX_BYTES).toBe(65_536);
		expect(WORKER_HEARTBEAT_FUTURE_TOLERANCE_MS).toBe(5_000);

		const states: readonly WorkerSlotState[] = ['polling', 'idle', 'handling'];
		const parsed = parseWorkerHeartbeat(encodeWorkerHeartbeat(record()));
		expect(parsed.slots.map((entry) => entry.state)).toEqual(states);
	});

	test('encodes exact interface-order compact canonical JSON without a newline', () => {
		const encoded = encodeWorkerHeartbeat(record());
		const expected =
			'{"version":1,"workerId":"worker:42:abc_DEF-1.2","processStartedAt":"2026-08-24T12:00:00.000Z","publishedAt":"2026-08-24T12:00:05.000Z","sequence":7,"configuredSlots":3,"slots":[' +
			'{"slotId":0,"state":"polling","lastSuccessfulPollAt":"2026-08-24T12:00:01.000Z","lastProgressAt":"2026-08-24T12:00:02.000Z"},' +
			'{"slotId":1,"state":"idle","lastSuccessfulPollAt":"2026-08-24T12:00:02.000Z","lastProgressAt":"2026-08-24T12:00:03.000Z"},' +
			'{"slotId":2,"state":"handling","lastSuccessfulPollAt":"2026-08-24T12:00:03.000Z","lastProgressAt":"2026-08-24T12:00:04.000Z"}]}';

		expect(encoded).toBe(expected);
		expect(encoded.endsWith('\n')).toBe(false);
		expect(Buffer.byteLength(encoded, 'utf8')).toBeLessThanOrEqual(WORKER_HEARTBEAT_MAX_BYTES);
	});

	test('reconstructs and freezes exact plain output records, the slot array, and every slot', () => {
		const parsed = parseWorkerHeartbeat(encodeWorkerHeartbeat(record()));

		expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
		expect(Object.keys(parsed)).toEqual([
			'version',
			'workerId',
			'processStartedAt',
			'publishedAt',
			'sequence',
			'configuredSlots',
			'slots'
		]);
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.getPrototypeOf(parsed.slots)).toBe(Array.prototype);
		expect(Object.isFrozen(parsed.slots)).toBe(true);
		for (const parsedSlot of parsed.slots) {
			expect(Object.getPrototypeOf(parsedSlot)).toBe(Object.prototype);
			expect(Object.keys(parsedSlot)).toEqual([
				'slotId',
				'state',
				'lastSuccessfulPollAt',
				'lastProgressAt'
			]);
			expect(Object.isFrozen(parsedSlot)).toBe(true);
		}
	});

	test.each([
		['a', true],
		[`a${'x'.repeat(199)}`, true],
		['worker._:-1', true],
		['', false],
		[':worker', false],
		['-worker', false],
		['worker id', false],
		['wörker', false],
		['a'.repeat(201), false]
	])('enforces the worker identifier grammar for %#', (workerId, accepted) => {
		const candidate = record({ workerId });
		if (accepted) expect(parseWorkerHeartbeat(encodeWorkerHeartbeat(candidate)).workerId).toBe(workerId);
		else captureInvalid(() => encodeWorkerHeartbeat(candidate));
	});

	test.each([
		['version', 2],
		['version', '1'],
		['workerId', null],
		['sequence', 0],
		['sequence', -1],
		['sequence', 1.5],
		['sequence', 2_147_483_648],
		['sequence', Number.NaN],
		['sequence', Infinity],
		['configuredSlots', 0],
		['configuredSlots', -1],
		['configuredSlots', 1.5],
		['configuredSlots', 2_147_483_648],
		['configuredSlots', Number.NaN],
		['configuredSlots', Infinity]
	])('rejects invalid top-level primitive %s=%p', (key, value) => {
		captureInvalid(() => encodeUnknown({ ...record(), [key]: value }));
	});

	test.each([
		['slotId', -1],
		['slotId', 1.5],
		['slotId', 2_147_483_648],
		['slotId', Number.NaN],
		['state', 'waiting'],
		['state', 'POLLING'],
		['state', null],
		['lastSuccessfulPollAt', null],
		['lastProgressAt', 1]
	])('rejects invalid slot primitive %s=%p', (key, value) => {
		const slots = record().slots.map((entry) => ({ ...entry }));
		slots[0] = { ...slots[0], [key]: value } as WorkerHeartbeatSlotRecord;
		captureInvalid(() => encodeUnknown({ ...record(), slots }));
	});

	test.each([
		'2026-08-24T12:00:00Z',
		'2026-08-24T12:00:00.00Z',
		'2026-08-24T12:00:00.0000Z',
		'2026-08-24T08:00:00.000-04:00',
		'2026-08-24t12:00:00.000z',
		'2026-02-30T12:00:00.000Z',
		'+010000-01-01T00:00:00.000Z',
		'not-a-date',
		''
	])('rejects noncanonical or invalid timestamp %#', (value) => {
		captureInvalid(() => encodeWorkerHeartbeat(record({ processStartedAt: value })));
	});

	test.each([
		{
			name: 'publication before process start',
			value: record({ publishedAt: '2026-08-24T11:59:59.999Z' })
		},
		{
			name: 'successful poll before process start',
			value: record({ slots: [slot(0, 'idle', '2026-08-24T11:59:59.999Z', '2026-08-24T12:00:02.000Z')] , configuredSlots: 1 })
		},
		{
			name: 'progress before successful poll',
			value: record({ slots: [slot(0, 'handling', '2026-08-24T12:00:03.000Z', '2026-08-24T12:00:02.999Z')], configuredSlots: 1 })
		},
		{
			name: 'publication before slot progress',
			value: record({ slots: [slot(0, 'handling', '2026-08-24T12:00:03.000Z', '2026-08-24T12:00:05.001Z')], configuredSlots: 1 })
		}
	])('rejects structural time disorder: $name', ({ value }) => {
		captureInvalid(() => encodeWorkerHeartbeat(value));
	});

	test('requires exactly one ascending zero-based slot per configured slot', () => {
		const validSlots = record().slots;
		const invalidSlots: readonly (readonly WorkerHeartbeatSlotRecord[])[] = [
			[],
			validSlots.slice(0, 2),
			[...validSlots, slot(3, 'idle')],
			[validSlots[0]!, validSlots[0]!, validSlots[2]!],
			[validSlots[0]!, validSlots[2]!, validSlots[1]!],
			[slot(1, 'polling'), validSlots[1]!, validSlots[2]!]
		];

		for (const slots of invalidSlots) {
			captureInvalid(() => encodeWorkerHeartbeat(record({ slots })));
		}
	});

	test('rejects top-level and nested extras, missing keys, symbols, arrays, null, and custom prototypes', () => {
		const base = record();
		const missing = { ...base } as Record<string, unknown>;
		delete missing.publishedAt;
		const topSymbol = { ...base, [Symbol('secret')]: 'privacy-canary' };
		const customTop = Object.assign(Object.create({ inherited: 'privacy-canary' }) as Record<string, unknown>, base);
		const slotExtra = [{ ...base.slots[0], secret: 'privacy-canary' }, ...base.slots.slice(1)];
		const slotMissing = base.slots.map((entry) => ({ ...entry })) as Array<Record<string, unknown>>;
		delete slotMissing[0]!.state;
		const slotSymbol = [{ ...base.slots[0], [Symbol('secret')]: 'privacy-canary' }, ...base.slots.slice(1)];
		const customSlot = Object.assign(Object.create({ inherited: true }) as Record<string, unknown>, base.slots[0]);

		for (const candidate of [
			null,
			[],
			{ ...base, secret: 'privacy-canary' },
			missing,
			topSymbol,
			customTop,
			{ ...base, slots: null },
			{ ...base, slots: {} },
			{ ...base, slots: slotExtra },
			{ ...base, slots: slotMissing },
			{ ...base, slots: slotSymbol },
			{ ...base, slots: [customSlot, ...base.slots.slice(1)] }
		]) {
			captureInvalid(() => encodeUnknown(candidate));
		}
	});

	test('rejects accessors without reading them and fails closed on hostile reflection', () => {
		let reads = 0;
		const accessor = { ...record() } as Record<string, unknown>;
		Object.defineProperty(accessor, 'workerId', {
			enumerable: true,
			get: () => {
				reads += 1;
				return 'worker-1';
			}
		});
		const accessorSlot = { ...record().slots[0] } as Record<string, unknown>;
		Object.defineProperty(accessorSlot, 'state', {
			enumerable: true,
			get: () => {
				reads += 1;
				return 'idle';
			}
		});
		const accessorArray = [...record().slots];
		Object.defineProperty(accessorArray, '0', {
			enumerable: true,
			get: () => {
				reads += 1;
				return record().slots[0];
			}
		});
		const hostile = new Proxy({}, {
			getPrototypeOf: () => {
				throw new Error('privacy-canary');
			}
		});

		captureInvalid(() => encodeUnknown(accessor));
		captureInvalid(() => encodeUnknown({ ...record(), slots: [accessorSlot, ...record().slots.slice(1)] }));
		captureInvalid(() => encodeUnknown({ ...record(), slots: accessorArray }));
		captureInvalid(() => encodeUnknown(hostile));
		expect(reads).toBe(0);
	});

	test('does not invoke inherited array-index setters while reconstructing or serializing', () => {
		const candidate = record();
		const previous = Object.getOwnPropertyDescriptor(Array.prototype, '0');
		let inheritedWrites = 0;
		let encoded: string | undefined;
		let caught: unknown;
		Object.defineProperty(Array.prototype, '0', {
			configurable: true,
			set: () => {
				inheritedWrites += 1;
			}
		});
		try {
			try {
				encoded = encodeWorkerHeartbeat(candidate);
			} catch (error) {
				caught = error;
			}
		} finally {
			if (previous === undefined) delete (Array.prototype as unknown as Record<string, unknown>)['0'];
			else Object.defineProperty(Array.prototype, '0', previous);
		}

		expect(caught).toBeUndefined();
		expect(inheritedWrites).toBe(0);
		expect(encoded).toBeTypeOf('string');
	});

	test('rejects encoded records that would exceed the parser byte contract', () => {
		const slots = Array.from({ length: 600 }, (_, slotId) =>
			slot(slotId, 'idle', '2026-08-24T12:00:01.000Z', '2026-08-24T12:00:02.000Z')
		);
		captureInvalid(() => encodeWorkerHeartbeat(record({ configuredSlots: slots.length, slots })));
	});

	test('enforces the UTF-8 byte limit before invoking JSON.parse', () => {
		const parse = vi.spyOn(JSON, 'parse');
		try {
			const oversized = `"${'🔐'.repeat(WORKER_HEARTBEAT_MAX_BYTES / 2)}privacy-canary"`;
			expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(WORKER_HEARTBEAT_MAX_BYTES);
			captureInvalid(() => parseWorkerHeartbeat(oversized));
			expect(parse).not.toHaveBeenCalled();
		} finally {
			parse.mockRestore();
		}
	});

	test('replaces JSON syntax details and privacy canaries with one fixed internal error', () => {
		for (const raw of [
			'{',
			'{"workerId":"privacy-canary"',
			'privacy-canary',
			'\ufeff{}'
		]) {
			const error = captureInvalid(() => parseWorkerHeartbeat(raw));
			expect(error.message).not.toContain('privacy-canary');
		}
	});

	test('accepts only the exact canonical JSON representation', () => {
		const canonical = encodeWorkerHeartbeat(record());
		const value = parsedObject(canonical);
		const reordered = JSON.stringify({
			workerId: value.workerId,
			version: value.version,
			processStartedAt: value.processStartedAt,
			publishedAt: value.publishedAt,
			sequence: value.sequence,
			configuredSlots: value.configuredSlots,
			slots: value.slots
		});
		const nestedReordered = JSON.stringify({
			...value,
			slots: record().slots.map((entry) => ({
				state: entry.state,
				slotId: entry.slotId,
				lastSuccessfulPollAt: entry.lastSuccessfulPollAt,
				lastProgressAt: entry.lastProgressAt
			}))
		});
		const alternatives = [
			` ${canonical}`,
			`${canonical} `,
			`${canonical}\n`,
			JSON.stringify(value, null, 2),
			reordered,
			nestedReordered,
			canonical.replace('{"version":1', '{"version":1,"version":1'),
			canonical.replace('{"slotId":0', '{"slotId":0,"slotId":0'),
			canonical.replace('"version":1', '"version":1.0'),
			canonical.replace('"sequence":7', '"sequence":7e0'),
			canonical.replace('"slotId":0', '"slotId":-0'),
			canonical.replace('T12:', 'T12\\u003A')
		];

		for (const alternative of alternatives) {
			expect(alternative).not.toBe(canonical);
			captureInvalid(() => parseWorkerHeartbeat(alternative));
		}
	});

	test('rejects parsed extra, missing, null, array, and prototype-pollution-shaped objects', () => {
		const base = parsedObject();
		const missing = { ...base };
		delete missing.sequence;
		const nested = (base.slots as Array<Record<string, unknown>>).map((entry) => ({ ...entry }));
		nested[0]!.secret = 'privacy-canary';
		const rawCandidates = [
			'null',
			'[]',
			JSON.stringify({ ...base, secret: 'privacy-canary' }),
			JSON.stringify(missing),
			JSON.stringify({ ...base, slots: null }),
			JSON.stringify({ ...base, slots: {} }),
			JSON.stringify({ ...base, slots: nested }),
			`{"version":1,"workerId":"worker-1","processStartedAt":"${PROCESS_STARTED_AT}","publishedAt":"${PUBLISHED_AT}","sequence":1,"configuredSlots":1,"slots":[],"__proto__":{"secret":"privacy-canary"}}`
		];

		for (const raw of rawCandidates) captureInvalid(() => parseWorkerHeartbeat(raw));
	});

	test('rejects duplicate, missing, out-of-order, nonzero-origin, and count-mismatched parsed slots', () => {
		const base = parsedObject();
		const slots = (base.slots as Array<Record<string, unknown>>).map((entry) => ({ ...entry }));
		const candidates = [
			{ ...base, slots: [] },
			{ ...base, slots: slots.slice(0, 2) },
			{ ...base, slots: [slots[0], slots[0], slots[2]] },
			{ ...base, slots: [slots[1], slots[0], slots[2]] },
			{ ...base, slots: [{ ...slots[0], slotId: 1 }, slots[1], slots[2]] },
			{ ...base, configuredSlots: 2, slots }
		];

		for (const candidate of candidates) captureInvalid(() => parseWorkerHeartbeat(JSON.stringify(candidate)));
	});

	test('rejects invalid parsed versions, counts, worker IDs, states, and timestamps', () => {
		const base = parsedObject();
		const slots = base.slots as Array<Record<string, unknown>>;
		const candidates = [
			{ ...base, version: 2 },
			{ ...base, workerId: ':privacy-canary' },
			{ ...base, sequence: 0 },
			{ ...base, sequence: -1 },
			{ ...base, sequence: 2_147_483_648 },
			{ ...base, configuredSlots: 0, slots: [] },
			{ ...base, configuredSlots: 2_147_483_648 },
			{ ...base, processStartedAt: '2026-08-24T12:00:00Z' },
			{ ...base, publishedAt: 'not-a-date' },
			{ ...base, slots: [{ ...slots[0], state: 'waiting' }, ...slots.slice(1)] },
			{ ...base, slots: [{ ...slots[0], lastProgressAt: '2026-08-24T12:00:00Z' }, ...slots.slice(1)] }
		];

		for (const candidate of candidates) captureInvalid(() => parseWorkerHeartbeat(JSON.stringify(candidate)));
	});

	describe('freshness validation', () => {
		const nowMilliseconds = Date.parse(PUBLISHED_AT);
		const validOptions = {
			now: new Date(nowMilliseconds),
			configuredSlots: 3,
			maxAgeMs: 5_000
		};

		test('accepts publication and every progress timestamp exactly at the age boundary', () => {
			const boundary = nowMilliseconds - validOptions.maxAgeMs;
			const candidate = record({
				processStartedAt: iso(boundary - 2_000),
				publishedAt: iso(boundary),
				slots: [
					slot(0, 'polling', iso(boundary - 1_000), iso(boundary)),
					slot(1, 'idle', iso(boundary - 1_000), iso(boundary)),
					slot(2, 'handling', iso(boundary - 1_000), iso(boundary))
				]
			});

			expect(() => validateWorkerHeartbeatFreshness(candidate, validOptions)).not.toThrow();
		});

		test('rejects publication one millisecond beyond the age boundary', () => {
			const stale = nowMilliseconds - validOptions.maxAgeMs - 1;
			const candidate = record({
				processStartedAt: iso(stale - 2_000),
				publishedAt: iso(stale),
				slots: [
					slot(0, 'polling', iso(stale - 1_000), iso(stale)),
					slot(1, 'idle', iso(stale - 1_000), iso(stale)),
					slot(2, 'handling', iso(stale - 1_000), iso(stale))
				]
			});

			captureInvalid(() => validateWorkerHeartbeatFreshness(candidate, validOptions));
		});

		test('rejects one stale slot among fresh peers', () => {
			const stale = nowMilliseconds - validOptions.maxAgeMs - 1;
			const candidate = record({
				processStartedAt: iso(stale - 2_000),
				publishedAt: iso(nowMilliseconds),
				slots: [
					slot(0, 'polling', iso(stale), iso(nowMilliseconds)),
					slot(1, 'idle', iso(stale - 1_000), iso(stale)),
					slot(2, 'handling', iso(stale), iso(nowMilliseconds))
				]
			});

			captureInvalid(() => validateWorkerHeartbeatFreshness(candidate, validOptions));
		});

		test('does not require lastSuccessfulPollAt itself to be fresh', () => {
			const old = nowMilliseconds - 60_000;
			const candidate = record({
				processStartedAt: iso(old - 1_000),
				publishedAt: iso(nowMilliseconds),
				slots: [
					slot(0, 'handling', iso(old), iso(nowMilliseconds - 1)),
					slot(1, 'handling', iso(old), iso(nowMilliseconds - 1)),
					slot(2, 'handling', iso(old), iso(nowMilliseconds - 1))
				]
			});

			expect(() => validateWorkerHeartbeatFreshness(candidate, validOptions)).not.toThrow();
		});

		test('accepts every timestamp exactly at the future-tolerance boundary', () => {
			const boundary = nowMilliseconds + WORKER_HEARTBEAT_FUTURE_TOLERANCE_MS;
			const value = iso(boundary);
			const candidate = record({
				processStartedAt: value,
				publishedAt: value,
				slots: [slot(0, 'polling', value, value), slot(1, 'idle', value, value), slot(2, 'handling', value, value)]
			});

			expect(() => validateWorkerHeartbeatFreshness(candidate, validOptions)).not.toThrow();
		});

		test('rejects timestamps one millisecond beyond future tolerance', () => {
			const outside = nowMilliseconds + WORKER_HEARTBEAT_FUTURE_TOLERANCE_MS + 1;
			const value = iso(outside);
			const candidate = record({
				processStartedAt: value,
				publishedAt: value,
				slots: [slot(0, 'polling', value, value), slot(1, 'idle', value, value), slot(2, 'handling', value, value)]
			});

			captureInvalid(() => validateWorkerHeartbeatFreshness(candidate, validOptions));
		});

		test('requires the independently loaded configured-slot count to match', () => {
			captureInvalid(() => validateWorkerHeartbeatFreshness(record(), { ...validOptions, configuredSlots: 2 }));
		});

		test('is stateless and does not claim historical sequence monotonicity', () => {
			expect(() => validateWorkerHeartbeatFreshness(record({ sequence: 2_147_483_647 }), validOptions)).not.toThrow();
			expect(() => validateWorkerHeartbeatFreshness(record({ sequence: 1 }), validOptions)).not.toThrow();
		});

		test.each([
			['configuredSlots', 0],
			['configuredSlots', -1],
			['configuredSlots', 1.5],
			['configuredSlots', 2_147_483_648],
			['configuredSlots', Number.NaN],
			['configuredSlots', Infinity],
			['maxAgeMs', 0],
			['maxAgeMs', -1],
			['maxAgeMs', 1.5],
			['maxAgeMs', 2_147_483_648],
			['maxAgeMs', Number.NaN],
			['maxAgeMs', Infinity]
		])('fails closed for invalid option %s=%p', (key, value) => {
			captureInvalid(() => validateUnknown(record(), { ...validOptions, [key]: value }));
		});

		test.each([
			new Date(Number.NaN),
			PUBLISHED_AT,
			nowMilliseconds,
			null,
			{},
			[]
		])('fails closed for invalid now value %p', (now) => {
			captureInvalid(() => validateUnknown(record(), { ...validOptions, now }));
		});

		test('requires a plain exact options object with own data properties', () => {
			const missing = { ...validOptions } as Record<string, unknown>;
			delete missing.maxAgeMs;
			const symbol = { ...validOptions, [Symbol('secret')]: 'privacy-canary' };
			const custom = Object.assign(Object.create({ inherited: true }) as Record<string, unknown>, validOptions);
			let reads = 0;
			const accessor = { ...validOptions } as Record<string, unknown>;
			Object.defineProperty(accessor, 'maxAgeMs', {
				enumerable: true,
				get: () => {
					reads += 1;
					return 5_000;
				}
			});
			const hostile = new Proxy({}, {
				ownKeys: () => {
					throw new Error('privacy-canary');
				}
			});

			for (const options of [
				null,
				[],
				missing,
				{ ...validOptions, extra: 'privacy-canary' },
				symbol,
				custom,
				accessor,
				hostile
			]) {
				captureInvalid(() => validateUnknown(record(), options));
			}
			expect(reads).toBe(0);
		});

		test('validates the record structurally even when the caller bypasses TypeScript', () => {
			captureInvalid(() => validateUnknown({ ...record(), secret: 'privacy-canary' }, validOptions));
			captureInvalid(() => validateUnknown({ ...record(), processStartedAt: 'not-a-date' }, validOptions));
		});
	});

	test('never includes heartbeat values or unknown fields in validation failures', () => {
		const canary = 'customer@example.test?token=privacy-canary';
		const parseError = captureInvalid(() => parseWorkerHeartbeat(JSON.stringify({ ...parsedObject(), secret: canary })));
		const encodeError = captureInvalid(() => encodeUnknown({ ...record(), workerId: canary }));
		const freshnessError = captureInvalid(() => validateUnknown(record(), { now: new Date(PUBLISHED_AT), configuredSlots: 3, maxAgeMs: 5_000, secret: canary }));

		for (const error of [parseError, encodeError, freshnessError]) {
			expect(error.message).not.toContain(canary);
		}
	});

	test('rejects non-string parser input at runtime', () => {
		for (const value of [null, undefined, 1, {}, [], new String(encodeWorkerHeartbeat(record()))]) {
			captureInvalid(() => parseUnknown(value));
		}
	});
});
