import {
  AuthorizationError,
  requireCapability,
} from "$lib/server/auth/admin-policy";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = ({ locals, route }) => {
  const administratorPath =
    route.id === "/admin" || route.id?.startsWith("/admin/") === true;
  if (administratorPath) {
    try {
      requireCapability(locals.actor, "admin.access");
    } catch (cause: unknown) {
      if (cause instanceof AuthorizationError) return { user: null };
      throw cause;
    }
  }
  return { user: locals.user };
};
