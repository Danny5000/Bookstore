import { createHash } from 'node:crypto';
import type { ProseBlockData } from '$lib/types/publication';

export const SEMANTIC_FINGERPRINT_VERSION = 1 as const;

const sha256Pattern = /^[0-9a-f]{64}$/u;

function requireSha256(value: string, label: string): string {
  if (!sha256Pattern.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function requireDimension(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

export function fingerprintDecodedImage(input: {
  width: number;
  height: number;
  pixelDigestSha256: string;
}): string {
  const dimensions = Buffer.alloc(16);
  dimensions.writeBigUInt64BE(BigInt(requireDimension(input.width, 'width')), 0);
  dimensions.writeBigUInt64BE(BigInt(requireDimension(input.height, 'height')), 8);
  return createHash('sha256')
    .update('pale-orbit:image:v1\0', 'utf8')
    .update(dimensions)
    .update(Buffer.from(requireSha256(input.pixelDigestSha256, 'pixel digest'), 'hex'))
    .digest('hex');
}

type CanonicalValue = null | boolean | number | string | readonly CanonicalValue[] | {
  readonly [key: string]: CanonicalValue;
};

function canonicalize(value: unknown): CanonicalValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical content contains a non-finite number');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const result: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) result[key] = canonicalize(child);
    }
    return result;
  }
  throw new TypeError('Canonical content contains an unsupported value');
}

export function fingerprintProseBlock(input: {
  block: ProseBlockData;
  imageFingerprintSha256?: string;
}): string {
  let canonicalBlock: unknown = input.block;
  if (input.block.kind === 'image') {
    if (!input.imageFingerprintSha256) {
      throw new TypeError('Image block requires an image fingerprint');
    }
    canonicalBlock = {
      kind: input.block.kind,
      alt: input.block.alt,
      imageFingerprintSha256: requireSha256(
        input.imageFingerprintSha256,
        'image fingerprint'
      )
    };
  } else if (input.imageFingerprintSha256 !== undefined) {
    throw new TypeError('A non-image block cannot include an image fingerprint');
  }

  return createHash('sha256')
    .update('pale-orbit:prose-block:v1\0', 'utf8')
    .update(JSON.stringify(canonicalize(canonicalBlock)), 'utf8')
    .digest('hex');
}
