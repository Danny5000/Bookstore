import {
  PermanentCommerceError,
  RetryableProviderError
} from '$lib/server/commerce/errors';
import { permanentStripeFailure, retryableStripeFailure } from './errors';

const MAX_FINANCIAL_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_JSON_NESTING_DEPTH = 64;

interface ExactJsonReplacement {
  start: number;
  end: number;
}

class ExactJsonScanner {
  private index = 0;
  private readonly replacements: ExactJsonReplacement[] = [];

  constructor(private readonly input: string) {}

  transform(): string {
    this.skipWhitespace();
    this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.input.length) throw permanentStripeFailure();
    let transformed = this.input;
    for (const replacement of this.replacements.toReversed()) {
      const token = this.input.slice(replacement.start, replacement.end);
      transformed = `${transformed.slice(0, replacement.start)}${JSON.stringify(token)}${transformed.slice(replacement.end)}`;
    }
    return transformed;
  }

  private skipWhitespace(): void {
    while (/\s/u.test(this.input[this.index] ?? '')) this.index += 1;
  }

  private parseValue(depth: number): void {
    if (depth > MAX_JSON_NESTING_DEPTH) throw permanentStripeFailure();
    this.skipWhitespace();
    const value = this.input[this.index];
    if (value === '{') return this.parseObject(depth + 1);
    if (value === '[') return this.parseArray(depth + 1);
    if (value === '"') {
      this.parseString();
      return;
    }
    if (value === '-' || this.isDigit(value)) {
      this.parseNumber();
      return;
    }
    if (this.consumeLiteral('true') || this.consumeLiteral('false') || this.consumeLiteral('null')) return;
    throw permanentStripeFailure();
  }

  private parseObject(depth: number): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.input[this.index] === '}') {
      this.index += 1;
      return;
    }
    const keys = new Set<string>();
    while (true) {
      this.skipWhitespace();
      const key = this.parseString();
      if (keys.has(key)) throw permanentStripeFailure();
      keys.add(key);
      this.skipWhitespace();
      if (this.input[this.index] !== ':') throw permanentStripeFailure();
      this.index += 1;
      this.skipWhitespace();
      if (key === 'exchange_rate') {
        if (!this.consumeLiteral('null')) {
          const start = this.index;
          if (this.input[this.index] !== '-' && !this.isDigit(this.input[this.index])) {
            throw permanentStripeFailure();
          }
          this.parseNumber();
          this.replacements.push({ start, end: this.index });
        }
      } else {
        this.parseValue(depth);
      }
      this.skipWhitespace();
      const separator = this.input[this.index];
      if (separator === '}') {
        this.index += 1;
        return;
      }
      if (separator !== ',') throw permanentStripeFailure();
      this.index += 1;
    }
  }

  private parseArray(depth: number): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.input[this.index] === ']') {
      this.index += 1;
      return;
    }
    while (true) {
      this.parseValue(depth);
      this.skipWhitespace();
      const separator = this.input[this.index];
      if (separator === ']') {
        this.index += 1;
        return;
      }
      if (separator !== ',') throw permanentStripeFailure();
      this.index += 1;
    }
  }

  private parseString(): string {
    const start = this.index;
    if (this.input[this.index] !== '"') throw permanentStripeFailure();
    this.index += 1;
    while (this.index < this.input.length) {
      const value = this.input[this.index];
      if (value === '"') {
        this.index += 1;
        try {
          const parsed: unknown = JSON.parse(this.input.slice(start, this.index));
          if (typeof parsed !== 'string') throw permanentStripeFailure();
          return parsed;
        } catch {
          throw permanentStripeFailure();
        }
      }
      if (value === '\\') {
        this.index += 2;
      } else {
        const code = value?.charCodeAt(0);
        if (code === undefined || code < 0x20) throw permanentStripeFailure();
        this.index += 1;
      }
    }
    throw permanentStripeFailure();
  }

  private parseNumber(): void {
    if (this.input[this.index] === '-') this.index += 1;
    const integerStart = this.index;
    if (this.input[this.index] === '0') {
      this.index += 1;
      if (this.isDigit(this.input[this.index])) throw permanentStripeFailure();
    } else {
      const first = this.input[this.index];
      if (first === undefined || first < '1' || first > '9') throw permanentStripeFailure();
      while (this.isDigit(this.input[this.index])) this.index += 1;
    }
    if (this.index === integerStart) throw permanentStripeFailure();
    if (this.input[this.index] === '.') {
      this.index += 1;
      const fractionStart = this.index;
      while (this.isDigit(this.input[this.index])) this.index += 1;
      if (this.index === fractionStart) throw permanentStripeFailure();
    }
    const exponent = this.input[this.index];
    if (exponent === 'e' || exponent === 'E') {
      this.index += 1;
      if (this.input[this.index] === '+' || this.input[this.index] === '-') this.index += 1;
      const exponentStart = this.index;
      while (this.isDigit(this.input[this.index])) this.index += 1;
      if (this.index === exponentStart) throw permanentStripeFailure();
    }
  }

  private isDigit(value: string | undefined): boolean {
    return value !== undefined && value >= '0' && value <= '9';
  }

  private consumeLiteral(literal: string): boolean {
    if (!this.input.startsWith(literal, this.index)) return false;
    this.index += literal.length;
    return true;
  }
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> & { destroy?: () => void } {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}

async function readBoundedResponse(stream: unknown): Promise<string> {
  if (!isAsyncIterable(stream)) throw permanentStripeFailure();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    for await (const chunk of stream) {
      if (!(chunk instanceof Uint8Array)) throw permanentStripeFailure();
      byteLength += chunk.byteLength;
      if (byteLength > MAX_FINANCIAL_RESPONSE_BYTES) {
        stream.destroy?.();
        throw permanentStripeFailure();
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof PermanentCommerceError) throw permanentStripeFailure();
    if (error instanceof RetryableProviderError) throw retryableStripeFailure();
    throw retryableStripeFailure();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw permanentStripeFailure();
  }
}

export async function parseExactFinancialResponse(stream: unknown): Promise<unknown> {
  const response = await readBoundedResponse(stream);
  try {
    return JSON.parse(new ExactJsonScanner(response).transform()) as unknown;
  } catch {
    throw permanentStripeFailure();
  }
}
