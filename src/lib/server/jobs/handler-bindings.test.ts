import { describe, expect, expectTypeOf, it } from 'vitest';
import { REGISTERED_JOB_KINDS, type RegisteredJobKind } from './catalog';
import {
  createRegisteredJobHandlerMap,
  type RegisteredJobHandlerBinding
} from './handler-bindings';
import type { JobHandler } from './types';

const ERROR_MESSAGE = 'Worker job handlers do not exactly match the registered catalog';

const createHandler = (): JobHandler => async () => undefined;

const bindingsForEveryRegisteredKind = (): readonly RegisteredJobHandlerBinding[] =>
  REGISTERED_JOB_KINDS.map((kind) => ({ kind, handler: createHandler() }));

const bindingsWithReplacement = (replacement: unknown, index = 0): readonly unknown[] => {
  const bindings: unknown[] = [...bindingsForEveryRegisteredKind()];
  bindings[index] = replacement;
  return bindings;
};

const expectRejected = (value: unknown): void => {
  expect(() => createRegisteredJobHandlerMap(
    value as readonly RegisteredJobHandlerBinding[]
  )).toThrowError(new Error(ERROR_MESSAGE));
};

describe('createRegisteredJobHandlerMap', () => {
  it('accepts every registered binding in any input order and reconstructs catalog order', () => {
    const bindings = bindingsForEveryRegisteredKind();
    const shuffled = [...bindings.slice(5), ...bindings.slice(0, 5)];

    const handlers = createRegisteredJobHandlerMap(shuffled);

    expect([...handlers.keys()]).toEqual(REGISTERED_JOB_KINDS);
    expect([...handlers.values()]).toEqual(
      REGISTERED_JOB_KINDS.map((kind) => bindings.find((binding) => binding.kind === kind)!.handler)
    );
    expect([...handlers.entries()]).toEqual(REGISTERED_JOB_KINDS.map((kind) => [
      kind,
      bindings.find((binding) => binding.kind === kind)!.handler
    ]));
    expect(handlers).toBeInstanceOf(Map);
    expect(handlers).not.toBe(bindings);
    expectTypeOf(handlers).toEqualTypeOf<ReadonlyMap<RegisteredJobKind, JobHandler>>();
  });

  it('does not retain a mutable input-array relationship', () => {
    const bindings = [...bindingsForEveryRegisteredKind()];
    const handlers = createRegisteredJobHandlerMap(bindings);
    const original = handlers.get(REGISTERED_JOB_KINDS[0]);

    bindings[0] = { kind: REGISTERED_JOB_KINDS[0], handler: createHandler() };

    expect(handlers.get(REGISTERED_JOB_KINDS[0])).toBe(original);
    expect([...handlers.keys()]).toEqual(REGISTERED_JOB_KINDS);
  });

  it('rejects a missing registered binding with the fixed error', () => {
    expectRejected(bindingsForEveryRegisteredKind().slice(1));
  });

  it('rejects duplicate registered bindings with the fixed error', () => {
    const bindings = bindingsForEveryRegisteredKind();
    expectRejected([bindings[0]!, bindings[0]!, ...bindings.slice(2)]);
  });

  it('rejects an unregistered binding with the fixed error', () => {
    const bindings = bindingsForEveryRegisteredKind();
    expectRejected([
      ...bindings.slice(1),
      { kind: 'jobs.unregistered', handler: createHandler() }
    ]);
  });

  it('rejects a nonfunction handler with the fixed error', () => {
    const bindings = bindingsForEveryRegisteredKind();
    expectRejected([
      { kind: bindings[0]!.kind, handler: {} },
      ...bindings.slice(1)
    ]);
  });

  it('fails closed for malformed binding containers without reflecting their values', () => {
    for (const value of [undefined, null, {}, new Set(bindingsForEveryRegisteredKind()), 'bindings']) {
      expectRejected(value);
    }

    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    expectRejected(revoked.proxy);
  });

  it('fails closed for malformed binding entries, kinds, and handlers', () => {
    const handler = createHandler();
    const malformedEntries: unknown[] = [
      undefined,
      null,
      'binding',
      1,
      handler,
      [],
      {},
      { kind: REGISTERED_JOB_KINDS[0] },
      { handler },
      { kind: null, handler },
      { kind: 1, handler },
      { kind: Symbol('registered'), handler },
      { kind: 'jobs.unregistered', handler },
      { kind: REGISTERED_JOB_KINDS[0], handler: undefined },
      { kind: REGISTERED_JOB_KINDS[0], handler: null },
      { kind: REGISTERED_JOB_KINDS[0], handler: {} }
    ];

    for (const entry of malformedEntries) expectRejected(bindingsWithReplacement(entry));
  });

  it('fails closed for a sparse binding array at descriptor validation', () => {
    const bindings = [...bindingsForEveryRegisteredKind()];
    delete bindings[4];

    expect(bindings).toHaveLength(REGISTERED_JOB_KINDS.length);
    expectRejected(bindings);
  });

  it('fails closed when a binding-array proxy throws during length descriptor validation', () => {
    const trapError = new Error('length descriptor trap must not be exposed');
    const bindings = new Proxy([...bindingsForEveryRegisteredKind()], {
      getOwnPropertyDescriptor: () => { throw trapError; }
    });

    expectRejected(bindings);
  });

  it('fails closed when a binding-array proxy throws during an index descriptor validation', () => {
    let lengthValidated = false;
    const trapError = new Error('index descriptor trap must not be exposed');
    const bindings = new Proxy([...bindingsForEveryRegisteredKind()], {
      getOwnPropertyDescriptor: (target, key) => {
        if (key === 'length') {
          lengthValidated = true;
          return Reflect.getOwnPropertyDescriptor(target, key);
        }
        if (key === '0') throw trapError;
        return Reflect.getOwnPropertyDescriptor(target, key);
      }
    });

    expectRejected(bindings);
    expect(lengthValidated).toBe(true);
  });

  it('rejects accessor bindings without invoking their accessors or exposing their errors', () => {
    let kindReads = 0;
    let handlerReads = 0;
    const accessorBinding = Object.defineProperties({}, {
      kind: {
        enumerable: true,
        get: () => {
          kindReads += 1;
          throw new Error('kind accessor must not be invoked');
        }
      },
      handler: {
        enumerable: true,
        get: () => {
          handlerReads += 1;
          throw new Error('handler accessor must not be invoked');
        }
      }
    });

    expectRejected(bindingsWithReplacement(accessorBinding));
    expect(kindReads).toBe(0);
    expect(handlerReads).toBe(0);
  });

  it('rejects inherited binding fields without invoking an inherited accessor', () => {
    let reads = 0;
    const inherited = Object.create({
      get kind() {
        reads += 1;
        throw new Error('inherited kind accessor must not be invoked');
      },
      handler: createHandler()
    });

    expectRejected(bindingsWithReplacement(inherited));
    expect(reads).toBe(0);
  });
});
