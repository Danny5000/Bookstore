import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import type { SmtpConfig } from '$lib/server/config';
import type { EmailMessage, EmailTransport } from './types';

export interface NodemailerEmailTransport extends EmailTransport {
  close(): void;
}

export function createSmtpTransportOptions(config: SmtpConfig): SMTPTransport.Options {
  return {
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: config.requireTls,
    auth:
      config.user && config.password
        ? { user: config.user, pass: config.password }
        : undefined,
    connectionTimeout: config.connectionTimeoutMs,
    greetingTimeout: config.greetingTimeoutMs,
    socketTimeout: config.socketTimeoutMs
  };
}

function aborted(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Email send aborted');
}

async function sendAbortably(
  transporter: Transporter,
  message: EmailMessage,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) throw aborted(signal);

  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(aborted(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    await Promise.race([transporter.sendMail(message), abortPromise]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export function createNodemailerEmailTransport(config: SmtpConfig): NodemailerEmailTransport {
  const transporter = nodemailer.createTransport(createSmtpTransportOptions(config));

  return {
    send: (message, signal) => sendAbortably(transporter, message, signal),
    close: () => transporter.close()
  };
}
