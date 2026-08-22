import { describe, expect, it } from 'vitest';
import {
  FINANCIAL_ALLOCATION_ALGORITHM_VERSION,
  FINANCIAL_CLASSIFIER_VERSION,
  FINANCIAL_INITIAL_PAYOUT_LOOKBACK_MS,
  FINANCIAL_PAGE_SIZE,
  FINANCIAL_PAYOUT_OVERLAP_MS,
  FINANCIAL_REPLAY_ID,
  FINANCIAL_SCAN_BUCKET_MS,
  FINANCIAL_SCAN_RESOURCE_LIMIT
} from './constants';

describe('financial constants', () => {
  it('pins bounded deterministic scan and classifier settings', () => {
    expect(FINANCIAL_CLASSIFIER_VERSION).toBe(1);
    expect(FINANCIAL_PAGE_SIZE).toBe(100);
    expect(FINANCIAL_SCAN_RESOURCE_LIMIT).toBe(100);
    expect(FINANCIAL_SCAN_BUCKET_MS).toBe(60 * 60 * 1000);
    expect(FINANCIAL_PAYOUT_OVERLAP_MS).toBe(72 * 60 * 60 * 1000);
    expect(FINANCIAL_INITIAL_PAYOUT_LOOKBACK_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('keys replay from both classifier and allocation algorithm versions', () => {
    expect(FINANCIAL_ALLOCATION_ALGORITHM_VERSION).toBe(2);
    expect(FINANCIAL_REPLAY_ID).toBe('c1-a2');
  });
});
