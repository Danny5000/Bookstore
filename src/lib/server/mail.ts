import { env } from '$env/dynamic/private';

interface BuiltEpub {
  filename: string;
  buffer: Buffer;
}

interface SendBookEmailInput {
  email: string;
  titleId: string;
}

export async function buildEpub(_titleId: string): Promise<BuiltEpub> {
  throw new Error('buildEpub not implemented — see the approved full-stack design');
}

export async function sendBookEmail({
  email,
  titleId
}: SendBookEmailInput): Promise<void> {
  if (!env.MAIL_API_KEY) {
    console.log('[mail] MAIL_API_KEY unset — would send', titleId, 'to', email);
    return;
  }

  console.log('[mail] provider adapter not wired — would send', titleId, 'to', email);
}
