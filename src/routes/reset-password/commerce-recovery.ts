export type CommerceRecoveryOutcome =
  | 'recovery_required'
  | 'claim_ready'
  | 'sign_in_unavailable';

interface AuthOperationResult {
  data?: Record<string, unknown> | null;
  error?: unknown;
}

export interface CommerceRecoveryOperations {
  resetPassword(input: {
    token: string;
    newPassword: string;
  }): Promise<AuthOperationResult>;
  signInEmail(input: { email: string; password: string }): Promise<AuthOperationResult>;
}

export async function completeCommerceRecovery(
  input: { token: string; newPassword: string; email: string },
  operations: CommerceRecoveryOperations
): Promise<CommerceRecoveryOutcome> {
  let reset: AuthOperationResult;
  try {
    reset = await operations.resetPassword({
      token: input.token,
      newPassword: input.newPassword
    });
  } catch {
    return 'recovery_required';
  }
  if (reset.error || reset.data?.commerceClaimReady !== true) return 'recovery_required';

  try {
    const signIn = await operations.signInEmail({
      email: input.email,
      password: input.newPassword
    });
    if (!signIn.error) return 'claim_ready';
  } catch {
    return 'sign_in_unavailable';
  }
  return 'sign_in_unavailable';
}
