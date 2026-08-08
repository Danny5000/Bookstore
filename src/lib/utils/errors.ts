export function messageFromUnknown(value: unknown): string {
  return value instanceof Error ? value.message : 'Unexpected error';
}
