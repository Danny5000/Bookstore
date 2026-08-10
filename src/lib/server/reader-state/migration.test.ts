import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  panelGeometryListsMatch,
  uniqueFingerprintTarget
} from './migration';

const digest = 'a'.repeat(64);

describe('exact migration matching', () => {
  it('returns a target only for one equal non-null fingerprint/version pair', () => {
    const exactId = randomUUID();
    expect(uniqueFingerprintTarget(
      { semanticFingerprintSha256: digest, semanticFingerprintVersion: 1 },
      [{ id: exactId, semanticFingerprintSha256: digest, semanticFingerprintVersion: 1 }]
    )?.id).toBe(exactId);
    expect(uniqueFingerprintTarget(
      { semanticFingerprintSha256: digest, semanticFingerprintVersion: 1 },
      [{ id: randomUUID(), semanticFingerprintSha256: 'b'.repeat(64), semanticFingerprintVersion: 1 }]
    )).toBeNull();
    expect(uniqueFingerprintTarget(
      { semanticFingerprintSha256: digest, semanticFingerprintVersion: 1 },
      [
        { id: randomUUID(), semanticFingerprintSha256: digest, semanticFingerprintVersion: 1 },
        { id: randomUUID(), semanticFingerprintSha256: digest, semanticFingerprintVersion: 1 }
      ]
    )).toBeNull();
    expect(uniqueFingerprintTarget(
      { semanticFingerprintSha256: null, semanticFingerprintVersion: null },
      [{ id: exactId, semanticFingerprintSha256: digest, semanticFingerprintVersion: 1 }]
    )).toBeNull();
  });

  it('requires the complete ordered normalized panel geometry to match', () => {
    const source = [
      { ordinal: 0, x: 0, y: 0, width: 1, height: 0.5 },
      { ordinal: 1, x: 0, y: 0.5, width: 1, height: 0.5 }
    ];
    expect(panelGeometryListsMatch(source, source.map((panel) => ({ ...panel })))).toBe(true);
    expect(panelGeometryListsMatch(source, [
      source[0]!,
      { ...source[1]!, height: 0.49 }
    ])).toBe(false);
    expect(panelGeometryListsMatch(source, [source[1]!, source[0]!])).toBe(false);
    expect(panelGeometryListsMatch(source, [source[0]!])).toBe(false);
  });
});
