import type { ApplicationMode } from './config';

const MAINTENANCE_PATHS = new Set(['/health/live', '/health/ready']);

export function isRequestAvailable(mode: ApplicationMode, path: string): boolean {
  return mode === 'prototype' || MAINTENANCE_PATHS.has(path);
}
