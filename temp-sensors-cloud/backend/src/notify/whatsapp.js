'use strict';

// Twilio WhatsApp delivery.
//   Sandbox:    TWILIO_WHATSAPP_FROM = 'whatsapp:+14155238886' (Twilio's shared
//               sandbox sender; recipients must have joined the sandbox). Freeform
//               Body works within the 24h session.
//   Production: your own approved WhatsApp sender; business-initiated messages
//               require a pre-approved template (see TODO below).
// Config is optional — if the env vars are absent, sends are skipped (logged),
// so alerting never breaks on an unconfigured deployment.

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
const FROM        = process.env.TWILIO_WHATSAPP_FROM; // e.g. 'whatsapp:+14155238886'
const TIMEOUT_MS  = 8000;

function isConfigured() {
  return !!(ACCOUNT_SID && AUTH_TOKEN && FROM);
}

/**
 * Send a WhatsApp message to a list of E.164 numbers (e.g. '+972541234567').
 * Best-effort: per-number errors are logged and swallowed. Returns how many
 * Twilio accepted.
 *
 * @param {string[]} numbers  E.164 phone numbers
 * @param {string} body       message text
 * @returns {Promise<{sent: number}>}
 */
async function sendWhatsApp(numbers, body) {
  if (!isConfigured()) {
    console.warn('[whatsapp] Twilio not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_WHATSAPP_FROM) — skipping');
    return { sent: 0 };
  }
  if (!numbers || numbers.length === 0) return { sent: 0 };

  const url = `https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`;
  const auth = 'Basic ' + Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64');
  let sent = 0;

  for (const to of numbers) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      // TODO (production): swap Body for a pre-approved template via
      // ContentSid + ContentVariables — business-initiated messages outside a
      // 24h session are rejected without an approved template.
      const params = new URLSearchParams({ From: FROM, To: `whatsapp:${to}`, Body: body });
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
        signal: controller.signal,
      });
      if (res.ok) {
        sent++;
      } else {
        const txt = await res.text().catch(() => '');
        console.warn(`[whatsapp] send to ${to} failed: ${res.status} ${txt.slice(0, 200)}`);
      }
    } catch (err) {
      console.error('[whatsapp] send error:', err.message);
    } finally {
      clearTimeout(timer);
    }
  }

  return { sent };
}

module.exports = { sendWhatsApp, isConfigured };
