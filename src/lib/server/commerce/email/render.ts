import type { RenderedEmail } from '$lib/server/email/templates';
import type { CommerceEmailPayload } from './payload';

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    };
    return entities[character] ?? character;
  });
}

function formatMoney(amountMinor: number, currency: string): string {
  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency
  });
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(amountMinor / 10 ** fractionDigits);
}

function renderReceipt(
  payload: Extract<CommerceEmailPayload, {
    template: 'commerce.account-receipt' | 'commerce.guest-receipt-claim';
  }>
): RenderedEmail {
  const itemsText = payload.items.map((item) =>
    `- ${item.title} — ${item.creatorName} (${item.format === 'prose' ? 'EPUB' : 'comic'})`
  );
  const itemsHtml = payload.items.map((item) =>
    `<li>${escapeHtml(item.title)} — ${escapeHtml(item.creatorName)} (${item.format === 'prose' ? 'EPUB' : 'comic'})</li>`
  ).join('');
  const claimText = payload.template === 'commerce.guest-receipt-claim'
    ? ['', 'Claim your purchase:', payload.claimUrl]
    : [];
  const claimHtml = payload.template === 'commerce.guest-receipt-claim'
    ? `<p><a href="${escapeHtml(payload.claimUrl)}">Claim your purchase</a></p>`
    : '';
  const totalsText = [
    `Subtotal: ${formatMoney(payload.subtotalMinor, payload.currency)}`,
    `Tax: ${formatMoney(payload.taxMinor, payload.currency)}`,
    `Total: ${formatMoney(payload.totalMinor, payload.currency)}`
  ];

  return {
    subject: 'Your Pale Orbit purchase',
    text: [
      'Thank you for your purchase.',
      `Order: ${payload.orderNumber}`,
      `Date: ${payload.orderDate}`,
      '',
      ...itemsText,
      '',
      ...totalsText,
      ...claimText,
      '',
      'Once associated with your verified account, purchased files are available for direct download from your library.',
      'For safety, book and comic files are never attached to email.'
    ].join('\n'),
    html: [
      '<!doctype html><html><body>',
      '<p>Thank you for your purchase.</p>',
      `<p>Order: ${escapeHtml(payload.orderNumber)}<br>Date: ${escapeHtml(payload.orderDate)}</p>`,
      `<ul>${itemsHtml}</ul>`,
      `<p>Subtotal: ${escapeHtml(totalsText[0]!.slice('Subtotal: '.length))}<br>`,
      `Tax: ${escapeHtml(totalsText[1]!.slice('Tax: '.length))}<br>`,
      `Total: ${escapeHtml(totalsText[2]!.slice('Total: '.length))}</p>`,
      claimHtml,
      '<p>Once associated with your verified account, purchased files are available for direct download from your library.</p>',
      '<p>For safety, book and comic files are never attached to email.</p>',
      '</body></html>'
    ].join('')
  };
}

function renderAccessChange(
  payload: Extract<CommerceEmailPayload, {
    template: 'commerce.refund-access-changed' | 'commerce.dispute-access-changed';
  }>
): RenderedEmail {
  const count = `${payload.affectedTitleCount} ${payload.affectedTitleCount === 1 ? 'title' : 'titles'}`;
  const reason = payload.reasonCategory === 'refund_completed'
    ? 'A completed refund changed your library access.'
    : payload.reasonCategory === 'dispute_opened'
      ? 'A payment dispute temporarily changed your library access.'
      : 'The resolution of a payment dispute changed your library access.';
  return {
    subject: 'Your Pale Orbit library access changed',
    text: [
      reason,
      `Affected: ${count}.`,
      `Review your library: ${payload.libraryUrl}`,
      `Need help? ${payload.helpUrl}`
    ].join('\n'),
    html: [
      '<!doctype html><html><body>',
      `<p>${escapeHtml(reason)}</p>`,
      `<p>Affected: ${escapeHtml(count)}.</p>`,
      `<p><a href="${escapeHtml(payload.libraryUrl)}">Review your library</a></p>`,
      `<p><a href="${escapeHtml(payload.helpUrl)}">Get help</a></p>`,
      '</body></html>'
    ].join('')
  };
}

function renderAdministrativeRecoveryAccessChange(
  payload: Extract<CommerceEmailPayload, {
    template: 'commerce.administrative-recovery-access-changed';
  }>
): RenderedEmail {
  const outcome = `Your access to ${payload.soldAsTitle} is now ${payload.accessState}.`;
  return {
    subject: 'Your Pale Orbit library access changed',
    text: outcome,
    html: `<!doctype html><html><body><p>${escapeHtml(outcome)}</p></body></html>`
  };
}

export function renderCommerceEmail(payload: CommerceEmailPayload): RenderedEmail {
  if (
    payload.template === 'commerce.account-receipt' ||
    payload.template === 'commerce.guest-receipt-claim'
  ) return renderReceipt(payload);
  if (payload.template === 'commerce.administrative-recovery-access-changed') {
    return renderAdministrativeRecoveryAccessChange(payload);
  }
  return renderAccessChange(payload);
}
