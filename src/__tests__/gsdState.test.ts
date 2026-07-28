import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { getGsdState, normalizeCommand, clearGsdCache } from '../gsdState';

/**
 * The value of gsdState.ts IS the gsd-tools CLI contract, so the phase/action assertions run the
 * real binary against a committed `.planning/` fixture rather than mocking exec — a mock would
 * only ever re-assert our own assumptions. They skip when GSD isn't installed (CI, fresh clone).
 */
const GSD_TOOLS = path.join(os.homedir(), '.claude', 'gsd-core', 'bin', 'gsd-tools.cjs');
const HAS_GSD = fs.existsSync(GSD_TOOLS);
const FIXTURE = path.join(__dirname, 'fixtures', 'gsd-project');

beforeEach(() => {
  delete process.env.CODEDECK_GSD_TOOLS_PATH;
  clearGsdCache();
});
afterEach(() => {
  delete process.env.CODEDECK_GSD_TOOLS_PATH;
  clearGsdCache();
});

describe('normalizeCommand', () => {
  it('rewrites the namespaced form to the flat form on a flat install', () => {
    expect(normalizeCommand('/gsd:plan-phase', false)).toBe('/gsd-plan-phase');
    expect(normalizeCommand('/gsd:new-project', false)).toBe('/gsd-new-project');
  });

  it('leaves commands alone on a namespaced install', () => {
    expect(normalizeCommand('/gsd:plan-phase', true)).toBe('/gsd:plan-phase');
  });

  it('only rewrites the leading /gsd: prefix', () => {
    // An argument that happens to contain the token must survive untouched.
    expect(normalizeCommand('/gsd:phase add /gsd:thing', false)).toBe('/gsd-phase add /gsd:thing');
    expect(normalizeCommand('/other:cmd', false)).toBe('/other:cmd');
  });
});

describe('getGsdState — degradation', () => {
  it('reports unavailable for an empty cwd', async () => {
    const s = await getGsdState('');
    expect(s.available).toBe(false);
  });

  it('reports unavailable when gsd-tools is not installed', async () => {
    process.env.CODEDECK_GSD_TOOLS_PATH = path.join(os.tmpdir(), 'definitely-not-gsd-tools.cjs');
    clearGsdCache();
    const s = await getGsdState(FIXTURE);
    expect(s.available).toBe(false);
    expect(s.phases).toEqual([]);
  });

  it.skipIf(!HAS_GSD)('reports unavailable for a directory with no .planning/', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedeck-nogsd-'));
    try {
      const s = await getGsdState(dir);
      expect(s.available).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!HAS_GSD)('getGsdState — against the real gsd-tools + fixture', () => {
  it('resolves the fixture project', async () => {
    const s = await getGsdState(FIXTURE);
    expect(s.available).toBe(true);
    // Fixture: 2 plans, 1 summary → 50%.
    expect(s.percent).toBe(50);
    expect(s.phases).toHaveLength(3);
  });

  it('maps phase disk status onto the stage vocabulary', async () => {
    const s = await getGsdState(FIXTURE);
    const byNumber = Object.fromEntries(s.phases.map(p => [p.number, p]));
    expect(byNumber['1'].diskStatus).toBe('complete');
    expect(byNumber['1'].summaries).toBe(1);
    expect(byNumber['2'].diskStatus).toBe('planned');
    expect(byNumber['2'].summaries).toBe(0);
  });

  it('carries a ready-to-send, flat-form command for the actionable phase', async () => {
    const s = await getGsdState(FIXTURE);
    const phase2 = s.phases.find(p => p.number === '2');
    expect(phase2?.action).toBe('execute');
    // init.manager already emits the flat form — it must reach the phone unmangled.
    expect(phase2?.command).toBe('/gsd-execute-phase 2');
  });

  it('normalizes the workflow-level action commands', async () => {
    const s = await getGsdState(FIXTURE);
    expect(s.actions.length).toBeGreaterThan(0);
    // Whatever GSD recommends, nothing may reach the phone in the namespaced form on a flat install.
    for (const a of s.actions) {
      expect(a.command.startsWith('/gsd:')).toBe(false);
      expect(a.command.startsWith('/gsd-')).toBe(true);
    }
    expect(s.actions.some(a => a.recommended)).toBe(true);
    expect(s.recommended).toBeTruthy();
  });

  it('caps the phase list so one snapshot cannot bloat a relay event', async () => {
    const s = await getGsdState(FIXTURE);
    expect(s.phases.length).toBeLessThanOrEqual(40);
  });

  it('serializes small enough to ride a single Nostr event', async () => {
    const s = await getGsdState(FIXTURE);
    const wire = JSON.stringify({ type: 'gsd-state', sessionId: 'x'.repeat(36), gsd: s });
    // The live output path has no size check and oversized events are silently dropped by relays
    // (publishOutput only logs the rejection), so the snapshot must stay comfortably small.
    // 48KB is the bridge's own history-chunk ceiling; a 3-phase project should be ~1KB.
    expect(Buffer.byteLength(wire, 'utf8')).toBeLessThan(8_000);
  });

  it('memoizes within the TTL so a burst of requests runs one exec batch', async () => {
    const a = await getGsdState(FIXTURE);
    const b = await getGsdState(FIXTURE);
    expect(b).toBe(a);   // same object reference → served from cache
  });
});
