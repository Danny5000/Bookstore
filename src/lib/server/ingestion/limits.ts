import type { IngestionConfig } from '$lib/server/config';

export interface IngestionLimits {
  readonly maxUploadBytes: number;
  readonly maxExpandedBytes: number;
  readonly maxEntries: number;
  readonly maxXmlBytes: number;
  readonly maxImagePixels: number;
  readonly maxCompressionRatio: number;
  readonly timeoutMs: number;
}

export function ingestionLimitsFromConfig(config: IngestionConfig): IngestionLimits {
  return Object.freeze({
    maxUploadBytes: config.maxUploadBytes,
    maxExpandedBytes: config.maxExpandedBytes,
    maxEntries: config.maxEntries,
    maxXmlBytes: config.maxXmlBytes,
    maxImagePixels: config.maxImagePixels,
    maxCompressionRatio: config.maxCompressionRatio,
    timeoutMs: config.timeoutMs
  });
}
