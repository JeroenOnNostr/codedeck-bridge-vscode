/**
 * GSD state — reads a session's GSD workflow position so the phone can render a stage strip.
 *
 * GSD (github.com/open-gsd/gsd-core) keeps its state under `<project>/.planning/`, but we do
 * NOT parse that markdown: GSD ships a machine-readable CLI and that is the supported contract.
 * Three queries, deliberately staged because they fail differently:
 *
 *   1. `smart-entry --json`  — THE GATE. Never throws; returns clean JSON even off a GSD
 *                              project. Yields the situation, the signals, and the workflow-level
 *                              action list. `signals.has_planning === false` → not a GSD project.
 *   2. `query init.manager`  — THE STAGE MATRIX. Richest per-phase data (disk_status +
 *                              per-phase `recommended_actions`), but THROWS unless both
 *                              ROADMAP.md and STATE.md exist. Always guarded + try/caught.
 *   3. `progress`            — percentage/milestone, and the fallback phase list when (2) is
 *                              unavailable. Never throws.
 *
 * Everything is best-effort: a missing gsd-tools, a non-GSD directory, a timeout, or malformed
 * JSON all degrade to `{ available: false }`, which the phone renders as nothing at all. A
 * broken GSD install must never break a normal Codedeck session.
 *
 * Two gotchas encoded here, both verified against a live 1.8.0 install:
 *   - gsd-tools writes warnings (e.g. "unknown config key(s)") to STDERR. We parse stdout only;
 *     merging the streams would make JSON.parse throw on every call.
 *   - `smart-entry` emits NAMESPACED commands (`/gsd:plan-phase`) while this machine installs
 *     GSD's commands as flat files (`~/.claude/commands/gsd-plan-phase.md` → `/gsd-plan-phase`).
 *     `init.manager.recommended_actions[].command` is already in the flat form. See
 *     normalizeCommand().
 */

import { execFile } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import type { GsdAction, GsdPhase, GsdState } from './types';

/** Cap any single gsd-tools call. These are local file walks — fast unless something is wrong. */
const GSD_TIMEOUT_MS = 5_000;
const GSD_MAX_BUFFER = 4 * 1024 * 1024;

/** Collapse request bursts (session open + turn end can land together) onto one exec batch. */
const CACHE_TTL_MS = 2_000;

/** A runaway roadmap must not bloat a single relay event. */
const MAX_PHASES = 40;

const UNAVAILABLE: GsdState = {
  available: false,
  situation: 'unknown',
  summary: '',
  milestone: null,
  currentPhase: null,
  totalPhases: null,
  percent: 0,
  phases: [],
  actions: [],
  recommended: null,
};

/**
 * Locate `gsd-tools.cjs`. GSD 1.8.0 is laid down by an ephemeral `npx`, so there is NO
 * `gsd-tools` binary on PATH and no global npm package — the .cjs must be invoked with node.
 * Resolved once and cached; `null` means GSD isn't installed and every call short-circuits.
 */
function resolveGsdTools(): string | null {
  if (process.env.CODEDECK_GSD_TOOLS_PATH) {
    return fs.existsSync(process.env.CODEDECK_GSD_TOOLS_PATH) ? process.env.CODEDECK_GSD_TOOLS_PATH : null;
  }
  const home = os.homedir();
  const candidates = [
    path.join(home, '.claude', 'gsd-core', 'bin', 'gsd-tools.cjs'),
    path.join(home, '.config', 'opencode', 'gsd-core', 'bin', 'gsd-tools.cjs'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

let gsdToolsPath: string | null | undefined;
function gsdTools(): string | null {
  if (gsdToolsPath === undefined) gsdToolsPath = resolveGsdTools();
  return gsdToolsPath;
}

/**
 * Does this machine install GSD's slash commands namespaced (`~/.claude/commands/gsd/plan-phase.md`
 * → `/gsd:plan-phase`) or flat (`~/.claude/commands/gsd-plan-phase.md` → `/gsd-plan-phase`)?
 * smart-entry always emits the namespaced form, so on a flat install every tapped command would
 * be an unknown-command no-op unless we rewrite it.
 */
function usesNamespacedCommands(): boolean {
  try {
    return fs.statSync(path.join(os.homedir(), '.claude', 'commands', 'gsd')).isDirectory();
  } catch {
    return false;
  }
}

let namespaced: boolean | undefined;

/** `/gsd:plan-phase` → `/gsd-plan-phase` on a flat install; left alone on a namespaced one. */
export function normalizeCommand(command: string, forceNamespaced?: boolean): string {
  const ns = forceNamespaced ?? (namespaced ??= usesNamespacedCommands());
  if (ns) return command;
  return command.replace(/^\/gsd:/, '/gsd-');
}

interface RunResult { ok: boolean; stdout: string; }

/** Run gsd-tools and return STDOUT only — warnings go to stderr and would break JSON.parse. */
function runGsd(tools: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [tools, ...args, '--cwd', cwd],
      { timeout: GSD_TIMEOUT_MS, maxBuffer: GSD_MAX_BUFFER, encoding: 'utf8' },
      (err, stdout) => resolve({ ok: !err, stdout: String(stdout ?? '').trim() }),
    );
  });
}

async function queryJson<T>(tools: string, args: string[], cwd: string): Promise<T | null> {
  const r = await runGsd(tools, args, cwd);
  if (!r.ok || !r.stdout) return null;
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    return null;   // human-readable output or a partial write — treat as unavailable
  }
}

// --- Raw shapes returned by gsd-tools (only the fields we consume) ---

