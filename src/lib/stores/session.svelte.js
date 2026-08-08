import { browser } from '$app/environment';

const KEY = 'paleorbit.session';

/**
 * Placeholder session so the UI can be exercised without a backend.
 * Swap for real auth (README -> Auth): Lucia, Auth.js, Supabase, Clerk...
 * The UI only needs `user.email` plus signIn / signOut.
 */
class SessionStore {
  user = $state(null);

  constructor() {
    if (!browser) return;
    const raw = localStorage.getItem(KEY);
    if (raw) this.user = JSON.parse(raw);
  }

  signIn(email) {
    this.user = { email };
    if (browser) localStorage.setItem(KEY, JSON.stringify(this.user));
  }

  signOut() {
    this.user = null;
    if (browser) localStorage.removeItem(KEY);
  }
}

export const session = new SessionStore();
