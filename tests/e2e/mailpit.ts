export async function waitForLatestTextEmail(
  recipient: string,
  timeoutMs = 10_000,
  expectedText?: string
): Promise<string> {
  const base = process.env.MAILPIT_HTTP_URL;
  if (!base) throw new Error('MAILPIT_HTTP_URL is required');
  const deadline = Date.now() + timeoutMs;
  const query = new URLSearchParams({ query: `to:${recipient}` });

  while (Date.now() < deadline) {
    const response = await fetch(`${base}/view/latest.txt?${query}`);
    if (response.ok) {
      const message = await response.text();
      if (!expectedText || message.includes(expectedText)) return message;
    } else if (response.status !== 404) {
      throw new Error(`Mailpit returned ${response.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for test email to ${recipient}`);
}

export function firstHttpLink(message: string): string {
  const link = message.match(/https?:\/\/[^\s<>]+/)?.[0];
  if (!link) throw new Error('Test email did not contain a link');
  return link;
}
