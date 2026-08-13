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

// Posted pricing covers up to four dogs, so for those the price and the Stripe
// link are already decided — the confirmation can include both and the customer
// can pay immediately with no manual step. Five or more dogs genuinely needs a
// human quote, so those get the follow-up wording instead.
//
// KEEP IN SYNC with the pricing table in petwastewagonclt-website.html and
// stripe-payment-links-LIVE.md. If a price or link changes in one place and not
// here, customers get quoted one number and charged another.
const PRICING = {
  'Weekly': {
    '1-2': { price: '$20', cadence: 'per week',    link: 'https://buy.stripe.com/fZu3cw7Soa2B1lX5yl9fW05' },
    '3':   { price: '$25', cadence: 'per week',    link: 'https://buy.stripe.com/3cI3cw5KgcaJ4y90e19fW03' },
    '4':   { price: '$30', cadence: 'per week',    link: 'https://buy.stripe.com/3cI14o8Ws3EdggRf8V9fW08' }
  },
  'Bi-Weekly': {
    '1-2': { price: '$28', cadence: 'every 2 weeks', link: 'https://buy.stripe.com/fZu00kdcI2A9aWx8Kx9fW04' },
    '3':   { price: '$33', cadence: 'every 2 weeks', link: 'https://buy.stripe.com/eVqbJ2goUeiRe8J9OB9fW02' },
    '4':   { price: '$38', cadence: 'every 2 weeks', link: 'https://buy.stripe.com/9B6eVea0wa2B0hT0e19fW01' }
  },
  'One-Time Deep Clean': {
    '1-2': { price: '$45', cadence: 'one-time', link: 'https://buy.stripe.com/eVq5kEa0w1w57KlbWJ9fW07' },
    '3':   { price: '$55', cadence: 'one-time', link: 'https://buy.stripe.com/aFa8wQ3C88Yx7KlbWJ9fW00' },
    '4':   { price: '$65', cadence: 'one-time', link: 'https://buy.stripe.com/cNifZi3C82A9ggRaSF9fW06' }
  }
};

function priceFor(freq, dogs) {
  const plan = PRICING[String(freq || '').trim()];
  if (!plan) return null;
  const n = parseInt(dogs, 10);
  if (!Number.isFinite(n) || n < 1 || n > 4) return null; // 5+ → custom quote
  const tier = n <= 2 ? '1-2' : String(n);
  return plan[tier] || null;
}

// Keeps whichever conditional block applies and removes the other. The template
// marks them with HTML comments so it still previews sensibly on its own.
function pickBlock(html, keep) {
  const drop = keep === 'PRICE' ? 'CUSTOM' : 'PRICE';
  const dropRe = new RegExp(`<!--${drop}_BLOCK_START-->[\\s\\S]*?<!--${drop}_BLOCK_END-->`, 'g');
  return html
    .replace(dropRe, '')
    .replace(new RegExp(`<!--${keep}_BLOCK_(START|END)-->`, 'g'), '');
}

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

function plainText(d, quote) {
  const lines = [
    `Hi ${firstName(d.name)},`,
    '',
    "Thanks for reaching out to Pet Waste Wagon — we've got your request.",
    '',
    `Yard: ${d.address || '—'}`,
    `Dogs: ${d.dogs || '—'}`,
    `Service: ${d.freq || '—'}`
  ];

  if (quote) {
    lines.push(
      `Your price: ${quote.price} ${quote.cadence}`,
      '',
      'Ready to start? You can set up service here:',
      quote.link
    );
  } else {
    lines.push(
      '',
      "You've got more than four dogs, so we'll put together a custom quote and " +
        'email it to you within a couple hours.'
    );
  }

  lines.push(
    '',
    'Questions? Just reply to this email.',
    '',
    '— Pet Waste Wagon',
    'petwastewagon.com'
  );
  return lines.join('\n');
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

  const quote = priceFor(data.freq, data.dogs);

  let html = '';
  try {
    const res = await fetch(TEMPLATE_URL, { headers: { 'cache-control': 'no-cache' } });
    if (res.ok) {
      html = pickBlock(await res.text(), quote ? 'PRICE' : 'CUSTOM')
        .replace(/\{\{NAME\}\}/g, esc(firstName(data.name)))
        .replace(/\{\{NEIGHBORHOOD\}\}/g, esc(data.address || '—'))
        .replace(/\{\{DOGS\}\}/g, esc(data.dogs || '—'))
        .replace(/\{\{SERVICE\}\}/g, esc(data.freq || '—'))
        .replace(/\{\{PRICE\}\}/g, esc(quote ? quote.price : ''))
        .replace(/\{\{CADENCE\}\}/g, esc(quote ? quote.cadence : ''))
        .replace(/\{\{PAY_LINK\}\}/g, quote ? quote.link : '#')
        // strip the template's internal notes so they don't ride along in the
        // customer's email (and so stale placeholder docs can't look like a bug)
        .replace(/<!--[\s\S]*?-->/g, '');
    } else {
      console.error('Template fetch returned', res.status, '— falling back to plain text.');
    }
  } catch (err) {
    console.error('Template fetch failed, falling back to plain text:', err);
  }

  const message = {
    from,
    to: [to],
    subject: quote
      ? `Your Pet Waste Wagon quote — ${quote.price} ${quote.cadence}`
      : `We've got your request, ${firstName(data.name)}`,
    text: plainText(data, quote)
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
    console.log('Confirmation sent to', to, quote ? '(with payment link)' : '(custom quote follow-up)');
    return ok('sent');
  } catch (err) {
    console.error('Sending threw:', err);
    return ok('send threw');
  }
};
