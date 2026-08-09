import type { Actor } from '$lib/server/auth/admin-policy';
import type { SessionRecord, SessionUser } from '$lib/types/auth';

declare global {
  namespace App {
    interface Locals {
      user: SessionUser | null;
      session: SessionRecord | null;
      actor: Actor;
    }
  }
}

export {};
