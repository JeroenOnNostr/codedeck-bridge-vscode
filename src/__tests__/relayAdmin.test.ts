import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerPhoneOnRelay } from '../relayAdmin';

const PHONE_HEX = 'c1cf657c71ce41b45f2c4f323f688cd9f01b8c2ddc2b3a05bfab4007c40a6bdc';
const CFG = { endpoint: 'https://relay2.descendant.io/api/register-agent', token: 'admin-tok' };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('registerPhoneOnRelay', () => {
  it('maps 201 → registered and sends Bearer auth + lowercased pubkey', async () => {
    fetchMock.mockResolvedValue({ status: 201 } as Response);
    const r = await registerPhoneOnRelay(PHONE_HEX, CFG);
    expect(r).toEqual({ ok: true, status: 'registered' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(CFG.endpoint);
    expect((init as RequestInit).method).toBe('POST');
    expect((init as any).headers.Authorization).toBe('Bearer admin-tok');
    expect(JSON.parse((init as any).body).pubkey).toBe(PHONE_HEX.toLowerCase());
  });

  it('maps 200 → already_registered (idempotent)', async () => {
    fetchMock.mockResolvedValue({ status: 200 } as Response);
    expect(await registerPhoneOnRelay(PHONE_HEX, CFG)).toEqual({ ok: true, status: 'already_registered' });
  });

  it('maps 401 → unauthorized', async () => {
    fetchMock.mockResolvedValue({ status: 401 } as Response);
    const r = await registerPhoneOnRelay(PHONE_HEX, CFG);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/unauthorized/);
  });

  it('no-ops (not-configured) when endpoint or token is missing — never calls fetch', async () => {
    expect(await registerPhoneOnRelay(PHONE_HEX, { endpoint: '', token: '' })).toEqual({ ok: false, reason: 'not-configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid pubkey before fetch', async () => {
    const r = await registerPhoneOnRelay('not-hex', CFG);
    expect(r).toEqual({ ok: false, reason: 'invalid-pubkey' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a network error as a reason (never throws)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await registerPhoneOnRelay(PHONE_HEX, CFG);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toMatch(/ECONNREFUSED/);
  });
});
