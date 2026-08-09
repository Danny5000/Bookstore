export type ApplicationRole = 'customer' | 'admin';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  roles: readonly ApplicationRole[];
}

export interface SessionRecord {
  id: string;
  userId: string;
  expiresAt: Date;
}
