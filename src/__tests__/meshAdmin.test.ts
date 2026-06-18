import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process.execFile (callback form). Each test installs a handler that maps argv → result.
type ExecHandler = (args: string[]) => { err: Error | null; stdout: string; stderr?: string };
let execHandler: ExecHandler;
const execCalls: string[][] = [];

vi.mock('child_process', () => ({
  execFile: (
    _cmd: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    execCalls.push(args);
    const r = execHandler(args);
    cb(r.err, r.stdout, r.stderr ?? '');
  },
}));

import * as meshAdmin from '../meshAdmin';

const INVITE_JSON = JSON.stringify({
  v: 3,
  networkId: 'a237c978',
  inviteSecret: 'secret',
  inviterNpub: 'npub1abc',
  admins: ['npub1abc'],
});
const INVITE_CODE = `nvpn://invite/${Buffer.from(INVITE_JSON, 'utf8').toString('base64url')}`;

const PHONE_HEX = 'c1cf657c71ce41b45f2c4f323f688cd9f01b8c2ddc2b3a05bfab4007c40a6bdc';
const PHONE_NPUB = 'npub1c88k2lr3eeqmghevfuer76yvm8cphrpdms4n5pdl4dqq03q2d0wqes26sx';

beforeEach(() => {
  execCalls.length = 0;
  execHandler = () => ({ err: new Error('unexpected'), stdout: '' });
});

describe('meshAdmin.createInvite', () => {
  it('returns the invite code and network id parsed from the invite payload (no extra exec)', async () => {
    execHandler = (args) => {
      if (args[0] === 'create-invite') return { err: null, stdout: INVITE_CODE };
      return { err: new Error('no'), stdout: '' };
    };
    const res = await meshAdmin.createInvite();
    expect(res).toEqual({ invite: INVITE_CODE, networkId: 'a237c978' });
    // networkId came from decoding the invite — should NOT have called `status`.
    expect(execCalls.some((a) => a[0] === 'status')).toBe(false);
  });

  it('returns null when nvpn is unavailable / create-invite fails', async () => {
    execHandler = () => ({ err: new Error('command not found'), stdout: '' });
    expect(await meshAdmin.createInvite()).toBeNull();
  });
});

describe('meshAdmin.addParticipant', () => {
  it('passes the hex pubkey straight through (no npub encode) and succeeds on ok', async () => {
    execHandler = (args) => {
      expect(args).toEqual(['add-participant', '--participant', PHONE_HEX]);
      return { err: null, stdout: 'changed=' + PHONE_HEX };
    };
    expect(await meshAdmin.addParticipant(PHONE_HEX)).toBe(true);
  });

  it('rejects a malformed pubkey before exec (no shell injection surface)', async () => {
    expect(await meshAdmin.addParticipant('--publish; rm -rf /')).toBe(false);
    expect(execCalls.length).toBe(0);
  });

  it('returns false when the nvpn call fails', async () => {
    execHandler = () => ({ err: new Error('no active network'), stdout: '' });
    expect(await meshAdmin.addParticipant(PHONE_NPUB)).toBe(false);
  });
});

describe('meshAdmin.derivePeerIp', () => {
  it('parses the JSON array form and strips the /32 suffix', async () => {
    execHandler = (args) => {
      expect(args).toEqual(['ip', '--participant', PHONE_HEX, '--peer', '--json']);
      return { err: null, stdout: '["10.44.204.101/32"]' };
    };
    expect(await meshAdmin.derivePeerIp(PHONE_HEX)).toBe('10.44.204.101');
  });

  it('rejects an IP outside the mesh CIDR', async () => {
    execHandler = () => ({ err: null, stdout: '["192.168.1.5/32"]' });
    expect(await meshAdmin.derivePeerIp(PHONE_HEX)).toBeNull();
  });

  it('returns null on invalid pubkey without calling nvpn', async () => {
    expect(await meshAdmin.derivePeerIp('not-a-key')).toBeNull();
    expect(execCalls.length).toBe(0);
  });
});

describe('meshAdmin.daemonRunning', () => {
  it('is true when status reports daemon.running', async () => {
    execHandler = () => ({ err: null, stdout: JSON.stringify({ daemon: { running: true } }) });
    expect(await meshAdmin.daemonRunning()).toBe(true);
  });

  it('is false when the daemon is down', async () => {
    execHandler = () => ({ err: null, stdout: JSON.stringify({ daemon: { running: false } }) });
    expect(await meshAdmin.daemonRunning()).toBe(false);
  });

  it('is false when nvpn is unavailable', async () => {
    execHandler = () => ({ err: new Error('not found'), stdout: '' });
    expect(await meshAdmin.daemonRunning()).toBe(false);
  });
});
