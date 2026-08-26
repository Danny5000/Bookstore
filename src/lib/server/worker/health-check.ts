import { open as openFile } from 'node:fs/promises';

import {
	WORKER_HEARTBEAT_MAX_BYTES,
	parseWorkerHeartbeat,
	validateWorkerHeartbeatFreshness
} from './heartbeat-contract';

const UNHEALTHY_LINE = '[worker-health] unhealthy';

export interface WorkerHealthCheckOptions {
	readonly heartbeatFile: string;
	readonly configuredSlots: number;
	readonly maxAgeMs: number;
	readonly now?: () => Date;
	readonly filesystem?: WorkerHealthFilesystem;
	readonly stderr?: (line: string) => void;
}

export interface WorkerHealthFileStat {
	readonly size: number;
	isFile(): boolean;
}

export interface WorkerHealthFileHandle {
	stat(): Promise<WorkerHealthFileStat>;
	readFile(options: { readonly encoding: 'utf8' }): Promise<string>;
	close(): Promise<void>;
}

export interface WorkerHealthFilesystem {
	open(path: string, flags: 'r'): Promise<WorkerHealthFileHandle>;
}

const nodeFilesystem: WorkerHealthFilesystem = {
	open: (path, flags) => openFile(path, flags)
};

function reportUnhealthy(stderr: (line: string) => void): 1 {
	try {
		stderr(UNHEALTHY_LINE);
	} catch {
		// Health checks must remain fail-closed even when the output sink is unavailable.
	}
	return 1;
}

export async function runWorkerHealthCheck(
	options: WorkerHealthCheckOptions
): Promise<0 | 1> {
	let stderr = (line: string): void => console.error(line);
	let handle: WorkerHealthFileHandle | undefined;
	let failed = false;

	try {
		stderr = options.stderr ?? stderr;
		const heartbeatFile = options.heartbeatFile;
		const configuredSlots = options.configuredSlots;
		const maxAgeMs = options.maxAgeMs;
		const now = options.now ?? (() => new Date());
		const filesystem = options.filesystem ?? nodeFilesystem;

		handle = await filesystem.open(heartbeatFile, 'r');
		const stat = await handle.stat();
		if (
			!stat.isFile() ||
			!Number.isSafeInteger(stat.size) ||
			stat.size < 1 ||
			stat.size > WORKER_HEARTBEAT_MAX_BYTES
		) {
			throw new TypeError('invalid worker heartbeat file');
		}

		const raw = await handle.readFile({ encoding: 'utf8' });
		if (Buffer.byteLength(raw, 'utf8') !== stat.size) {
			throw new TypeError('changed worker heartbeat file');
		}

		const record = parseWorkerHeartbeat(raw);
		validateWorkerHeartbeatFreshness(record, {
			now: now(),
			configuredSlots,
			maxAgeMs
		});
	} catch {
		failed = true;
	}

	if (handle !== undefined) {
		try {
			await handle.close();
		} catch {
			failed = true;
		}
	}

	return failed ? reportUnhealthy(stderr) : 0;
}
