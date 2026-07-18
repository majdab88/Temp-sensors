'use strict';

// Expo push delivery. No credentials needed on our side — Expo's service fans
// out to APNs/FCM using the credentials configured in the Expo/EAS project.
// https://docs.expo.dev/push-notifications/sending-notifications/

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const CHUNK_SIZE = 100;
const TIMEOUT_MS = 8000;

/**
 * Send a notification to a list of Expo push tokens.
 * Best-effort: network/HTTP errors are swallowed and logged so alerting never
 * throws. Returns the tokens Expo reported as permanently invalid so the caller
 * can prune them.
 *
 * @param {string[]} tokens
 * @param {{title: string, body: string, data?: object}} payload
 * @returns {Promise<{invalidTokens: string[]}>}
 */
async function sendPush(tokens, { title, body, data }) {
  const invalidTokens = [];
  if (!tokens || tokens.length === 0) return { invalidTokens };

  for (let i = 0; i < tokens.length; i += CHUNK_SIZE) {
    const chunk = tokens.slice(i, i + CHUNK_SIZE);
    const messages = chunk.map((to) => ({
      to,
      title,
      body,
      data,
      sound: 'default',
      priority: 'high',
    }));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(messages),
        signal: controller.signal,
      });
      const json = await res.json().catch(() => null);
      const tickets = json?.data;
      if (Array.isArray(tickets)) {
        tickets.forEach((ticket, idx) => {
          if (ticket.status === 'error') {
            if (ticket.details?.error === 'DeviceNotRegistered') invalidTokens.push(chunk[idx]);
            console.warn(`[push] ticket error for ${chunk[idx]}: ${ticket.message}`);
          }
        });
      } else {
        console.warn('[push] unexpected Expo response:', JSON.stringify(json)?.slice(0, 200));
      }
    } catch (err) {
      console.error('[push] send failed:', err.message);
    } finally {
      clearTimeout(timer);
    }
  }

  return { invalidTokens };
}

module.exports = { sendPush };
