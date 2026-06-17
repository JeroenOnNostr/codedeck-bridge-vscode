/**
 * Device actions — deterministic adb operations exposed to *test sessions* as SDK MCP tools.
 *
 * Security model (per plan): a CLOSED ENUM of adb operations, each run via execFile with an argv
 * ARRAY (never a shell string — no interpolation injection), and the device serial is validated
 * against a strict `<host>:<port>` or known-serial regex before any call. The MCP tool *handler*
 * is fully deterministic Node; Claude only chooses which validated tool to call. These tools are
 * attached ONLY to sessions flagged as test sessions (see sdkSession.ts), so normal coding
 * sessions never get device control.
 *
 * adb itself is reached over the nostr-vpn mesh: the serial is the phone's mesh IP:port (or a USB
 * serial during local setup). The laptop's system `adb` is used via execFile.
 */

import { execFile } from 'child_process';
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';

const ADB =
  process.env.CODEDECK_ADB_PATH ||
  path.join(os.homedir(), 'Android', 'Sdk', 'platform-tools', 'adb');

/** mesh-ip:port (e.g. 10.44.12.34:5555) or a bare device serial (alnum, : . - _ only). */
const SERIAL_RE = /^[A-Za-z0-9][A-Za-z0-9.:_-]{2,63}$/;

/** Cap any single adb call so a hung device can't wedge a test session. */
const ADB_TIMEOUT_MS = 30_000;
const ADB_MAX_BUFFER = 16 * 1024 * 1024; // logcat/screencap can be large

export interface DeviceActionResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Set for binary-producing actions (screenshot): absolute path to the captured file. */
  artifactPath?: string;
}

function validateSerial(serial: string): string {
  const s = (serial || '').trim();
  if (!SERIAL_RE.test(s)) {
    throw new Error(`invalid device serial: ${JSON.stringify(serial)}`);
  }
  return s;
}

/** Run `adb -s <serial> <args...>` with argv array — NO shell, no interpolation. */
function adb(serial: string, args: string[], opts?: { binaryStdout?: boolean }): Promise<DeviceActionResult> {
  const s = validateSerial(serial);
  return new Promise((resolve) => {
    execFile(
      ADB,
      ['-s', s, ...args],
      {
        timeout: ADB_TIMEOUT_MS,
        maxBuffer: ADB_MAX_BUFFER,
        encoding: opts?.binaryStdout ? 'buffer' : 'utf8',
      },
      (err, stdout, stderr) => {
        const out = opts?.binaryStdout ? '' : String(stdout ?? '');
        const errOut = stderr ? String(stderr) : '';
        resolve({
          ok: !err,
          stdout: out,
          stderr: err ? `${errOut}${err.message ? `\n${err.message}` : ''}` : errOut,
        });
      },
    );
  });
}

