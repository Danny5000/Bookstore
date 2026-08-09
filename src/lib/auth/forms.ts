export function normalizeBrowserEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function validatePasswordConfirmation(
  password: string,
  confirmation: string
): string | null {
  if (password.length < 12) return 'Password must be at least 12 characters.';
  if (password !== confirmation) return 'Passwords must match.';
  return null;
}

export function validateRegistration(
  name: string,
  password: string,
  confirmation: string
): string | null {
  if (!name.trim()) return 'Display name is required.';
  return validatePasswordConfirmation(password, confirmation);
}
