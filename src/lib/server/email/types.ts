export interface EmailMessage {
  messageId: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailTransport {
  send(message: EmailMessage, signal: AbortSignal): Promise<void>;
}