/** Raw adb (no -s) for connect, used before a device serial is established. */
function adbRaw(args: string[]): Promise<DeviceActionResult> {
  return new Promise((resolve) => {
    execFile(ADB, args, { timeout: ADB_TIMEOUT_MS, maxBuffer: ADB_MAX_BUFFER, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: err ? `${stderr ?? ''}\n${err.message}` : String(stderr ?? '') });
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Self-healing connection layer.
//
// On a real device over the mesh, Wireless Debugging silently turns OFF (idle/security timeout) and
// the adbd-wifi listener PORT rotates on every re-enable. Either makes adb fail with "connection
// refused" / "device offline" / "device not found" even though the mesh data plane is fine. This
// layer recovers WITHOUT a USB cable or a human tap:
//   1. ask CodeDeck (reachable over the mesh/relay, independent of adb) to re-enable Wireless
//      Debugging — it holds WRITE_SECURE_SETTINGS, so no human tap.
//   2. re-discover the (rotated) port: mDNS same-LAN, else a bounded TCP port-scan of the mesh IP
//      (an unprivileged app can't read adbd's port, so the laptop finds it itself), then reconnect.
// ─────────────────────────────────────────────────────────────────────────────

/** Phone-side WD-enable hook: ask CodeDeck (over the relay) to enable Wireless Debugging. Returns
 *  true if WD was enabled. Wired by core.ts; null when no phone channel is available (the port-scan
 *  + mDNS fallbacks still recover a port-rotation as long as WD is already on). */
export type PrepareAdbFn = (meshIp: string) => Promise<boolean>;

let prepareAdbFn: PrepareAdbFn | null = null;
export function setPrepareAdbFn(fn: PrepareAdbFn | null): void {
  prepareAdbFn = fn;
}

const FAIL_RE = /no devices|device offline|not found|connection refused|cannot connect|failed to connect|closed|protocol fault|device unauthorized/i;

function splitHostPort(serial: string): { host: string; port: number } | null {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]):(\d{1,5})$/.exec(serial.trim());
  if (!m) return null;
  return { host: m[1], port: Number(m[2]) };
}

/**
 * Only port-scan / auto-recover hosts inside the nostr-vpn mesh CIDR (10.44.0.0/16). This stops the
 * port-discovery sweep from being abused as a port-scanner against arbitrary/loopback/LAN hosts via
 * a crafted serial — recovery is a mesh-only operation by design. USB serials (no host:port) and
 * any non-mesh literal are excluded from scanning (they can still connect on their exact endpoint).
 */
function isMeshHost(host: string): boolean {
  return /^10\.44\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Overall wall-clock budget for a single port-discovery sweep, so a dead host can't wedge a session. */
const PORT_SCAN_BUDGET_MS = 25_000;

/** Is this serial currently a healthy `device` in `adb devices`? */
async function isOnline(serial: string): Promise<boolean> {
  const r = await adbRaw(['devices']);
  if (!r.ok) return false;
  const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith(serial + '\t') || l.startsWith(serial + ' '));
  return !!line && /\bdevice\b/.test(line) && !/offline|unauthorized/.test(line);
}

/** mDNS lookup of the device's current adb-tls-connect endpoint (same-LAN only). */
async function mdnsEndpoint(meshIp: string): Promise<string | null> {
  const r = await adbRaw(['mdns', 'services']);
  if (!r.ok) return null;
  // Lines look like: adb-<serial>-xxxx\t_adb-tls-connect._tcp\t<ip>:<port>
  for (const l of r.stdout.split(/\r?\n/)) {
    const m = /_adb-tls-connect\._tcp\s+(\S+):(\d+)/.exec(l);
    if (m && m[1] === meshIp) return `${m[1]}:${m[2]}`;
  }
  return null;
}

/** Quick TCP-connect probe to host:port (used to find adbd's rotated wifi port over the mesh). */
function tcpProbe(host: string, port: number, timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok: boolean) => { if (!done) { done = true; sock.destroy(); resolve(ok); } };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, host);
  });
}

/**
 * Find adbd's (rotated) Wireless-Debugging port on the mesh IP by probing candidate ports. adbd-wifi
 * binds an ephemeral high port; on the Pixel 9 (Android 16) these cluster in ~30000–45000. We probe
 * the last-known port first, then sweep the most-likely range before the wider Linux ephemeral range.
 * Cross-network this is the only way to learn the port (mDNS can't cross LANs and the phone can't
 * read adbd's socket). Returns the open port, or null.
 */
