/**
 * Mesh admin — thin wrapper around the local `nvpn` CLI so the bridge can wire phone
 * onboarding into the nostr-vpn mesh WITHOUT the operator running any CLI by hand.
 *
 * Three jobs, each a single `execFile('nvpn', ...)` call (argv array — no shell, no
 * interpolation), mirroring how deviceActions.ts isolates adb:
 *   - createInvite():     mint a fresh `nvpn://invite/...` for the active network, to fold into
 *                         the pairing QR so the phone can self-import it.
 *   - addParticipant(hex): authorize a phone on the active network roster (idempotent; `nvpn`
 *                         stores hex and the running daemon re-publishes the signed roster on
 *                         reload). This is the hidden step that used to require manual CLI.
 *   - derivePeerIp(hex):  resolve a phone's DETERMINISTIC mesh tunnel IP from its pubkey
 *                         (`10.44.x.y`), so the bridge writes the test-device's adb serial
 *                         itself — the user never types a mesh IP.
 *   - daemonRunning():    is the local nvpn daemon up? (roster propagation needs it.)
 *
 * Every call is best-effort: if `nvpn` is absent (desktop / no mesh) or the command fails,
 * the helper returns null/false and the caller degrades gracefully (pure-pairing QR still works).
 * The `nvpn` binary is resolved from CODEDECK_NVPN_PATH, then well-known absolute install locations,
 * then bare PATH. The absolute lookups matter because a snap/flatpak VSCode runs the extension host
 * with a sanitized PATH that does NOT include ~/.cargo/bin (where `nvpn` installs by default) — so a
 * bare `execFile('nvpn')` fails with ENOENT and mesh onboarding silently degrades to a plain QR.
 */

import { execFile } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

/** Resolve the nvpn binary: explicit env override → known absolute paths → bare PATH fallback. */
function resolveNvpn(): string {
  if (process.env.CODEDECK_NVPN_PATH) return process.env.CODEDECK_NVPN_PATH;
  const home = os.homedir();
  const candidates = [
    path.join(home, '.cargo', 'bin', 'nvpn'),   // default cargo/`nvpn install-cli` location
    path.join(home, '.local', 'bin', 'nvpn'),
    '/usr/local/bin/nvpn',
    '/usr/bin/nvpn',
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return 'nvpn'; // last resort: rely on PATH (works when VSCode inherits a full shell env)
}

const NVPN = resolveNvpn();

/** Cap any single nvpn call. add-participant triggers a daemon reload that can take a few seconds. */
const NVPN_TIMEOUT_MS = 15_000;
const NVPN_MAX_BUFFER = 1024 * 1024;

/** Phone pubkey: 64 lowercase/uppercase hex chars OR a bech32 npub. Validated before any exec so a
 *  crafted pubkey can never become extra argv / a flag. */
const PUBKEY_RE = /^(?:[0-9a-fA-F]{64}|npub1[023456789acdefghjklmnpqrstuvwxyz]{6,})$/;

function isValidPubkey(pubkey: string): boolean {
  return PUBKEY_RE.test((pubkey || '').trim());
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function runNvpn(args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      NVPN,
      args,
      { timeout: NVPN_TIMEOUT_MS, maxBuffer: NVPN_MAX_BUFFER, encoding: 'utf8' },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: String(stdout ?? '').trim(),
          stderr: err ? `${String(stderr ?? '')}${err.message ? `\n${err.message}` : ''}` : String(stderr ?? ''),
        });
      },
    );
  });
}

export interface MeshInvite {
  /** Full `nvpn://invite/...` code to fold into the pairing QR. */
  invite: string;
  /** The active network id (e.g. "a237c978"), needed by the phone/bridge for IP derivation. */
  networkId: string;
}

/**
 * Mint a fresh invite for the active network and resolve its network id.
 * Returns null if nvpn is unavailable or there's no active network.
 */
export async function createInvite(): Promise<MeshInvite | null> {
  const r = await runNvpn(['create-invite']);
  if (!r.ok) return null;
  const invite = r.stdout.split(/\s+/).find(t => t.startsWith('nvpn://invite/'));
  if (!invite) return null;

  const networkId = networkIdFromInvite(invite) ?? (await activeNetworkId());
  if (!networkId) return null;
  return { invite, networkId };
}

/** Decode the base64 payload of an `nvpn://invite/...` code to read its networkId (no extra exec). */
function networkIdFromInvite(invite: string): string | null {
  try {
    const b64 = invite.replace(/^nvpn:\/\/invite\//, '');
    // URL_SAFE_NO_PAD → standard base64 for Buffer.
    const std = b64.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(std, 'base64').toString('utf8');
    const parsed = JSON.parse(json) as { networkId?: string };
    return typeof parsed.networkId === 'string' && parsed.networkId ? parsed.networkId : null;
  } catch {
    return null;
  }
}

/** Read the active network id via `nvpn status --json`. */
export async function activeNetworkId(): Promise<string | null> {
  const r = await runNvpn(['status', '--json']);
  if (!r.ok) return null;
  try {
    const parsed = JSON.parse(r.stdout) as { network_id?: string; networkId?: string };
    const id = parsed.network_id ?? parsed.networkId;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

/**
 * Authorize a phone (by pubkey hex or npub) on the active network roster. Idempotent — re-adding an
 * existing participant is a no-op at the roster level. The running daemon re-publishes the signed
 * roster on reload, so the phone becomes reachable shortly after (provided the daemon is up).
 * Returns true on success.
 */
export async function addParticipant(pubkey: string): Promise<boolean> {
  if (!isValidPubkey(pubkey)) return false;
  const r = await runNvpn(['add-participant', '--participant', pubkey.trim()]);
  return r.ok;
}

/**
 * Resolve a peer's deterministic mesh tunnel IP from its pubkey (hex or npub), e.g. "10.44.204.101".
 * Mirrors the engine's sha256(network_id + pubkey) derivation — but by SHELLING OUT to nvpn rather
 * than re-implementing it, so the bridge can never drift from the engine. Strips the "/32" suffix.
 * Returns null if nvpn is unavailable, the pubkey is invalid, or no IP could be derived.
 */
export async function derivePeerIp(pubkey: string): Promise<string | null> {
  if (!isValidPubkey(pubkey)) return null;
  const r = await runNvpn(['ip', '--participant', pubkey.trim(), '--peer', '--json']);
  if (!r.ok) return null;
  try {
    const arr = JSON.parse(r.stdout) as unknown;
    const first = Array.isArray(arr) ? arr[0] : arr;
    if (typeof first !== 'string') return null;
    const ip = first.split('/')[0].trim();
    return /^10\.44\.\d{1,3}\.\d{1,3}$/.test(ip) ? ip : null;
  } catch {
    return null;
  }
}

/**
 * Is the local nvpn daemon running and connected? Roster changes only propagate to phones when the
 * daemon is up (it re-publishes the FIPS roster on reload). Used to surface a clear "start nvpn"
 * message instead of silently leaving a phone unauthorized.
 */
export async function daemonRunning(): Promise<boolean> {
  const r = await runNvpn(['status', '--json']);
  if (!r.ok) return false;
  try {
    const parsed = JSON.parse(r.stdout) as { daemon?: { running?: boolean } };
    // `nvpn status --json` reports the persistent daemon under `daemon.running`. The daemon is what
    // re-publishes the signed roster on reload, so its liveness is exactly what gates whether a
    // just-added participant actually propagates to the phone.
    return parsed.daemon?.running === true;
  } catch {
    return false;
  }
}
