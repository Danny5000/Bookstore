import type { SessionUser } from '$lib/types/auth';

declare global {
  namespace App {
    interface Locals {
      user: SessionUser | null;
    }
  }
}

export {};
