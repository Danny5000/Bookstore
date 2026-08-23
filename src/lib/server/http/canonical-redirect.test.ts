import { describe, expect, it } from "vitest";
import { canonicalizeBodylessRedirect } from "./canonical-redirect";

describe("canonicalizeBodylessRedirect", () => {
  it.each([302, 303])(
    "gives an already-bodyless %i redirect unambiguous zero-length framing",
    (status) => {
      const headers = new Headers({
        "cache-control": "no-store",
        "content-encoding": "gzip",
        "content-length": "9",
        location: "/library",
        trailer: "digest",
        "transfer-encoding": "chunked",
      });
      headers.append("set-cookie", "first=one; Path=/; HttpOnly");
      headers.append("set-cookie", "second=two; Path=/; HttpOnly");
      const response = new Response(null, {
        status,
        statusText: "See Other",
        headers,
      });

      const framed = canonicalizeBodylessRedirect(response);

      expect(framed).not.toBe(response);
      expect(framed.status).toBe(status);
      expect(framed.statusText).toBe("See Other");
      expect(framed.body).toBeNull();
      expect(framed.headers.get("content-length")).toBe("0");
      expect(framed.headers.get("transfer-encoding")).toBeNull();
      expect(framed.headers.get("content-encoding")).toBeNull();
      expect(framed.headers.get("trailer")).toBeNull();
      expect(framed.headers.get("location")).toBe("/library");
      expect(framed.headers.get("cache-control")).toBe("no-store");
      expect(framed.headers.getSetCookie()).toEqual([
        "first=one; Path=/; HttpOnly",
        "second=two; Path=/; HttpOnly",
      ]);
    },
  );

  it("rejects a redirect with any body stream instead of inferring bodylessness", () => {
    let cancellationCount = 0;
    const body = new ReadableStream({
      cancel: () => {
        cancellationCount += 1;
      },
      pull: () => undefined,
    });
    const nonemptyRedirect = new Response(body, {
      status: 302,
      headers: { "content-length": "0", location: "/library" },
    });

    expect(() => canonicalizeBodylessRedirect(nonemptyRedirect)).toThrow(
      "Redirect response violated the bodyless framing invariant",
    );
    expect(cancellationCount).toBe(1);
  });

  it("does not rewrite non-redirect or semantic no-body responses", () => {
    const notModified = new Response(null, { status: 304 });
    const emptySuccess = new Response(null, { status: 204 });
    const ordinarySuccess = new Response("ok", { status: 200 });

    expect(canonicalizeBodylessRedirect(notModified)).toBe(notModified);
    expect(canonicalizeBodylessRedirect(emptySuccess)).toBe(emptySuccess);
    expect(canonicalizeBodylessRedirect(ordinarySuccess)).toBe(ordinarySuccess);
  });
});
