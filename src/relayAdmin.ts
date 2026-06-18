/**
 * Relay admin — auto-register a paired phone's pubkey on a WRITE-RESTRICTED private relay so the
 * phone can publish high-frequency session traffic there (a private relay avoids the rate-limits /
 * unreliability of public relays for that volume).
 *
 * The two-channel relay model this enables:
 *   - PAIRING (rare, low-volume): rides an OPEN relay in `codedeck.relays`, because a fresh phone's
 *     auto-generated key is not yet registered on the private relay and its pair-request would be
 *     rejected ("restricted: not a registered user").
 *   - SESSIONS (high-frequency): once the bridge registers the phone here, both directions can use
 *     the private relay.
 *
 * The endpoint is the relay's admin API (e.g. POST https://relay2.descendant.io/api/register-agent,
 * Bearer token, body {pubkey:<64-hex>}; idempotent — returns 200 already_registered / 201 registered).
 * No-op when no endpoint/token is configured (all-open-relay setups don't need this).
 */

export interface RelayRegisterConfig {
  endpoint: string;  // e.g. https://relay2.descendant.io/api/register-agent
  token: string;     // Bearer admin token
}

export type RelayRegisterResult =
  | { ok: true; status: 'registered' | 'already_registered' }
  | { ok: false; reason: string };

/**
 * Register a phone pubkey (hex) on the private relay's whitelist. Returns a structured result so the
 * caller can surface a clear notice. Best-effort: never throws.
 */
export async function registerPhoneOnRelay(
  pubkeyHex: string,
  config: RelayRegisterConfig,
): Promise<RelayRegisterResult> {
  if (!config.endpoint || !config.token) {
    return { ok: false, reason: 'not-configured' };
  }
  if (!/^[0-9a-f]{64}$/i.test(pubkeyHex)) {
    return { ok: false, reason: 'invalid-pubkey' };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let res: Response;
    try {
      res = await fetch(config.endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ pubkey: pubkeyHex.toLowerCase() }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 201) return { ok: true, status: 'registered' };
    if (res.status === 200) return { ok: true, status: 'already_registered' };
    if (res.status === 401) return { ok: false, reason: 'unauthorized (bad admin token)' };
    return { ok: false, reason: `relay returned HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
