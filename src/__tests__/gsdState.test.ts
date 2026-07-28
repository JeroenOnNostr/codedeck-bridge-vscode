import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';

import { getGsdState, normalizeCommand, clearGsdCache, resolvePhaseTotals } from '../gsdState';

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
    expect(s.installed).toBe(false);
  });

  it('reports NOT installed when gsd-tools is missing — distinct from "not set up yet"', async () => {
    // The phone uses this distinction to decide whether a Start button can do anything.
    process.env.CODEDECK_GSD_TOOLS_PATH = path.join(os.tmpdir(), 'definitely-not-gsd-tools.cjs');
    clearGsdCache();
    const s = await getGsdState(FIXTURE);
    expect(s.installed).toBe(false);
    expect(s.available).toBe(false);
    expect(s.actions).toEqual([]);
    expect(s.phases).toEqual([]);
  });

  it.skipIf(!HAS_GSD)('reports installed-but-unavailable for a directory with no .planning/', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedeck-nogsd-'));
    try {
      const s = await getGsdState(dir);
      expect(s.available).toBe(false);
      expect(s.installed).toBe(true);          // ← what makes a Start button meaningful
      expect(s.situation).toBe('no-project');
      // GSD's bootstrap actions must survive the gate, or there is nothing to start.
      const ids = s.actions.map(a => a.id);
      expect(ids).toContain('new-project');
      expect(ids).toContain('map-codebase');
      for (const a of s.actions) expect(a.command.startsWith('/gsd-')).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!HAS_GSD)('getGsdState — against the real gsd-tools + fixture', () => {
  it('resolves the fixture project', async () => {
    const s = await getGsdState(FIXTURE);
    expect(s.available).toBe(true);
    // Fixture: 3 plans (01-01, 02-01, 02-02), 1 summary → 33%.
    expect(s.percent).toBe(33);
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

  it('reports pre-flight cost for the phase it wants executed', async () => {
    const s = await getGsdState(FIXTURE);
    const phase2 = s.phases.find(p => p.number === '2');
    // Fixture phase 2 has two plans, one with `autonomous: false`.
    expect(phase2?.planCount).toBe(2);
    expect(phase2?.needsYou).toBe(1);
  });

  it('leaves pre-flight null for phases with nothing to execute', async () => {
    const s = await getGsdState(FIXTURE);
    // Phase 1 is complete — spending an exec on it would tell the user nothing.
    expect(s.phases.find(p => p.number === '1')?.needsYou).toBeNull();
  });

  it('carries the recovery signals', async () => {
    const s = await getGsdState(FIXTURE);
    expect(s.paused).toBe(false);
    expect(s.verifyFailed).toBe(false);
    expect(Array.isArray(s.blockers)).toBe(true);
  });
});

describe.skipIf(!HAS_GSD)('getGsdState — live execution from task commits', () => {
  let repo: string;

  beforeAll(() => {
    repo = execFileSync(path.join(__dirname, 'fixtures', 'make-git-fixture.sh'), { encoding: 'utf8' }).trim();
  });
  afterAll(() => { if (repo) fs.rmSync(repo, { recursive: true, force: true }); });

  it('reconstructs plan and task progress that phase status alone cannot show', async () => {
    clearGsdCache();
    const s = await getGsdState(repo);
    const ex = s.execution;
    expect(ex).not.toBeNull();
    expect(ex!.phase).toBe('2');
    expect(ex!.plansTotal).toBe(2);
    expect(ex!.plansDone).toBe(0);
    expect(ex!.currentPlan).toBe('02-01');
    // Two `*(02-01):` commits in the fixture; the third commit is unrelated and must not count.
    expect(ex!.tasksDone).toBe(2);
    expect(ex!.tasksTotal).toBe(3);           // <task> tags declared by 02-01-PLAN.md
    expect(ex!.lastTask).toBe('cover the build step');
  });

  it('ignores commits that are not GSD task commits', async () => {
    clearGsdCache();
    const s = await getGsdState(repo);
    expect(s.execution!.lastTask).not.toContain('unrelated');
  });

  it('reports task 0/N while executing with nothing committed yet', async () => {
    // The committed fixture's STATE.md says `status: executing` and it has no git history — that
    // is a real state (phase started, first task not yet committed) and 0/3 is the honest readout.
    clearGsdCache();
    const s = await getGsdState(FIXTURE);
    expect(s.execution?.tasksDone).toBe(0);
    expect(s.execution?.lastTask).toBeNull();
  });

  it('returns no execution block when the phase is not being executed', async () => {
    // Inventing "task 0/N" for a phase that has not started is worse than saying nothing.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codedeck-gsd-idle-'));
    try {
      fs.cpSync(path.join(FIXTURE, '.planning'), path.join(dir, '.planning'), { recursive: true });
      const statePath = path.join(dir, '.planning', 'STATE.md');
      fs.writeFileSync(statePath, fs.readFileSync(statePath, 'utf8').replace('status: executing', 'status: planning'));
      clearGsdCache();
      expect((await getGsdState(dir)).execution).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * CD-054 — the strip claimed a 5-phase project was finished.
 *
 * `smart-entry` reports two different phase counts and the obvious one is wrong: `total_phases`
 * counts `.planning/phases/` directories, which only exist for phases that have been PLANNED.
 * Finish phase 1 of 5 and it says 1, while `progress` says 100% because every plan it can see is
 * done. The correct count rides alongside as `roadmap_total_phases`.
 */
describe('resolvePhaseTotals — CD-054', () => {
  it('prefers the roadmap count over the on-disk directory count', () => {
    // The exact shape observed in gsd-testbed after executing phase 1 of a 5-phase roadmap.
    const r = resolvePhaseTotals({ roadmapTotal: 5, diskTotal: 1, rawPercent: 100 });
    expect(r.totalPhases).toBe(5);
  });

  it('scales the percentage to the whole roadmap, not just the planned phases', () => {
    // The headline bug: this used to be 100 — "done" — one fifth of the way through.
    expect(resolvePhaseTotals({ roadmapTotal: 5, diskTotal: 1, rawPercent: 100 }).percent).toBe(20);
    expect(resolvePhaseTotals({ roadmapTotal: 4, diskTotal: 2, rawPercent: 50 }).percent).toBe(25);
    expect(resolvePhaseTotals({ roadmapTotal: 3, diskTotal: 1, rawPercent: 100 }).percent).toBe(33);
  });

  it('leaves the percentage alone once every phase has been planned', () => {
    // diskTotal === roadmapTotal: GSD can see the whole roadmap, so its own number is already right
    // and 100% genuinely means finished.
    expect(resolvePhaseTotals({ roadmapTotal: 5, diskTotal: 5, rawPercent: 100 }).percent).toBe(100);
    expect(resolvePhaseTotals({ roadmapTotal: 5, diskTotal: 5, rawPercent: 40 }).percent).toBe(40);
  });

  it('never scales up when more phases exist on disk than the roadmap lists', () => {
    // An inserted decimal phase (2.1) can put more dirs on disk than the roadmap enumerates.
    // Guard against inflating a percentage past its real value.
    const r = resolvePhaseTotals({ roadmapTotal: 3, diskTotal: 5, rawPercent: 60 });
    expect(r.percent).toBe(60);
    expect(r.totalPhases).toBe(3);
  });

  it('falls back to the disk count before a roadmap exists', () => {
    // roadmap_total_phases is null until ROADMAP.md is written — must not blank the readout.
    const r = resolvePhaseTotals({ roadmapTotal: null, diskTotal: 2, rawPercent: 50 });
    expect(r.totalPhases).toBe(2);
    expect(r.percent).toBe(50);
  });

  it('reports an unknown total rather than "0 phases" when neither count is available', () => {
    expect(resolvePhaseTotals({ roadmapTotal: null, diskTotal: null, rawPercent: 0 }).totalPhases).toBeNull();
  });
});
