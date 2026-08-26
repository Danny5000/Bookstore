import { loadWorkerHealthConfig } from '$lib/server/config/worker';
import { runWorkerHealthCheck } from '$lib/server/worker/health-check';

const UNHEALTHY_LINE = '[worker-health] unhealthy';

try {
	const config = loadWorkerHealthConfig(process.env);
	process.exitCode = await runWorkerHealthCheck({
		heartbeatFile: config.heartbeatFile,
		configuredSlots: config.concurrency,
		maxAgeMs: config.heartbeatMaxAgeMs,
		now: () => new Date()
	});
} catch {
	console.error(UNHEALTHY_LINE);
	process.exitCode = 1;
}
