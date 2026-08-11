import { z } from 'zod';
import { MAX_CART_TITLES, checkoutRequestSchema } from '$lib/types/commerce';
import type {
  CheckoutRequest,
  CheckoutResultDto,
  CommerceQuoteDto,
  OrderStatusDto
} from '$lib/types/commerce';

export const CHECKOUT_PENDING_STORAGE_KEY = 'paleorbit.pending-checkout.v1';
const MAX_PENDING_CHECKOUT_BYTES = 8 * 1024;

export type CheckoutClientErrorKind =
  | 'invalid_cart'
  | 'attempt_conflict'
  | 'rate_limited'
  | 'temporarily_unavailable'
  | 'checkout_unavailable'
  | 'invalid_response';

export class CheckoutClientError extends Error {
  constructor(readonly kind: CheckoutClientErrorKind) {
    super('Commerce request could not be completed');
    this.name = 'CheckoutClientError';
  }
}

export interface PendingCheckoutState {
  acceptedTitleIds: string[];
  checkoutAttemptId: string;
}

export interface CheckoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type CommerceFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

const moneySchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const currencySchema = z.string().regex(/^[A-Za-z]{3}$/u);
const quoteItemSchema = z.strictObject({
  titleId: z.uuid(),
  slug: z.string().min(1).max(255),
  title: z.string().min(1).max(500),
  creatorName: z.string().min(1).max(500),
  format: z.enum(['prose', 'comic']),
  coverUrl: z.string().regex(/^\/media\/covers\//u).nullable(),
  unitSubtotalMinor: moneySchema,
  currency: currencySchema
});
const quoteSchema = z.strictObject({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  currency: currencySchema.nullable(),
  subtotalMinor: moneySchema,
  items: z.array(quoteItemSchema).max(MAX_CART_TITLES),
  alreadyOwnedTitleIds: z.array(z.uuid()).max(MAX_CART_TITLES),
  claimableTitleIds: z.array(z.uuid()).max(MAX_CART_TITLES),
  reservedTitleIds: z.array(z.uuid()).max(MAX_CART_TITLES),
  unavailableTitleIds: z.array(z.uuid()).max(MAX_CART_TITLES),
  taxNotice: z.literal('calculated_at_checkout'),
  canCheckout: z.boolean()
}).superRefine((quote, context) => {
  const everyId = [
    ...quote.items.map((item) => item.titleId),
    ...quote.alreadyOwnedTitleIds,
    ...quote.claimableTitleIds,
    ...quote.reservedTitleIds,
    ...quote.unavailableTitleIds
  ];
  if (new Set(everyId).size !== everyId.length) {
    context.addIssue({ code: 'custom', message: 'duplicate title' });
  }
  let total = 0;
  for (const item of quote.items) {
    total += item.unitSubtotalMinor;
    if (!Number.isSafeInteger(total)) {
      context.addIssue({ code: 'custom', message: 'unsafe total' });
      return;
    }
    if (quote.currency === null || item.currency.toUpperCase() !== quote.currency.toUpperCase()) {
      context.addIssue({ code: 'custom', message: 'currency mismatch' });
    }
  }
  if (
    total !== quote.subtotalMinor ||
    quote.canCheckout !== (quote.items.length > 0) ||
    (quote.items.length === 0 && quote.currency !== null)
  ) {
    context.addIssue({ code: 'custom', message: 'inconsistent quote' });
  }
});

const pendingCheckoutSchema = z.strictObject({
  acceptedTitleIds: z.array(z.uuid()).min(1).max(MAX_CART_TITLES),
  checkoutAttemptId: z.uuid()
}).superRefine((value, context) => {
  if (new Set(value.acceptedTitleIds).size !== value.acceptedTitleIds.length) {
    context.addIssue({ code: 'custom', message: 'duplicate title' });
  }
});

const orderStatusSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('pending') }),
  z.strictObject({ status: z.literal('paid'), libraryUrl: z.literal('/library') }),
  z.strictObject({ status: z.literal('paid_guest'), claimMessage: z.string().min(1).max(500) }),
  z.strictObject({ status: z.literal('failed'), message: z.string().min(1).max(500) }),
  z.strictObject({ status: z.literal('expired'), message: z.string().min(1).max(500) }),
  z.strictObject({ status: z.literal('exception'), message: z.string().min(1).max(500) })
]);

async function responseJson(response: Response): Promise<unknown> {
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new CheckoutClientError('invalid_response');
  }
  try {
    return await response.json();
  } catch {
    throw new CheckoutClientError('invalid_response');
  }
}

