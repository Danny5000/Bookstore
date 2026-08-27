import { REGISTERED_JOB_KINDS, type RegisteredJobKind } from './catalog';
import type { JobHandler } from './types';

const INVALID_HANDLER_BINDINGS =
  'Worker job handlers do not exactly match the registered catalog';
const REGISTERED_JOB_KIND_SET = new Set<string>(REGISTERED_JOB_KINDS);

export interface RegisteredJobHandlerBinding {
  readonly kind: RegisteredJobKind;
  readonly handler: JobHandler;
}

function rejectBindings(): never {
  throw new Error(INVALID_HANDLER_BINDINGS);
}

const ownDataProperty = (value: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return rejectBindings();
  return descriptor.value;
};

export function createRegisteredJobHandlerMap(
  bindings: readonly RegisteredJobHandlerBinding[]
): ReadonlyMap<RegisteredJobKind, JobHandler> {
  try {
    if (!Array.isArray(bindings)) return rejectBindings();

    const length = ownDataProperty(bindings, 'length');
    if (typeof length !== 'number' || length !== REGISTERED_JOB_KINDS.length) {
      return rejectBindings();
    }

    const handlersByKind = new Map<RegisteredJobKind, JobHandler>();
    for (let index = 0; index < length; index += 1) {
      const binding = ownDataProperty(bindings, String(index));
      if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) {
        return rejectBindings();
      }

      const kind = ownDataProperty(binding, 'kind');
      const handler = ownDataProperty(binding, 'handler');
      if (
        typeof kind !== 'string' ||
        !REGISTERED_JOB_KIND_SET.has(kind) ||
        typeof handler !== 'function'
      ) return rejectBindings();

      if (handlersByKind.has(kind as RegisteredJobKind)) return rejectBindings();
      handlersByKind.set(kind as RegisteredJobKind, handler as JobHandler);
    }

    if (handlersByKind.size !== REGISTERED_JOB_KINDS.length) return rejectBindings();
    for (const kind of REGISTERED_JOB_KINDS) {
      if (!handlersByKind.has(kind)) return rejectBindings();
    }

    return new Map(REGISTERED_JOB_KINDS.map((kind) => [
      kind,
      handlersByKind.get(kind)!
    ]));
  } catch {
    return rejectBindings();
  }
}
