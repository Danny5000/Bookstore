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

export async function sendBookEmail(_input: SendBookEmailInput): Promise<void> {
  console.warn('[mail] book delivery is not implemented');
}
