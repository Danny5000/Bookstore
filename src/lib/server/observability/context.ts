import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import {
  isCanonicalLowercaseUuid,
  isCorrelationId,
  isNonnegativeSignedInt32,
  isPositiveSignedInt32,
  isSafeToken,
  isWorkerId,
  type CorrelationId
} from './contracts';

export interface WebDiagnosticContext {
  readonly kind: 'web';
  readonly correlationId: CorrelationId;
}

export interface JobDiagnosticContext {
  readonly kind: 'job';
  readonly correlationId: CorrelationId;
  readonly jobId: string;
  readonly jobKind: string;
  readonly attempt: number;
  readonly generation?: number;
  readonly workerId: string;
  readonly slotId: number;
}

export type DiagnosticContext = WebDiagnosticContext | JobDiagnosticContext;

const diagnosticContextStorage = new AsyncLocalStorage<DiagnosticContext>();

function invalidContext(): never {
  throw new TypeError('invalid diagnostic context');
}

export function normalizeOrCreateCorrelationId(
  value: unknown,
  uuidSource: () => string = randomUUID
): CorrelationId {
  if (isCorrelationId(value)) return value;
  const generated = uuidSource();
  return isCanonicalLowercaseUuid(generated) ? generated as CorrelationId : invalidContext();
}

function reconstructContext(context: DiagnosticContext): DiagnosticContext {
  if (context.kind === 'web') {
    if (!isCorrelationId(context.correlationId)) return invalidContext();
    return Object.freeze({ kind: 'web', correlationId: context.correlationId });
  }

  if (context.kind !== 'job'
    || !isCorrelationId(context.correlationId)
    || !isCanonicalLowercaseUuid(context.jobId)
    || !isSafeToken(context.jobKind)
    || !isPositiveSignedInt32(context.attempt)
    || !isWorkerId(context.workerId)
    || !isNonnegativeSignedInt32(context.slotId)) {
    return invalidContext();
  }

  if (Object.hasOwn(context, 'generation')) {
    if (!isPositiveSignedInt32(context.generation)) return invalidContext();
    return Object.freeze({
      kind: 'job',
      correlationId: context.correlationId,
      jobId: context.jobId,
      jobKind: context.jobKind,
      attempt: context.attempt,
      generation: context.generation,
      workerId: context.workerId,
      slotId: context.slotId
    });
  }

  return Object.freeze({
    kind: 'job',
    correlationId: context.correlationId,
    jobId: context.jobId,
    jobKind: context.jobKind,
    attempt: context.attempt,
    workerId: context.workerId,
    slotId: context.slotId
  });
}

export function runWithDiagnosticContext<T>(context: DiagnosticContext, callback: () => T): T {
  return diagnosticContextStorage.run(reconstructContext(context), callback);
}

export function getDiagnosticContext(): DiagnosticContext | undefined {
  return diagnosticContextStorage.getStore();
}

export function correlationIdForRequest(
  request: Request,
  uuidSource?: () => string
): CorrelationId {
  const active = getDiagnosticContext();
  return active?.correlationId ?? normalizeOrCreateCorrelationId(request.headers.get('x-request-id'), uuidSource);
}