async function sendJson(
  fetcher: CommerceFetch,
  path: string,
  body: unknown,
  signal?: AbortSignal
): Promise<Response> {
  try {
    return await fetcher(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
      ...(signal ? { signal } : {})
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new CheckoutClientError('temporarily_unavailable');
  }
}

function errorKindForStatus(
  response: Response,
  body: unknown,
  checkout: boolean
): CheckoutClientErrorKind {
  const code = z.object({ code: z.string() }).safeParse(body);
  if (response.status === 422) return 'invalid_cart';
  if (response.status === 429) return 'rate_limited';
  if (checkout && code.success && code.data.code === 'CHECKOUT_UNAVAILABLE') {
    return 'checkout_unavailable';
  }
  return checkout ? 'checkout_unavailable' : 'temporarily_unavailable';
}

export async function requestQuote(
  fetcher: CommerceFetch,
  titleIds: readonly string[],
  checkoutAttemptId: string,
  signal?: AbortSignal
): Promise<CommerceQuoteDto> {
  const response = await sendJson(fetcher, '/api/commerce/quote', {
    titleIds: [...titleIds],
    checkoutAttemptId
  }, signal);
  const body = await responseJson(response);
  if (!response.ok) throw new CheckoutClientError(errorKindForStatus(response, body, false));
  const parsed = quoteSchema.safeParse(body);
  if (!parsed.success) throw new CheckoutClientError('invalid_response');
  return parsed.data;
}

export function isAllowedCheckoutUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== ''
  ) return false;
  if (url.hostname === 'checkout.stripe.com') return true;
  return (
    url.hostname === 'checkout.stripe.test' &&
    url.search === '' &&
    url.hash === '' &&
    /^\/session\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      url.pathname
    )
  );
}

export async function createCheckout(
  fetcher: CommerceFetch,
  input: CheckoutRequest
): Promise<CheckoutResultDto> {
  const parsedInput = checkoutRequestSchema.safeParse(input);
  if (!parsedInput.success || new Set(input.titleIds).size !== input.titleIds.length) {
    throw new CheckoutClientError('invalid_cart');
  }
  const response = await sendJson(fetcher, '/api/commerce/checkout', parsedInput.data);
  const body = await responseJson(response);
  if (response.status === 409) {
    const changed = z.strictObject({ status: z.literal('cart_changed'), quote: quoteSchema }).safeParse(body);
    if (changed.success) return changed.data;
    const conflict = z.strictObject({
      code: z.literal('CHECKOUT_ATTEMPT_CONFLICT')
    }).safeParse(body);
    if (conflict.success) throw new CheckoutClientError('attempt_conflict');
    throw new CheckoutClientError('invalid_response');
  }
  if (!response.ok) throw new CheckoutClientError(errorKindForStatus(response, body, true));
  const redirect = z.strictObject({
    status: z.literal('redirect'),
    checkoutUrl: z.string()
  }).safeParse(body);
  if (!redirect.success || !isAllowedCheckoutUrl(redirect.data.checkoutUrl)) {
    throw new CheckoutClientError('invalid_response');
  }
  return redirect.data;
}

export function buildCheckoutRequest(
  requestedTitleIds: readonly string[],
  quote: CommerceQuoteDto,
  checkoutAttemptId: string
): CheckoutRequest {
  const parsedQuote = quoteSchema.safeParse(quote);
  const requested = new Set(requestedTitleIds);
  const partition = parsedQuote.success
    ? new Set([
        ...parsedQuote.data.items.map((item) => item.titleId),
        ...parsedQuote.data.alreadyOwnedTitleIds,
        ...parsedQuote.data.claimableTitleIds,
        ...parsedQuote.data.reservedTitleIds,
        ...parsedQuote.data.unavailableTitleIds
      ])
    : null;
  if (
    !parsedQuote.success ||
    requested.size !== requestedTitleIds.length ||
    partition?.size !== requested.size ||
    [...requested].some((titleId) => !partition.has(titleId))
  ) throw new CheckoutClientError('invalid_response');
  const input = checkoutRequestSchema.safeParse({
    titleIds: [...requestedTitleIds],
    quoteFingerprint: parsedQuote.data.fingerprint,
    checkoutAttemptId
  });
  if (!input.success) throw new CheckoutClientError('invalid_cart');
  return input.data;
}

export type QuoteRequestResult =
  | { status: 'current'; quote: CommerceQuoteDto }
  | { status: 'stale' };

type QuoteRequester = (
  fetcher: CommerceFetch,
  titleIds: readonly string[],
  checkoutAttemptId: string,
  signal: AbortSignal
) => Promise<CommerceQuoteDto>;

export class QuoteRequestCoordinator {
  private version = 0;
  private controller: AbortController | null = null;

  constructor(private readonly requester: QuoteRequester = requestQuote) {}

  async refresh(
    fetcher: CommerceFetch,
    titleIds: readonly string[],
    checkoutAttemptId: string
  ): Promise<QuoteRequestResult> {
    this.controller?.abort();
    const version = ++this.version;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const quote = await this.requester(fetcher, titleIds, checkoutAttemptId, controller.signal);
      return version === this.version && !controller.signal.aborted
        ? { status: 'current', quote }
        : { status: 'stale' };
    } catch (error) {
      if (version !== this.version || controller.signal.aborted) return { status: 'stale' };
      throw error;
    }
  }

  cancel(): void {
    this.version += 1;
    this.controller?.abort();
    this.controller = null;
  }
}

