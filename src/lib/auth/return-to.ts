export type AllowedAuthReturnTo = '/claim/complete';

export function allowedAuthReturnTo(value: string | null): AllowedAuthReturnTo | null {
  return value === '/claim/complete' ? value : null;
}
