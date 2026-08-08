import { env } from '$env/dynamic/private';

/**
 * Delivery. Two jobs:
 *   1. build the file (EPUB / PDF) for a title
 *   2. hand it to a mail provider, or return a signed download URL
 *
 * Generating EPUB: the format is a zip of XHTML + OPF + NCX. `epub-gen-memory`
 * works in a server runtime; for PDF, render the same chapter HTML with
 * Playwright or Puppeteer and print to PDF.
 */

export async function buildEpub(titleId) {
  // return { filename, buffer }
  throw new Error('buildEpub not implemented — see README -> Delivery');
}

export async function sendBookEmail({ email, titleId }) {
  if (!env.MAIL_API_KEY) {
    console.log('[mail] MAIL_API_KEY unset — would send', titleId, 'to', email);
    return;
  }

  // Example: Resend
  // await fetch('https://api.resend.com/emails', {
  //   method: 'POST',
  //   headers: {
  //     authorization: `Bearer ${env.MAIL_API_KEY}`,
  //     'content-type': 'application/json'
  //   },
  //   body: JSON.stringify({
  //     from: env.MAIL_FROM,
  //     to: email,
  //     subject: 'Your book from Pale Orbit Press',
  //     html: '<p>Your files are attached, and they are always in your shelf.</p>',
  //     attachments: [{ filename, content: buffer.toString('base64') }]
  //   })
  // });
}
