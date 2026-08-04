/**
 * CDB-036 — the status bar flapped between "N phones" and "offline" every 2 seconds
 * after a second phone was paired.
 *
 * Pairing calls `updatePairedPhones()`, which reconnects to widen the `authors` filter.
 * `connect()` tears the live subscription down, and nostr-tools fires that subscription's
 * `onclose` synchronously from `pool.destroy()`. The handler read it as a dropped
 * connection: it reported 'disconnected' AND scheduled a reconnect, which 2s later tore
 * down the subscription that had just come up — a self-sustaining loop (`oneose` reset
 * `reconnectAttempt`, so the backoff never grew past the 2s floor).
 *
 * These tests pin both halves: a deliberate re-subscribe is silent, a genuine drop still
 * reports and recovers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { PairedPhone } from '../types';
import type { NostrRelayEvents } from '../nostrRelay';

const hoisted = vi.hoisted(() => ({
  /** Every subscription handed out by the mock pool, oldest first. */
  subs: [] as Array<{ params: any; closed: boolean }>,
}));

vi.mock('nostr-tools/pool', () => {
  class SimplePool {
    private open: Array<{ params: any; closed: boolean }> = [];

    subscribeMany(_relays: string[], _filter: unknown, params: any) {
      const rec = { params, closed: false };
      this.open.push(rec);
      hoisted.subs.push(rec);
      return {
        // Mirrors nostr-tools: awaits `allOpened` before closing, so this lands on a
        // later microtask — after destroy() has already run.
        close: async (reason = 'closed by caller') => {
          await Promise.resolve();
          if (rec.closed) { return; }
          rec.closed = true;
          rec.params.onclose?.([reason]);
        },
      };
    }

    /** relay.close() -> closeAllSubscriptions() -> sub.onclose() — all synchronous. */
    destroy() {
      for (const rec of this.open) {
        if (rec.closed) { continue; }
        rec.closed = true;
        rec.params.onclose?.(['relay connection closed by us']);
      }
      this.open = [];
    }

    publish() { return [Promise.resolve('ok')]; }
    close() { /* no-op */ }
  }
  return { SimplePool };
});

const { NostrRelay } = await import('../nostrRelay');

const phone = (label: string): PairedPhone => {
  const pubkeyHex = getPublicKey(generateSecretKey());
  return { npub: `npub-${label}`, pubkeyHex, label, pairedAt: new Date(0).toISOString() };
};

const RELAYS = ['wss://relay.primal.net', 'wss://nos.lol', 'wss://relay2.descendant.io'];

let relay: InstanceType<typeof NostrRelay>;
let statuses: string[];

const makeRelay = (phones: PairedPhone[]) => {
  relay = new NostrRelay(
    generateSecretKey(),
    RELAYS,
    phones,
    'Framework',
    {} as NostrRelayEvents,
    () => { /* silence logs */ },
  );
  statuses = [];
  relay.setConnectionCallback((status) => statuses.push(status));
  return relay;
};

const latestSub = () => hoisted.subs[hoisted.subs.length - 1];

beforeEach(() => {
  vi.useFakeTimers();
  hoisted.subs.length = 0;
});

afterEach(() => {
  relay?.dispose();
  vi.useRealTimers();
});

describe('NostrRelay connection status (CDB-036)', () => {
  it('pairing a second phone does not report a disconnect or start a reconnect loop', () => {
    const phoneA = phone('Pixel 8');
    const phoneB = phone('Pixel 9');

    makeRelay([phoneA]).connect();
    latestSub().params.oneose();
    expect(statuses).toEqual(['connected']);

    // The second phone pairs: the authors filter widens, so the bridge re-subscribes.
    relay.updatePairedPhones([phoneA, phoneB]);

    // The subscription we tore down on purpose must not surface as a lost connection.
    expect(statuses).toEqual(['connected']);
    expect(hoisted.subs).toHaveLength(2);

    latestSub().params.oneose();
    expect(statuses).toEqual(['connected', 'connected']);

    // No reconnect was scheduled — the flap loop is what created extra subscriptions.
    vi.advanceTimersByTime(60_000);
    expect(hoisted.subs).toHaveLength(2);
    expect(statuses).toEqual(['connected', 'connected']);
  });

  it('a genuine relay drop still reports disconnected and reconnects', () => {
    makeRelay([phone('Pixel 8')]).connect();
    latestSub().params.oneose();
    statuses.length = 0;

    // The live subscription dies on its own — not a teardown we asked for.
    latestSub().params.onclose(['relay connection closed']);
    expect(statuses).toEqual(['disconnected']);

    vi.advanceTimersByTime(2_000);
    expect(hoisted.subs).toHaveLength(2);

    latestSub().params.oneose();
    expect(statuses).toEqual(['disconnected', 'connected']);
  });

  it('changing the relay list re-subscribes silently', () => {
    makeRelay([phone('Pixel 8')]).connect();
    latestSub().params.oneose();
    statuses.length = 0;

    relay.updateRelays(['wss://relay.damus.io']);

    expect(statuses).toEqual([]);
    expect(hoisted.subs).toHaveLength(2);
  });
});
