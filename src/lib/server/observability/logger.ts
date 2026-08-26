import {
  validateLoggingFailure,
  validateStructuredEvent,
  type StructuredEventInputFor,
  type StructuredLogService
} from './contracts';

export type StructuredLogSink = (line: string) => void;

export interface StructuredLogger<S extends StructuredLogService> {
  emit(input: StructuredEventInputFor<S>): void;
}

const EPOCH = '1970-01-01T00:00:00.000Z';

function currentTimestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError('invalid structured log clock');
  const timestamp = value.toISOString();
  if (new Date(timestamp).toISOString() !== timestamp) throw new TypeError('invalid structured log clock');
  return timestamp;
}

function line(record: Readonly<Record<string, string | number | boolean>>): string {
  return `${JSON.stringify(record)}\n`;
}

export function createStructuredLogger<S extends StructuredLogService>(options: {
  readonly service: S;
  readonly environment: 'development' | 'test' | 'production';
  readonly now?: () => Date;
  readonly stdout?: StructuredLogSink;
  readonly stderr?: StructuredLogSink;
}): StructuredLogger<S> {
  const now = options.now ?? (() => new Date());
  const stdout = options.stdout ?? ((value) => { process.stdout.write(value); });
  const stderr = options.stderr ?? ((value) => { process.stderr.write(value); });

  return {
    emit(input) {
      let timestamp = EPOCH;
      try {
        timestamp = currentTimestamp(now);
        const validated = validateStructuredEvent(options.service, timestamp, input);
        (validated.sink === 'stdout' ? stdout : stderr)(line(validated.record));
      } catch (cause) {
        if (options.environment !== 'production') throw cause;
        try {
          const failure = validateLoggingFailure(options.service, timestamp);
          stderr(line(failure.record));
        } catch { /* logging must never alter production domain outcomes */ }
      }
    }
  };
}
