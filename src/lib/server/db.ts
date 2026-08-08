interface GrantPurchaseInput {
  email: string;
  titleId: string;
  amount: number | null;
  stripeSessionId: string;
}

interface SaveProgressInput {
  email: string;
  titleId: string;
  sheet: number;
}

const purchases = new Map<string, Set<string>>();

export async function grantPurchase({
  email,
  titleId,
  amount,
  stripeSessionId
}: GrantPurchaseInput): Promise<void> {
  if (!email || !titleId) return;
  const owned = purchases.get(email) ?? new Set<string>();
  owned.add(titleId);
  purchases.set(email, owned);
  console.log('[db] granted', { email, titleId, amount, stripeSessionId });
}

export async function entitlementsFor(email: string): Promise<string[]> {
  return [...(purchases.get(email) ?? [])];
}

export async function saveProgress({ email, titleId, sheet }: SaveProgressInput): Promise<void> {
  console.log('[db] progress', { email, titleId, sheet });
}

export async function progressFor(_email: string): Promise<Record<string, number>> {
  return {};
}
