export function canonicalizeBodylessRedirect(response: Response): Response {
  if (
    response.status < 300 ||
    response.status >= 400 ||
    response.status === 304
  ) {
    return response;
  }
  if (response.body !== null) {
    try {
      void response.body.cancel().catch(() => undefined);
    } catch {
      // The response still fails closed when an already-owned stream cannot be canceled.
    }
    throw new Error(
      "Redirect response violated the bodyless framing invariant",
    );
  }

  const headers = new Headers(response.headers);
  headers.set("content-length", "0");
  headers.delete("transfer-encoding");
  headers.delete("content-encoding");
  headers.delete("trailer");
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
