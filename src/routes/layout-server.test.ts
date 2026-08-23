import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Actor } from "$lib/server/auth/admin-policy";
import type { SessionUser } from "$lib/types/auth";
import { load } from "./+layout.server";

const customer: Actor = {
  type: "user",
  id: randomUUID(),
  roles: ["customer"],
};
const administrator: Actor = {
  type: "user",
  id: randomUUID(),
  roles: ["customer", "admin"],
};

function userFor(actor: Extract<Actor, { type: "user" }>): SessionUser {
  return {
    id: actor.id,
    name: "Root layout reader",
    email: `${actor.id}@example.test`,
    emailVerified: true,
    roles: actor.roles,
  };
}

function rootLoad(
  path: string,
  actor: Actor,
  user: SessionUser | null,
  routeId = new URL(path, "https://books.example.test").pathname,
) {
  return load({
    locals: { actor, user, session: null },
    url: new URL(path, "https://books.example.test"),
    route: { id: routeId },
  } as never);
}

describe("root layout administrator privacy", () => {
  it.each(["/admin", "/admin/sales"])(
    "redacts a customer from %s before nested authorization",
    (path) => {
      expect(rootLoad(path, customer, userFor(customer))).toEqual({
        user: null,
      });
    },
  );

  it("keeps an anonymous administrator-tree response anonymous", () => {
    expect(rootLoad("/admin/sales", { type: "anonymous" }, null)).toEqual({
      user: null,
    });
  });

  it("uses the matched route identity to redact an encoded administrator URL", () => {
    expect(
      rootLoad(
        "/ad%6Din/sales",
        customer,
        userFor(customer),
        "/admin/sales",
      ),
    ).toEqual({ user: null });
  });

  it("retains the authorized administrator header identity", () => {
    const user = userFor(administrator);
    expect(rootLoad("/admin/sales", administrator, user)).toEqual({ user });
  });

  it.each(["/", "/library", "/administrator"])(
    "retains a signed-in customer on the non-admin route %s",
    (path) => {
      const user = userFor(customer);
      expect(rootLoad(path, customer, user)).toEqual({ user });
    },
  );
});