async function discoverAdbPort(host: string, lastKnown?: number): Promise<number | null> {
  // SECURITY: never sweep a non-mesh host — recovery is mesh-only; this blocks SSRF-style scans.
  if (!isMeshHost(host)) return null;
  const deadline = Date.now() + PORT_SCAN_BUDGET_MS;
  const tryPort = async (p: number) => (await tcpProbe(host, p)) ? p : null;
  if (lastKnown && (await tryPort(lastKnown))) return lastKnown;
  // Scan the observed adbd-wifi band first (fast hit), then the rest of the Linux ephemeral range as
  // a fallback. Concurrent batches keep it quick over a high-latency mesh link. Bail at the deadline.
  const ranges: Array<[number, number]> = [
    [35000, 46000], // most-likely adbd-wifi band observed on the Pixel 9
    [30000, 35000],
    [46000, 61000], // wider Linux ip_local_port_range fallback
  ];
  const batch = 96;
  for (const [lo, hi] of ranges) {
    for (let start = lo; start <= hi; start += batch) {
      if (Date.now() > deadline) return null; // time budget exceeded
      const ports: number[] = [];
      for (let p = start; p < Math.min(start + batch, hi + 1); p++) ports.push(p);
      const hits = await Promise.all(ports.map((p) => tryPort(p)));
      const found = hits.find((p): p is number => p !== null);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Warm a freshly (re)established FIPS mesh path before relying on adb's TLS handshake. Right after a
 * cold mesh start the path jitters badly (measured 250–1400ms, settling to ~100ms) and adb's TLS
 * handshake times out → "device offline". A few quick TCP probes drive traffic through the tunnel so
 * it converges; we return once probes are landing consistently (or give up after the budget).
 */
async function warmPath(host: string, port: number, attempts = 6): Promise<void> {
  let consecutive = 0;
  for (let i = 0; i < attempts; i++) {
    if (await tcpProbe(host, port, 1500)) {
      if (++consecutive >= 2) return; // two clean probes in a row ⇒ path is settling
    } else {
      consecutive = 0;
    }
  }
}

/** Last port that worked per mesh host, to make recovery fast on the common case (WD just toggled). */
const lastGoodPort = new Map<string, number>();

/**
 * Ensure adb is connected to the test device, recovering from WD-off / port-rotation if needed.
 * Returns the serial that is actually online (host:port may differ from the input if the port
 * rotated). Throws if it cannot establish a connection.
 */
export async function ensureConnected(serial: string): Promise<string> {
  const s = validateSerial(serial);
  if (await isOnline(s)) return s;

  const hp = splitHostPort(s);
  // Step 0: a plain reconnect to the given endpoint (covers a transient drop, port unchanged).
  await adbRaw(['disconnect', s]).catch(() => undefined);
  await adbRaw(['connect', s]).catch(() => undefined);
  if (await isOnline(s)) return s;

  if (!hp) {
    // USB serial or non host:port — nothing to re-discover; report current state.
    if (await isOnline(s)) return s;
    throw new Error(`device ${s} not reachable and no host:port to recover`);
  }

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  // Connect to a port, warming the (possibly cold/jittery) path first and retrying the adb TLS
  // handshake with backoff — the handshake fails as "offline" on a freshly-restarted mesh until the
  // FIPS path settles, even though the port is reachable.
  const tryConnect = async (port: number): Promise<string | null> => {
    const ep = `${hp.host}:${port}`;
    await warmPath(hp.host, port);
    for (let attempt = 0; attempt < 3; attempt++) {
      await adbRaw(['disconnect', ep]).catch(() => undefined);
      await adbRaw(['connect', ep]).catch(() => undefined);
      // adb may report "device" but still be settling; poll briefly for a healthy state.
      for (let i = 0; i < 3; i++) {
        if (await isOnline(ep)) { lastGoodPort.set(hp.host, port); return ep; }
        await sleep(800);
      }
      await sleep(500 * (attempt + 1));
    }
    return null;
  };

  // Step 1: ask CodeDeck (over the relay) to re-enable Wireless Debugging — no human tap.
  if (prepareAdbFn) {
    await prepareAdbFn(hp.host).catch(() => false);
  }

  // Step 2: mDNS (same-LAN — instant when it applies).
  const mdns = await mdnsEndpoint(hp.host);
  if (mdns) {
    await adbRaw(['connect', mdns]).catch(() => undefined);
    if (await isOnline(mdns)) {
      const p = splitHostPort(mdns); if (p) lastGoodPort.set(hp.host, p.port);
      return mdns;
    }
  }

  // Step 3: discover the rotated port by probing the mesh IP (last-known first), then connect.
  const port = await discoverAdbPort(hp.host, lastGoodPort.get(hp.host) ?? hp.port);
  if (port) {
    const ep = await tryConnect(port);
    if (ep) return ep;
  }

  // Step 4: last try on the original endpoint.
  const orig = await tryConnect(hp.port);
  if (orig) return orig;

  throw new Error(`device ${s} unreachable: Wireless Debugging may be off (open CodeDeck → Mesh on the phone to re-enable) or the mesh is down.`);
}

/** Run an adb action, self-healing the connection once on a connection-class failure. */
async function withRecovery(serial: string, run: (s: string) => Promise<DeviceActionResult>): Promise<DeviceActionResult> {
  let s: string;
  try {
    s = await ensureConnected(serial);
  } catch (e) {
    return { ok: false, stdout: '', stderr: String(e instanceof Error ? e.message : e) };
  }
  const r = await run(s);
  if (r.ok || !FAIL_RE.test(r.stderr)) return r;
  // One recovery attempt on a connection-class error.
  try {
    const s2 = await ensureConnected(serial);
    return await run(s2);
  } catch {
    return r; // return the original failure if recovery couldn't help
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic action implementations (also reusable by the Phase-6 build loop)
// ─────────────────────────────────────────────────────────────────────────────

export async function deviceConnect(serial: string): Promise<DeviceActionResult> {
  // serial here is host:port. Use the self-healing path so a rotated port / WD-off recovers and the
  // result reports the endpoint that is actually online.
  try {
    const live = await ensureConnected(serial);
    return { ok: true, stdout: `connected to ${live}`, stderr: '' };
  } catch (e) {
    return { ok: false, stdout: '', stderr: String(e instanceof Error ? e.message : e) };
  }
}

export async function deviceList(): Promise<DeviceActionResult> {
  return adbRaw(['devices', '-l']);
}

export async function deviceInstall(serial: string, apkPath: string): Promise<DeviceActionResult> {
  if (!apkPath || !fs.existsSync(apkPath)) {
    return { ok: false, stdout: '', stderr: `APK not found: ${apkPath}` };
  }
  return withRecovery(serial, async (s) => {
    const r = await adb(s, ['install', '-r', '-d', apkPath]);
    if (r.ok) return r;
    // Signature mismatch on a dev rebuild (e.g. a release/Zapstore build is already installed):
    // uninstall the conflicting package, then reinstall. Pull the package id from the APK.
    if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(r.stderr)) {
      const pkg = await apkPackageId(apkPath);
      if (pkg) {
        await adb(s, ['uninstall', pkg]);
        const r2 = await adb(s, ['install', '-r', '-d', apkPath]);
        if (r2.ok) {
          return { ...r2, stdout: `${r2.stdout}\n(note: uninstalled conflicting ${pkg} due to signature mismatch, then reinstalled)` };
        }
        return r2;
      }
    }
    return r;
  });
}

export async function deviceLaunch(serial: string, pkg: string, activity?: string): Promise<DeviceActionResult> {
  if (!/^[A-Za-z0-9_.]+$/.test(pkg)) return { ok: false, stdout: '', stderr: `invalid package: ${pkg}` };
  if (activity && !/^[A-Za-z0-9_./]+$/.test(activity)) {
    return { ok: false, stdout: '', stderr: `invalid activity: ${activity}` };
  }
  return withRecovery(serial, async (s) => {
    if (activity) {
      const r = await adb(s, ['shell', 'am', 'start', '-n', `${pkg}/${activity}`]);
      // A wrong/renamed activity (e.g. a soft-fork that kept the upstream activity namespace) gives
      // "Activity class ... does not exist" / "Error type 3". Fall back to resolving the launcher.
      if (r.ok && !/does not exist|Error type 3/i.test(r.stdout) && !/does not exist|Error type 3/i.test(r.stderr)) return r;
    }
    // Resolve and launch the real LAUNCHER activity for the package.
    const resolved = await resolveLauncherActivity(s, pkg);
    if (resolved) {
      const r = await adb(s, ['shell', 'am', 'start', '-n', resolved]);
      if (r.ok && !/does not exist|Error type 3/i.test(r.stdout)) {
        return { ...r, stdout: `${r.stdout}\n(launched resolved activity ${resolved})` };
      }
    }
    // Last resort: monkey launches the default LAUNCHER activity without needing the activity name.
    return adb(s, ['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']);
  });
}

/** Resolve the real `pkg/activity` launcher component on the device (handles renamed/soft-fork activities). */
async function resolveLauncherActivity(serial: string, pkg: string): Promise<string | null> {
  const r = await adb(serial, ['shell', 'cmd', 'package', 'resolve-activity', '--brief', '-c', 'android.intent.category.LAUNCHER', pkg]);
  if (!r.ok) return null;
  // Output's last non-empty line is `pkg/activity` (e.g. com.kubo.app/pub.ditto.app.MainActivity).
  const line = r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || '';
  return /^[A-Za-z0-9_.]+\/[A-Za-z0-9_.]+$/.test(line) ? line : null;
}

/** Read the package id out of an APK using aapt/aapt2 if available; falls back to null. */
async function apkPackageId(apkPath: string): Promise<string | null> {
  const sdk = path.dirname(path.dirname(ADB)); // .../Android/Sdk
  const buildTools = path.join(sdk, 'build-tools');
  const candidates: string[] = [];
  try {
    for (const v of fs.readdirSync(buildTools).sort().reverse()) {
      candidates.push(path.join(buildTools, v, 'aapt2'), path.join(buildTools, v, 'aapt'));
    }
  } catch { /* no build-tools */ }
  for (const aapt of candidates) {
    if (!fs.existsSync(aapt)) continue;
    const args = aapt.endsWith('aapt2') ? ['dump', 'badging', apkPath] : ['dump', 'badging', apkPath];
    const out = await new Promise<string>((resolve) => {
      execFile(aapt, args, { timeout: ADB_TIMEOUT_MS, maxBuffer: ADB_MAX_BUFFER, encoding: 'utf8' }, (err, stdout) => resolve(err ? '' : String(stdout)));
    });
    const m = /package: name='([^']+)'/.exec(out);
    if (m) return m[1];
  }
  return null;
}

/**
 * Redact common secret shapes from text before it leaves the laptop (logcat/tool output rides the
 * Nostr output stream to the phone and sits at-rest on public relays). Best-effort, not a guarantee
 * — pair it with package-scoping. Covers bearer tokens, JWTs, nostr nsec, api/token/password=… kv,
 * and long hex/base64 blobs that look like keys.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9._-]{10,}/g, '[REDACTED_JWT]')
    .replace(/\bnsec1[02-9ac-hj-np-z]{20,}/gi, '[REDACTED_NSEC]')
    .replace(/([A-Za-z]*(?:api[_-]?key|secret|token|password|passwd|pwd|authorization|auth))\s*[=:]\s*["']?[^\s"'&]+/gi, '$1=[REDACTED]')
    .replace(/\b[A-Fa-f0-9]{64,}\b/g, '[REDACTED_HEX]');
}

/**
 * Fetch logcat. Scopes to the app-under-test's PID when `pkg` is given (so secrets in OTHER apps'
 * logs never leave the device), and always redacts common secret shapes from the result. Falls back
 * to the full ring buffer only when no pkg is provided or the app isn't running.
 */
export async function deviceLogcat(serial: string, lines = 200, pkg?: string): Promise<DeviceActionResult> {
  const n = Math.max(1, Math.min(2000, Math.floor(lines)));
  const result = await withRecovery(serial, async (s) => {
    let pid = '';
    if (pkg && /^[A-Za-z0-9_.]+$/.test(pkg)) {
      const p = await adb(s, ['shell', 'pidof', pkg]);
      pid = (p.stdout || '').trim().split(/\s+/)[0] || '';
    }
    // --pid scopes to the app under test; omit only if we couldn't resolve a pid.
    const args = pid
      ? ['logcat', '-d', '-t', String(n), '--pid', pid]
      : ['logcat', '-d', '-t', String(n)];
    return adb(s, args);
  });
  // Redact secret shapes regardless of scoping (defense-in-depth before it hits the relay).
  return { ...result, stdout: redactSecrets(result.stdout) };
}

export async function deviceUiDump(serial: string): Promise<DeviceActionResult> {
  // exec-out to /dev/tty streams the XML to stdout; tiny (~tens of KB), the assertion workhorse.
  return withRecovery(serial, (s) => adb(s, ['exec-out', 'uiautomator', 'dump', '/dev/tty']));
}

/** Capture a screenshot. Returns the raw PNG bytes path; Phase 3 downscales before sending. */
export async function deviceScreenshotRaw(serial: string, outDir: string): Promise<DeviceActionResult> {
  fs.mkdirSync(outDir, { recursive: true });
  return withRecovery(serial, (s) => {
    const outPath = path.join(outDir, `screencap-${s.replace(/[^A-Za-z0-9]/g, '_')}-${Date.now()}.png`);
    return new Promise<DeviceActionResult>((resolve) => {
      execFile(ADB, ['-s', s, 'exec-out', 'screencap', '-p'], { timeout: ADB_TIMEOUT_MS, maxBuffer: ADB_MAX_BUFFER, encoding: 'buffer' }, (err, stdout) => {
        if (err || !stdout || (stdout as Buffer).length === 0) {
          resolve({ ok: false, stdout: '', stderr: `screencap failed: ${err?.message ?? 'empty output'}` });
          return;
        }
        try {
          fs.writeFileSync(outPath, stdout as Buffer);
          resolve({ ok: true, stdout: `captured ${(stdout as Buffer).length} bytes`, stderr: '', artifactPath: outPath });
        } catch (e) {
          resolve({ ok: false, stdout: '', stderr: `write failed: ${String(e)}` });
        }
      });
    });
  });
}

export async function deviceTap(serial: string, x: number, y: number): Promise<DeviceActionResult> {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, stdout: '', stderr: 'tap requires numeric x,y' };
  return withRecovery(serial, (s) => adb(s, ['shell', 'input', 'tap', String(Math.round(x)), String(Math.round(y))]));
}

export async function deviceText(serial: string, text: string): Promise<DeviceActionResult> {
  // input text needs spaces as %s; argv array keeps it shell-safe.
  const escaped = text.replace(/ /g, '%s');
  return withRecovery(serial, (s) => adb(s, ['shell', 'input', 'text', escaped]));
}

export async function deviceKey(serial: string, keycode: string): Promise<DeviceActionResult> {
  if (!/^[A-Z0-9_]+$/.test(keycode)) return { ok: false, stdout: '', stderr: `invalid keycode: ${keycode}` };
  return withRecovery(serial, (s) => adb(s, ['shell', 'input', 'keyevent', keycode]));
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP server — wraps the above as tools handed to test sessions.
// onScreenshot lets the Bridge deliver the captured image to the phone (Phase 3).
// ─────────────────────────────────────────────────────────────────────────────

export interface DeviceMcpOptions {
  /** Where to write screenshot artifacts before delivery. */
  artifactDir: string;
  /** Called after a screenshot is captured; returns a short note to include in the tool result
   *  (e.g. "delivered to phone"). Phase 3 wires the actual bridge→phone send + downscale here. */
  onScreenshot?: (artifactPath: string, serial: string) => Promise<string>;
}

function textResult(r: DeviceActionResult) {
  const body = r.ok
    ? (r.stdout || '(ok)')
    : `ERROR: ${r.stderr || 'failed'}`;
  return { content: [{ type: 'text' as const, text: body.slice(0, 60_000) }], isError: !r.ok };
}

export function createDeviceMcpServer(opts: DeviceMcpOptions) {
  return createSdkMcpServer({
    name: 'device',
    version: '0.1.0',
    tools: [
      tool('connect', 'Connect adb to the test device over the mesh (serial = mesh IP:port).',
        { serial: z.string() },
        async ({ serial }) => textResult(await deviceConnect(serial))),

      tool('list', 'List adb devices currently visible to the laptop.',
        {},
        async () => textResult(await deviceList())),

      tool('install', 'Install (reinstall) an APK on the test device.',
        { serial: z.string(), apkPath: z.string() },
        async ({ serial, apkPath }) => textResult(await deviceInstall(serial, apkPath))),

      tool('launch', 'Launch an app on the test device by package id (optional explicit activity).',
        { serial: z.string(), pkg: z.string(), activity: z.string().optional() },
        async ({ serial, pkg, activity }) => textResult(await deviceLaunch(serial, pkg, activity))),

      tool('logcat', 'Fetch the last N lines of logcat (default 200, max 2000). Pass pkg (the app-under-test package id) to scope output to that app only — strongly preferred, so other apps’ logs/secrets never leave the device. Output is secret-redacted regardless.',
        { serial: z.string(), lines: z.number().optional(), pkg: z.string().optional() },
        async ({ serial, lines, pkg }) => textResult(await deviceLogcat(serial, lines ?? 200, pkg))),

      tool('ui_dump', 'Dump the current UI hierarchy as XML (small; use for assertions instead of screenshots).',
        { serial: z.string() },
        async ({ serial }) => textResult(await deviceUiDump(serial))),

      tool('screenshot', 'Capture a screenshot of the test device and deliver it to the phone for the human to see.',
        { serial: z.string() },
        async ({ serial }) => {
          const r = await deviceScreenshotRaw(serial, opts.artifactDir);
          if (r.ok && r.artifactPath && opts.onScreenshot) {
            const note = await opts.onScreenshot(r.artifactPath, serial).catch((e) => `delivery failed: ${String(e)}`);
            return { content: [{ type: 'text' as const, text: `Screenshot captured. ${note}` }] };
          }
          return textResult(r);
        }),

      tool('tap', 'Tap the screen at pixel coordinates (x, y).',
        { serial: z.string(), x: z.number(), y: z.number() },
        async ({ serial, x, y }) => textResult(await deviceTap(serial, x, y))),

      tool('type_text', 'Type text into the focused field.',
        { serial: z.string(), text: z.string() },
        async ({ serial, text }) => textResult(await deviceText(serial, text))),

      tool('key', 'Send a key event (e.g. KEYCODE_BACK, KEYCODE_ENTER, KEYCODE_HOME).',
        { serial: z.string(), keycode: z.string() },
        async ({ serial, keycode }) => textResult(await deviceKey(serial, keycode))),
    ],
  });
}