export function storePendingCheckout(
  storage: CheckoutStorage,
  pending: PendingCheckoutState
): void {
  const parsed = pendingCheckoutSchema.safeParse(pending);
  if (!parsed.success) throw new CheckoutClientError('invalid_response');
  const serialized = JSON.stringify(parsed.data);
  if (new TextEncoder().encode(serialized).byteLength > MAX_PENDING_CHECKOUT_BYTES) {
    throw new CheckoutClientError('invalid_response');
  }
  storage.setItem(CHECKOUT_PENDING_STORAGE_KEY, serialized);
}

export function loadPendingCheckout(storage: CheckoutStorage): PendingCheckoutState | null {
  let serialized: string | null;
  try {
    serialized = storage.getItem(CHECKOUT_PENDING_STORAGE_KEY);
  } catch {
    return null;
  }
  if (serialized === null) return null;
  try {
    if (new TextEncoder().encode(serialized).byteLength > MAX_PENDING_CHECKOUT_BYTES) {
      throw new Error('oversized');
    }
    const parsed = pendingCheckoutSchema.parse(JSON.parse(serialized));
    return parsed;
  } catch {
    try {
      storage.removeItem(CHECKOUT_PENDING_STORAGE_KEY);
    } catch {
      // Invalid session state is ignored even when storage cleanup is unavailable.
    }
    return null;
  }
}

export function clearPendingCheckout(storage: CheckoutStorage): void {
  try {
    storage.removeItem(CHECKOUT_PENDING_STORAGE_KEY);
  } catch {
    // Session storage is an optional cleanup hint, never authority.
  }
}

export async function requestOrderStatus(
  fetcher: CommerceFetch,
  orderId: string,
  signal?: AbortSignal
): Promise<OrderStatusDto> {
  if (!z.uuid().safeParse(orderId).success) {
    throw new CheckoutClientError('invalid_response');
  }
  let response: Response;
  try {
    response = await fetcher(`/api/commerce/orders/${orderId}/status`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      ...(signal ? { signal } : {})
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new CheckoutClientError('temporarily_unavailable');
  }
  const body = await responseJson(response);
  if (!response.ok) throw new CheckoutClientError('temporarily_unavailable');
  const parsed = orderStatusSchema.safeParse(body);
  if (!parsed.success) throw new CheckoutClientError('invalid_response');
  return parsed.data;
}

type PollWait = (milliseconds: number, signal: AbortSignal) => Promise<void>;

function waitForPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = globalThis.setTimeout(finish, milliseconds);
    signal.addEventListener('abort', abort, { once: true });

    function finish(): void {
      signal.removeEventListener('abort', abort);
      resolve();
    }

    function abort(): void {
      globalThis.clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }
  });
}

export interface PollOrderStatusOptions {
  signal: AbortSignal;
  onStatus?: (status: OrderStatusDto) => void;
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  wait?: PollWait;
}

export type PollOrderStatusResult =
  | { outcome: 'terminal'; status: Exclude<OrderStatusDto, { status: 'pending' | 'failed' }> }
  | { outcome: 'timeout' }
  | { outcome: 'aborted' };

function isTerminalOrderStatus(
  status: OrderStatusDto
): status is Exclude<OrderStatusDto, { status: 'pending' | 'failed' }> {
  return status.status !== 'pending' && status.status !== 'failed';
}

export async function pollOrderStatus(
  fetcher: CommerceFetch,
  orderId: string,
  options: PollOrderStatusOptions
): Promise<PollOrderStatusResult> {
  const intervalMs = options.intervalMs ?? 2_000;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? waitForPoll;
  if (
    !Number.isSafeInteger(intervalMs) || intervalMs < 1 ||
    !Number.isSafeInteger(timeoutMs) || timeoutMs < intervalMs
  ) throw new CheckoutClientError('invalid_response');
  const startedAt = now();

  while (true) {
    if (options.signal.aborted) return { outcome: 'aborted' };
    if (now() - startedAt >= timeoutMs) return { outcome: 'timeout' };
    let status: OrderStatusDto;
    try {
      status = await requestOrderStatus(fetcher, orderId, options.signal);
    } catch (error) {
      if (options.signal.aborted) return { outcome: 'aborted' };
      throw error;
    }
    options.onStatus?.(status);
    if (isTerminalOrderStatus(status)) return { outcome: 'terminal', status };
    const remaining = timeoutMs - (now() - startedAt);
    if (remaining <= 0) return { outcome: 'timeout' };
    try {
      await wait(Math.min(intervalMs, remaining), options.signal);
    } catch (error) {
      if (options.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        return { outcome: 'aborted' };
      }
      throw error;
    }
  }
}
