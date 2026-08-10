import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ProseBlockData } from '$lib/types/publication';
import {
  SEMANTIC_FINGERPRINT_VERSION,
  fingerprintDecodedImage,
  fingerprintProseBlock
} from './fingerprint';

const pixelDigest = createHash('sha256').update('pixels').digest('hex');
const otherPixelDigest = createHash('sha256').update('other-pixels').digest('hex');

describe('semantic publication fingerprints', () => {
  it('domain-separates decoded pixel digest and dimensions', () => {
    const original = fingerprintDecodedImage({ width: 40, height: 60, pixelDigestSha256: pixelDigest });

    expect(original).toMatch(/^[0-9a-f]{64}$/u);
    expect(SEMANTIC_FINGERPRINT_VERSION).toBe(1);
    expect(
      fingerprintDecodedImage({ width: 40, height: 60, pixelDigestSha256: pixelDigest })
    ).toBe(original);
    expect(
      fingerprintDecodedImage({ width: 60, height: 40, pixelDigestSha256: pixelDigest })
    ).not.toBe(original);
    expect(
      fingerprintDecodedImage({ width: 40, height: 60, pixelDigestSha256: otherPixelDigest })
    ).not.toBe(original);
  });

  it('canonicalizes prose objects without changing array order', () => {
    const left = {
      kind: 'paragraph',
      fragments: [{ text: 'Signal', marks: ['emphasis'] }]
    } as ProseBlockData;
    const right = {
      fragments: [{ marks: ['emphasis'], text: 'Signal' }],
      kind: 'paragraph'
    } as ProseBlockData;

    expect(fingerprintProseBlock({ block: left })).toBe(fingerprintProseBlock({ block: right }));
    expect(
      fingerprintProseBlock({
        block: {
          kind: 'paragraph',
          fragments: [{ text: 'Signal', marks: [] }]
        }
      })
    ).not.toBe(fingerprintProseBlock({ block: left }));
  });

  it('changes when visible prose, kind, or semantic formatting changes', () => {
    const baseline = fingerprintProseBlock({
      block: { kind: 'paragraph', fragments: [{ text: 'The signal', marks: [] }] }
    });

    expect(
      fingerprintProseBlock({
        block: { kind: 'paragraph', fragments: [{ text: 'The signal changed', marks: [] }] }
      })
    ).not.toBe(baseline);
    expect(
      fingerprintProseBlock({
        block: { kind: 'quote', fragments: [{ text: 'The signal', marks: [] }] }
      })
    ).not.toBe(baseline);
    expect(
      fingerprintProseBlock({
        block: { kind: 'paragraph', fragments: [{ text: 'The signal', marks: ['strong'] }] }
      })
    ).not.toBe(baseline);
  });

  it('uses decoded image content instead of revision-specific image IDs', () => {
    const first = fingerprintProseBlock({
      block: { kind: 'image', imageId: randomUUID(), alt: 'Station' },
      imageFingerprintSha256: pixelDigest
    });
    const second = fingerprintProseBlock({
      block: { kind: 'image', imageId: randomUUID(), alt: 'Station' },
      imageFingerprintSha256: pixelDigest
    });

    expect(first).toBe(second);
    expect(
      fingerprintProseBlock({
        block: { kind: 'image', imageId: randomUUID(), alt: 'Station' },
        imageFingerprintSha256: otherPixelDigest
      })
    ).not.toBe(first);
  });

  it('rejects invalid image fingerprint combinations', () => {
    expect(() =>
      fingerprintProseBlock({ block: { kind: 'image', imageId: randomUUID(), alt: '' } })
    ).toThrow(/image fingerprint/iu);
    expect(() =>
      fingerprintProseBlock({
        block: { kind: 'break' },
        imageFingerprintSha256: pixelDigest
      })
    ).toThrow(/non-image/iu);
  });
});
