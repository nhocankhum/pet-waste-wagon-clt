// Sends the customer their confirmation email after a quote request.
//
// WHY THE FILENAME MATTERS: Netlify fires a function named exactly
// `submission-created` on every accepted form submission. Renaming this file
// silently stops confirmations from going out — there is no other wiring.
//
// The HTML body is fetched from the deployed email-confirmation.html rather
// than duplicated here, so the template stays a single source of truth that
// anyone can edit without touching this code. If that fetch fails we still
// send a plain-text version, so a customer never gets silence.
//
// Requires two Netlify environment variables (see README notes):
//   RESEND_API_KEY      – key from the transactional email provider
//   CONFIRMATION_FROM   – e.g. "Pet Waste Wagon <hello@petwastewagon.com>"
// Optional:
//   CONFIRMATION_REPLY_TO – where customer replies should land

const TEMPLATE_URL = 'https://petwastewagon.com/email-confirmation.html';

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function firstName(full) {
  const first = String(full || '').trim().split(/\s+/)[0];
  return first || 'there';
}

function plainText(d) {
  return [
    `Hi ${firstName(d.name)},`,
    '',
    "Thanks for reaching out to Pet Waste Wagon — we've got your request.",
    '',
    `Yard: ${d.address || '—'}`,
    `Dogs: ${d.dogs || '—'}`,
    `Service: ${d.freq || '—'}`,
    '',
    `We'll text your price to ${d.phone || 'your phone'} within a couple hours. ` +
      "Once it looks good to you, we'll send a payment link and get you on the route. " +
      'No contracts, cancel anytime, and you get a photo of your closed gate after every visit.',
    '',
    'Questions before then? Just reply to this email, or call/text (704) 559-9522.',
    '',
    '— Pet Waste Wagon',
    'petwastewagon.com'
  ].join('\n');
}

exports.handler = async (event) => {
  // Always resolve 200. A non-2xx here makes Netlify treat the submission hook
  // as failed and retry it, which would double-send confirmations. Problems are
  // surfaced in the function log instead.
  const ok = (msg) => ({ statusCode: 200, body: msg });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (err) {
    console.error('Could not parse submission payload:', err);
    return ok('bad payload, ignored');
  }

  const data = (body.payload && body.payload.data) || {};
  const to = String(data.email || '').trim();

  // Submissions captured before the email field existed have nowhere to go.
  if (!to) return ok('no email on submission, nothing to send');

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.CONFIRMATION_FROM;
  if (!apiKey || !from) {
    console.error(
      'Confirmation NOT sent: set RESEND_API_KEY and CONFIRMATION_FROM in ' +
      'Netlify → Project configuration → Environment variables.'
    );
    return ok('not configured');
  }

  let html = '';
  try {
    const res = await fetch(TEMPLATE_URL, { headers: { 'cache-control': 'no-cache' } });
    if (res.ok) {
      html = (await res.text())
        .replace(/\{\{NAME\}\}/g, esc(firstName(data.name)))
        .replace(/\{\{NEIGHBORHOOD\}\}/g, esc(data.address || '—'))
        .replace(/\{\{DOGS\}\}/g, esc(data.dogs || '—'))
        .replace(/\{\{SERVICE\}\}/g, esc(data.freq || '—'))
        .replace(/\{\{PHONE\}\}/g, esc(data.phone || 'your phone'));
    } else {
      console.error('Template fetch returned', res.status, '— falling back to plain text.');
    }
  } catch (err) {
    console.error('Template fetch failed, falling back to plain text:', err);
  }

  const message = {
    from,
    to: [to],
    subject: `We've got your request, ${firstName(data.name)}`,
    text: plainText(data)
  };
  if (html) message.html = html;
  if (process.env.CONFIRMATION_REPLY_TO) message.reply_to = process.env.CONFIRMATION_REPLY_TO;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(message)
    });
    const detail = await res.text();
    if (!res.ok) {
      console.error('Email provider rejected the send:', res.status, detail);
      return ok('send failed');
    }
    console.log('Confirmation sent to', to);
    return ok('sent');
  } catch (err) {
    console.error('Sending threw:', err);
    return ok('send threw');
  }
};