interface SmartEntryOut {
  situation?: string;
  recommended?: string;
  summary?: string;
  signals?: {
    current_phase?: string | null;
    total_phases?: number | null;
    has_planning?: boolean;
    has_roadmap?: boolean;
  };
  actions?: Array<{ id?: string; label?: string; command?: string; recommended?: boolean }>;
}

interface ManagerOut {
  phases?: Array<{
    number?: string;
    name?: string;
    display_name?: string;
    disk_status?: string;
    plan_count?: number;
    summary_count?: number;
    is_active?: boolean;
  }>;
  recommended_actions?: Array<{ phase?: string; action?: string; command?: string }>;
  phase_count?: number;
}

interface ProgressOut {
  milestone_version?: string;
  milestone_name?: string;
  percent?: number;
  phases?: Array<{ number?: string; name?: string; status?: string; plans?: number; summaries?: number }>;
}

/**
 * `progress`'s human-facing status labels → the same `disk_status` vocabulary `init.manager`
 * uses, so the phone only ever renders one set of stage states regardless of which query
 * supplied the rows.
 */
const PROGRESS_STATUS_TO_DISK: Record<string, string> = {
  'Complete': 'complete',
  'Needs Review': 'executed',
  'Executed': 'executed',
  'In Progress': 'partial',
  'Planned': 'planned',
  'Pending': 'empty',
};

function milestoneLabel(p: ProgressOut | null): string | null {
  if (!p) return null;
  const version = p.milestone_version || '';
  const name = p.milestone_name && p.milestone_name !== 'milestone' ? p.milestone_name : '';
  const label = [version, name].filter(Boolean).join(' — ');
  return label || null;
}

interface CacheEntry { at: number; value: GsdState }
const cache = new Map<string, CacheEntry>();

/** Test seam — drop memoized state so a fixture change is picked up immediately. */
export function clearGsdCache(): void {
  cache.clear();
  gsdToolsPath = undefined;
  namespaced = undefined;
}

/**
 * Resolve the GSD stage snapshot for a session's working directory.
 * `available: false` means "render nothing" — not a GSD project, or GSD isn't installed.
 * `--cwd` makes gsd-tools walk up for the project root, so a subdirectory cwd works fine.
 */
export async function getGsdState(cwd: string): Promise<GsdState> {
  if (!cwd) return UNAVAILABLE;

  const cached = cache.get(cwd);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const value = await computeGsdState(cwd);
  cache.set(cwd, { at: Date.now(), value });
  return value;
}

async function computeGsdState(cwd: string): Promise<GsdState> {
  const tools = gsdTools();
  if (!tools) return UNAVAILABLE;

  // 1. The gate. Never throws, so a null here means something is genuinely wrong.
  const entry = await queryJson<SmartEntryOut>(tools, ['smart-entry', '--json'], cwd);
  if (!entry || entry.signals?.has_planning !== true) return UNAVAILABLE;

  // 2 + 3. init.manager is guarded on has_roadmap AND still try/caught via queryJson's null,
  // because it also throws when STATE.md is missing — a real state for a half-initialized project.
  const [manager, progress] = await Promise.all([
    entry.signals?.has_roadmap === true
      ? queryJson<ManagerOut>(tools, ['query', 'init.manager'], cwd)
      : Promise.resolve(null),
    queryJson<ProgressOut>(tools, ['progress'], cwd),
  ]);

  const phases = manager?.phases?.length
    ? phasesFromManager(manager)
    : phasesFromProgress(progress);

  const actions: GsdAction[] = (entry.actions ?? [])
    .filter(a => typeof a.command === 'string' && typeof a.id === 'string')
    .map(a => ({
      id: a.id as string,
      label: a.label || (a.id as string),
      command: normalizeCommand(a.command as string),
      recommended: a.recommended === true,
    }));

  return {
    available: true,
    situation: entry.situation || 'unknown',
    summary: entry.summary || '',
    milestone: milestoneLabel(progress),
    currentPhase: entry.signals?.current_phase ?? null,
    // `|| null` on the last fallback: a phase-less project should read "unknown", not "0 phases".
    totalPhases: entry.signals?.total_phases ?? manager?.phase_count ?? (phases.length || null),
    percent: typeof progress?.percent === 'number' ? progress.percent : 0,
    phases,
    actions,
    recommended: entry.recommended ?? null,
  };
}

function phasesFromManager(manager: ManagerOut): GsdPhase[] {
  // recommended_actions is per-phase and its `command` is already in the flat `/gsd-...` form.
  const byPhase = new Map<string, { action?: string; command?: string }>();
  for (const a of manager.recommended_actions ?? []) {
    if (a.phase) byPhase.set(String(a.phase), a);
  }
  return (manager.phases ?? []).slice(0, MAX_PHASES).map((p) => {
    const number = String(p.number ?? '');
    const rec = byPhase.get(number);
    return {
      number,
      name: p.display_name || p.name || '',
      diskStatus: p.disk_status || 'empty',
      plans: p.plan_count ?? 0,
      summaries: p.summary_count ?? 0,
      recentlyTouched: p.is_active === true,
      action: rec?.action ?? null,
      command: rec?.command ?? null,
    };
  });
}

function phasesFromProgress(progress: ProgressOut | null): GsdPhase[] {
  return (progress?.phases ?? []).slice(0, MAX_PHASES).map((p) => ({
    number: String(p.number ?? ''),
    name: p.name || '',
    diskStatus: PROGRESS_STATUS_TO_DISK[p.status || ''] || 'empty',
    plans: p.plans ?? 0,
    summaries: p.summaries ?? 0,
    recentlyTouched: false,
    action: null,
    command: null,
  }));
}
