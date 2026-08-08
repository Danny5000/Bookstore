import { browser } from '$app/environment';
import type { SessionUser } from '$lib/types/auth';
import { isRecord, parseStoredJson } from '$lib/utils/persistence';

const KEY = 'paleorbit.session';

class SessionStore {
  user = $state<SessionUser | null>(null);

  constructor() {
    if (!browser) return;
    const value = parseStoredJson(localStorage.getItem(KEY));
    if (isRecord(value) && typeof value.email === 'string') {
      this.user = { email: value.email };
    }
  }

  signIn(email: string): void {
    this.user = { email };
    if (browser) localStorage.setItem(KEY, JSON.stringify(this.user));
  }

  signOut(): void {
    this.user = null;
    if (browser) localStorage.removeItem(KEY);
  }
}

export const session = new SessionStore();
