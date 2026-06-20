/**
 * SDK Session Manager — replaces TerminalBridge + SessionWatcher.
 *
 * Each phone-created session spawns a Claude Code subprocess via the Agent SDK's
 * query() function. Communication is structured JSON over stdin/stdout — no
 * terminal emulation, no JSONL file watching, no keystroke simulation.
 *
 * Permissions are handled via the SDK's canUseTool callback, which blocks
 * execution until the bridge responds (either auto-approve or phone response).
 */

import { query, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createDeviceMcpServer } from './deviceActions';
import type {
  Query,
  SDKMessage,
  SDKUserMessage,
  SDKSystemMessage,
  SDKSessionStateChangedMessage,
  SDKControlGetUsageResponse,
  PermissionResult,
  PermissionUpdate,
  PermissionMode,
  CanUseTool,
  Options,
} from '@anthropic-ai/claude-agent-sdk';
import type { EffortLevel, OutputEntry, RemoteSessionInfo, UsageData, UsageWindow } from './types';
import { sdkMessageToEntries } from './sdkAdapter';

const execFileAsync = promisify(execFile);

/**
 * Read the current git HEAD commit hash for a working directory.
 * Returns null if the dir is not a git repo or git is unavailable.
 */
async function gitHeadHash(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd,
      timeout: 5000,
      windowsHide: true,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Fallback model used by every session's query() Options. If the primary model is
 * overloaded or unavailable, the SDK degrades to this rather than failing the turn.
 */
const FALLBACK_MODEL = 'claude-sonnet-4-6';

/**
 * Secret-bearing paths a device-test session must never read (signing keystores + their cleartext
 * password files + env files). Matched case-insensitively anywhere in a tool's string arguments.
 * This is the enforced half of the SKILL.md "dev builds only, never touch release keystores" rule.
 */
const SECRET_PATH_RE = /(\.keystore|\.jks|\.p12|\.pfx|key\.properties|keystore\.properties|(?<![A-Za-z0-9])\.env)(?![A-Za-z0-9])/i;

/** Tools whose arguments can name a filesystem path / shell command we should screen. */
const PATH_BEARING_TOOLS = new Set(['Read', 'Bash', 'Grep', 'Glob', 'Edit', 'Write', 'NotebookEdit']);

/** True if a (test-session) tool call references a secret-bearing path in any of its string args. */
export function touchesSecretPath(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (!PATH_BEARING_TOOLS.has(toolName)) return false;
  const haystack = JSON.stringify(toolInput ?? {});
  return SECRET_PATH_RE.test(haystack);
}

/**
 * Map a phone effort level to the SDK's Options.effort value (used at query() construction).
 * Unlike the mid-session applyFlagSettings path, Options.effort accepts the full set incl. 'max',
 * so a session can be *born* at true 'max'/'xhigh'. 'auto' / undefined → omit (model default).
 */
function toOptionsEffort(effort?: EffortLevel): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
  switch (effort) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return effort;
    default:
      return undefined; // 'auto' or unset → model default
  }
}

/**
 * Project the SDK's structured `/usage` response into the lean `UsageData` we send over the wire.
 * Tolerant of null/absent windows — the experimental SDK shape may omit any of them. A window is
 * only included when the SDK reports it; null inner values are preserved so the phone can decide
 * whether to render the row.
 */
export function normalizeUsage(res: SDKControlGetUsageResponse): UsageData {
  const win = (w: { utilization: number | null; resets_at: string | null } | null | undefined): UsageWindow | undefined =>
    w ? { utilization: w.utilization, resetsAt: w.resets_at } : undefined;

  const rl = res.rate_limits;
  return {
    available: res.rate_limits_available,
    subscriptionType: res.subscription_type ?? null,
    fiveHour: win(rl?.five_hour),
    sevenDay: win(rl?.seven_day),
    sevenDayOpus: win(rl?.seven_day_opus),
    sevenDaySonnet: win(rl?.seven_day_sonnet),
    sessionCostUsd: typeof res.session?.total_cost_usd === 'number' ? res.session.total_cost_usd : undefined,
    fetchedAt: new Date().toISOString(),
  };
}

// --- Async input generator ---

/** Creates a controllable async generator that yields SDKUserMessage objects.
 *  Call push() to queue a message, and the generator will yield it. */
function createInputChannel(): {
  generator: AsyncGenerator<SDKUserMessage, void>;
  push: (msg: SDKUserMessage) => void;
  close: () => void;
} {
  const queue: SDKUserMessage[] = [];
  let resolve: (() => void) | null = null;
  let closed = false;

  const generator = (async function* () {
    while (!closed) {
      if (queue.length > 0) {
        yield queue.shift()!;
      } else {
        await new Promise<void>(r => { resolve = r; });
        resolve = null;
      }
    }
  })();

  return {
    generator,
    push(msg: SDKUserMessage) {
      queue.push(msg);
      resolve?.();
    },
    close() {
      closed = true;
      resolve?.();
    },
  };
}

// --- Permission request forwarding ---

export interface PermissionRequest {
  sessionId: string;
  toolName: string;
  toolUseId: string;
  toolInput: Record<string, unknown>;
  title?: string;
  description?: string;
  resolve: (result: PermissionResult) => void;
}

export interface SdkSessionEvents {
  /** Called when new output entries are available for a session. */
  onOutput: (sessionId: string, entries: Array<{ seq: number; entry: OutputEntry }>) => void;
  /** Called when a permission request needs phone approval (not auto-approved). */
  onPermissionRequest: (request: PermissionRequest) => void;
  /** Called when an AskUserQuestion tool is invoked — forward to phone. */
  onAskQuestion: (sessionId: string, toolUseId: string, questions: unknown[]) => void;
  /** Called when the session list changes (session started, ended, etc.). */
  onSessionListChanged: (sessions: RemoteSessionInfo[]) => void;
  /** Called when a session subprocess exits. */
  onSessionEnded: (sessionId: string) => void;
  /** Called when authentication fails. */
  onAuthError: (sessionId: string, error: string) => void;
  /** Called when a session is successfully authenticated (init message received). */
  onAuthSuccess: (sessionId: string, info: { model: string; apiKeySource: string; version: string }) => void;
  /** Called when the SDK autonomously changes permission mode (e.g., EnterPlanMode). */
  onAutoModeChange?: (sessionId: string, mode: PermissionMode) => void;
  /** Log function. */
  log: (msg: string) => void;
}

interface ManagedSession {
  query: Query;
  input: ReturnType<typeof createInputChannel>;
  abortController: AbortController;
  seqCounter: number;
  cwd: string;
  permissionMode: PermissionMode;
  /** True when this session has the on-device adb MCP tools (device-test session). Used to enforce
   *  the secret-path deny-list below, regardless of permission mode. */
  testSession?: boolean;
  /** Phone-level effort (e.g. 'high', 'max') — tracked so getSessions() can report it. */
  effortLevel?: EffortLevel;
  /** Selected Claude model ID (e.g. 'claude-opus-4-8') — tracked so getSessions() can report it and resume can re-apply it. */
  model?: string;
  /** Output entries history for catch-up. */
  history: Array<{ seq: number; entry: OutputEntry }>;
  /** Pending permission requests awaiting phone response, keyed by toolUseId. */
  pendingPermissions: Map<string, { toolName: string; resolve: (result: PermissionResult) => void }>;
  /** Answered AskUserQuestion toolUseIds — used to skip resolved questions when scanning history. */
  answeredQuestions: Set<string>;
  /** Pending AskUserQuestion calls awaiting user answers, keyed by toolUseId. */
  pendingQuestions: Map<string, {
    /** The full original tool input, echoed back (plus answers) in updatedInput. */
    input: Record<string, unknown>;
    /** The questions array from the tool input. */
    questions: Array<{ question: string; header?: string }>;
    /** Accumulated answers so far (question text → selected answer). */
    answers: Record<string, string>;
    /** Number of answers still needed before resolving. */
    remaining: number;
    /** Resolves the canUseTool promise with the collected answers. */
    resolve: (result: PermissionResult) => void;
  }>;
  /** Timestamp of last activity. */
  lastActivity: string;
  /** Title extracted from first user message. */
  title: string | null;
  /** Whether session-meta tag has been parsed. */
  summarized: boolean;
  /** Project name extracted from session-meta tag (overrides cwd-derived name). */
  projectOverride?: string;
  /** Whether a commit has been detected in this session — by the agent or made manually. */
  committed: boolean;
  /** git HEAD hash captured at session start; `committed` flips once HEAD advances past it. */
  baseHead?: string;
  /** Current session state: idle (waiting for user input) or running (Claude is working). */
  sessionState: 'idle' | 'running';
  /** Whether the session is still running. */
  alive: boolean;
  /** Number of times this session has been auto-restarted after crash. */
  restartCount: number;
}

export class SdkSessionManager {
  private static readonly MAX_RESTARTS = 2;
  private static readonly PERMISSION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
  private static readonly GIT_POLL_MS = 10_000; // How often to reconcile `committed` with git HEAD.

  private sessions = new Map<string, ManagedSession>();
  private events: SdkSessionEvents;
  /** Interval that reconciles each session's `committed` flag with real git state. */
  private gitPollTimer?: ReturnType<typeof setInterval>;

  /**
   * Optional hook: deliver a captured device screenshot to the phone (Phase 3 wires this to the
   * bridge→phone image path). Returns a short human-readable note for the tool result.
   * Set by BridgeCore after construction.
   */
  public onDeviceScreenshot?: (sessionId: string, artifactPath: string, serial: string) => Promise<string>;

  constructor(events: SdkSessionEvents) {
    this.events = events;
    // Periodically reconcile each session's `committed` flag with real git state, so the
    // badge appears whether the commit was made by the agent or manually in a terminal.
    this.gitPollTimer = setInterval(() => { void this.pollGitCommits(); }, SdkSessionManager.GIT_POLL_MS);
    this.gitPollTimer.unref?.();
  }

  /**
   * Create a new Claude Code session via the Agent SDK.
   * @param model   Optional Claude model ID (e.g. 'claude-opus-4-8'). Falls back to the SDK default if omitted.
   * @param effort  Optional initial effort level. Applied at query() construction so 'max'/'xhigh' take effect
   *                from the first turn (the mid-session applyFlagSettings path cannot reach 'max').
   */
  createSession(
    sessionId: string,
    cwd: string,
    initialPermissionMode: PermissionMode = 'plan',
    model?: string,
    effort?: EffortLevel,
    opts?: { testSession?: boolean },
  ): void {
    if (this.sessions.has(sessionId)) {
      this.events.log(`[SDK] Session ${sessionId} already exists`);
      return;
    }

    const input = createInputChannel();
    const abortController = new AbortController();

    const session: ManagedSession = {
      query: undefined as unknown as Query, // Set below
      input,
      abortController,
      seqCounter: 0,
      cwd,
      permissionMode: initialPermissionMode,
      testSession: !!opts?.testSession,
      effortLevel: effort,
      model,
      history: [],
      pendingPermissions: new Map(),
      answeredQuestions: new Set(),
      pendingQuestions: new Map(),
      lastActivity: new Date().toISOString(),
      title: null,
      summarized: false,
      committed: false,
      sessionState: 'idle',
      alive: true,
      restartCount: 0,
    };

    // Capture the starting git HEAD so commits made any way (agent Bash or manual terminal) are detected.
    void gitHeadHash(cwd).then((head) => { if (head) session.baseHead = head; });

    const canUseTool: CanUseTool = async (toolName, toolInput, options) => {
      return this.handlePermission(sessionId, session, toolName, toolInput, options);
    };

    const optionsEffort = toOptionsEffort(effort);

    // Test sessions get the on-device adb MCP tools (install/launch/logcat/screenshot/tap/...).
    // Normal coding sessions do NOT, keeping device control off the default surface.
    const mcpServers = opts?.testSession
      ? {
          device: createDeviceMcpServer({
            artifactDir: path.join(os.tmpdir(), 'codedeck-device-artifacts'),
            onScreenshot: this.onDeviceScreenshot
              ? (artifactPath, serial) => this.onDeviceScreenshot!(sessionId, artifactPath, serial)
              : undefined,
          }),
        }
      : undefined;

    const options: Options = {
      sessionId,
      cwd,
      permissionMode: initialPermissionMode,
      abortController,
      canUseTool,
      settingSources: ['user', 'project'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      tools: { type: 'preset', preset: 'claude_code' },
      fallbackModel: FALLBACK_MODEL,
      ...(model ? { model } : {}),
      ...(optionsEffort ? { effort: optionsEffort } : {}),
      ...(mcpServers ? { mcpServers } : {}),
    };
    this.events.log(`[SDK] Creating session ${sessionId} (model: ${model ?? 'default'}, effort: ${optionsEffort ?? 'default'})`);

    const q = query({ prompt: input.generator, options });
    session.query = q;
    this.sessions.set(sessionId, session);

    // Start consuming messages in background
    this.consumeMessages(sessionId, session, q);
    this.events.log(`[SDK] Session ${sessionId} created in ${cwd}`);
  }

  /** Send user text input to a session. Returns true if session exists. */
  sendInput(sessionId: string, text: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.alive) { return false; }

    session.lastActivity = new Date().toISOString();

    // Extract title from first user message and ask Claude for structured metadata
    if (!session.title) {
      const cleaned = text.replace(/\n/g, ' ').trim();
      if (cleaned && !cleaned.startsWith('[') && !cleaned.startsWith('Request interrupted')) {
        session.title = cleaned.length > 80 ? cleaned.slice(0, 77) + '...' : cleaned;
        // Ask Claude to emit a metadata tag in its first response
        text += '\n\n<!-- emit-session-meta: In your response, include exactly one HTML comment: <!-- session-meta: {"topic": "<2-4 word task summary>", "project": "<project name>"} --> -->';
      }
    }

    session.input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    });
    return true;
  }

  /** Interrupt the current turn of a session (equivalent to Ctrl+C). */
  interruptSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.alive) { return false; }

    this.events.log(`[SDK] Interrupting session ${sessionId}`);
    session.query.interrupt().catch(err => {
      this.events.log(`[SDK] Interrupt failed for ${sessionId}: ${err}`);
    });

    // Deny all pending permissions so the SDK isn't blocked
    for (const [toolUseId, pending] of session.pendingPermissions) {
      pending.resolve({ behavior: 'deny', message: 'Interrupted by user' });
    }
    session.pendingPermissions.clear();

    return true;
  }

  /**
   * Send a free-text answer to a pending AskUserQuestion.
   * Scans session history for the most recent unanswered ask_question entry,
   * finds its pending promise, and resolves it with the user's answer.
   * For multi-question calls, accumulates answers and resolves when all are collected.
   * Falls back to regular sendInput if no pending question found.
   */
  sendQuestionInput(sessionId: string, text: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.alive) { return false; }

    // Scan history backwards for the most recent unanswered ask_question
    for (let i = session.history.length - 1; i >= 0; i--) {
      const entry = session.history[i].entry;
      if (entry.metadata?.special !== 'ask_question') continue;

      const toolUseId = entry.metadata.tool_use_id as string | undefined;
      if (!toolUseId || session.answeredQuestions.has(toolUseId)) continue;

      const pending = session.pendingQuestions.get(toolUseId);
      if (!pending) continue;

      const qIdx = (entry.metadata.question_index as number | undefined) ?? 0;
      const questionText = pending.questions[qIdx]?.question ?? entry.content;
      session.lastActivity = new Date().toISOString();
      this.resolveQuestionAnswer(session, toolUseId, questionText, text);
      return true;
    }

    // No pending question found — fall back to regular input
    this.events.log(`[SDK] No pending question for question-input in ${sessionId} — falling back to sendInput`);
    return this.sendInput(sessionId, text);
  }

  /** Find a pending permission by tool name. Returns the toolUseId if found. */
  findPendingPermission(sessionId: string, toolName: string): string | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    for (const [toolUseId, pending] of session.pendingPermissions) {
      if (pending.toolName === toolName) return toolUseId;
    }
    return undefined;
  }

  /** Resolve a pending permission request from the phone. */
  resolvePermission(sessionId: string, toolUseId: string, allow: boolean, modifier?: 'always' | 'never'): void {
    const session = this.sessions.get(sessionId);
    if (!session) { return; }

    const pending = session.pendingPermissions.get(toolUseId);
    if (!pending) {
      this.events.log(`[SDK] No pending permission for ${toolUseId} in ${sessionId}`);
      return;
    }

    session.pendingPermissions.delete(toolUseId);

    if (allow) {
      const result: PermissionResult = { behavior: 'allow', updatedInput: {} };
      // "Always allow" → persist as a project-scoped allow rule so it survives across sessions.
      // Uses projectSettings (not session) because "Always Allow" implies persistence.
      if (modifier === 'always') {
        const rule: PermissionUpdate = {
          type: 'addRules',
          rules: [{ toolName: pending.toolName }],
          behavior: 'allow',
          destination: 'projectSettings',
        };
        result.updatedPermissions = [rule];
      }
      pending.resolve(result);
    } else {
      pending.resolve({ behavior: 'deny', message: modifier === 'never' ? 'User denied (never ask again)' : 'User denied' });
    }
  }

  /** Change the permission mode for a session. */
  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.alive) { return false; }

    try {
      await session.query.setPermissionMode(mode);
      session.permissionMode = mode;
      this.events.log(`[SDK] Permission mode set to ${mode} for ${sessionId}`);
      return true;
    } catch (err) {
      this.events.log(`[SDK] Failed to set permission mode for ${sessionId}: ${err}`);
      return false;
    }
  }

  /**
   * Change the effort level for a session.
   * Returns { applied, confirmedLevel } so the caller always has a level to confirm back to the phone.
   * - applied=true: SDK accepted the level
   * - applied=false: level unsupported or failed, confirmedLevel is the fallback
   */
  async setEffortLevel(sessionId: string, effort: string): Promise<{ applied: boolean; confirmedLevel: string }> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.alive) { return { applied: false, confirmedLevel: effort }; }

    // Map phone effort levels to SDK-compatible values for the MID-SESSION path.
    // SDK 0.3.x applyFlagSettings (Settings.effortLevel) accepts 'low' | 'medium' | 'high' | 'xhigh',
    // or undefined to reset to model default. Note it does NOT accept 'max' — true 'max' is only
    // reachable at query() construction via Options.effort (handled in createSession()).
    // So mid-session we map 'max' → 'xhigh' (the strongest the mid-session API allows) and 'auto' → reset.
    // The SDK itself silently downgrades 'xhigh' → 'high' on models that don't support it.
    let sdkEffort: 'low' | 'medium' | 'high' | 'xhigh' | undefined;
    let confirmedLevel = effort;
    switch (effort) {
      case 'low':
      case 'medium':
      case 'high':
      case 'xhigh':
        sdkEffort = effort;
        break;
      case 'max':
        sdkEffort = 'xhigh';
        confirmedLevel = 'xhigh';
        this.events.log(`[SDK] Mapping effort 'max' → 'xhigh' mid-session for ${sessionId} (true 'max' needs a fresh session)`);
        break;
      case 'auto':
        sdkEffort = undefined; // Reset to model default
        confirmedLevel = 'auto';
        this.events.log(`[SDK] Resetting effort to model default for ${sessionId}`);
        break;
      default:
        this.events.log(`[SDK] Unknown effort level '${effort}' for ${sessionId} — ignoring`);
        return { applied: false, confirmedLevel: effort };
    }

    try {
      await session.query.applyFlagSettings({ effortLevel: sdkEffort });
      session.effortLevel = confirmedLevel as EffortLevel;
      this.events.log(`[SDK] Effort level set to ${sdkEffort ?? 'model default'} for ${sessionId}`);
      // Confirm with the actually-applied level so the phone UI reflects reality.
      return { applied: true, confirmedLevel };
    } catch (err) {
      this.events.log(`[SDK] Failed to set effort level for ${sessionId}: ${err}`);
      return { applied: false, confirmedLevel: effort };
    }
  }

  /**
   * Change the Claude model for a session mid-session.
   * Returns { applied, confirmedModel } so the caller always has a value to confirm back to the phone.
   * Mirrors setEffortLevel's contract.
   */
  async setModel(sessionId: string, model: string): Promise<{ applied: boolean; confirmedModel: string }> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.alive) { return { applied: false, confirmedModel: model }; }

    try {
      await session.query.setModel(model);
      session.model = model;
      this.events.log(`[SDK] Model set to ${model} for ${sessionId}`);
      return { applied: true, confirmedModel: model };
    } catch (err) {
      this.events.log(`[SDK] Failed to set model for ${sessionId}: ${err}`);
      // Confirm the previously-known model so the phone UI doesn't show a model that didn't take.
      return { applied: false, confirmedModel: session.model ?? model };
    }
  }

  /**
   * Fetch the structured subscription usage / rate-limit snapshot for a session — the
   * same data the `/usage` command renders (5-hour, weekly, per-model windows + reset times).
   *
   * The underlying SDK method is EXPERIMENTAL (its verbose name signals it may change or be
   * removed), so we feature-detect it and swallow any failure: callers get null and publish
   * nothing rather than crashing. Returns null for dead/unknown sessions or unsupported SDKs.
   */
  async getUsage(sessionId: string): Promise<UsageData | null> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.alive) { return null; }

    // The method name is intentionally unstable; reach it dynamically + feature-detect.
    const q = session.query as unknown as {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<SDKControlGetUsageResponse>;
    };
    const fn = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof fn !== 'function') { return null; }

    try {
      const res = await fn.call(session.query);
      return normalizeUsage(res);
    } catch (err) {
      this.events.log(`[SDK] getUsage failed for ${sessionId}: ${err}`);
      return null;
    }
  }

  /** Close a session. */
  closeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) { return false; }

    session.alive = false;
    session.input.close();
    session.abortController.abort();

    // Reject any pending permissions
    for (const [, pending] of session.pendingPermissions) {
      pending.resolve({ behavior: 'deny', message: 'Session closed' });
    }
    session.pendingPermissions.clear();

    this.sessions.delete(sessionId);
    this.events.log(`[SDK] Session ${sessionId} closed`);
    return true;
  }

  /** Get the current session list. */
  getSessions(): RemoteSessionInfo[] {
    const sessions: RemoteSessionInfo[] = [];
    for (const [id, s] of this.sessions) {
      if (!s.alive) continue;
      sessions.push({
        id,
        slug: `session-${id.slice(0, 8)}`,
        cwd: s.cwd,
        lastActivity: s.lastActivity,
        lineCount: s.seqCounter,
        title: s.title,
        project: s.projectOverride || s.cwd.split('/').pop() || s.cwd,
        hasTerminal: true, // SDK sessions are always "alive"
        permissionMode: s.permissionMode as 'default' | 'acceptEdits' | 'plan',
        committed: s.committed || undefined,
        effortLevel: s.effortLevel,
        model: s.model,
        state: s.pendingPermissions.size > 0 ? 'waiting_permission'
          : s.pendingQuestions.size > 0 ? 'waiting_question'
          : s.sessionState,
      });
    }
    return sessions;
  }

  /** Get history entries for a session (in-memory). */
  getHistory(sessionId: string, afterSeq?: number): Array<{ seq: number; entry: OutputEntry }> {
    const session = this.sessions.get(sessionId);
    if (!session) { return []; }
    if (afterSeq === undefined || afterSeq === 0) {
      return session.history.slice();
    }
    return session.history.filter(e => e.seq > afterSeq);
  }

  /**
   * Get history from SDK's persistent JSONL storage.
   * Falls back to this when in-memory history is empty (e.g. after extension reload).
   */
  async getPersistedHistory(sessionId: string, cwd?: string): Promise<Array<{ seq: number; entry: OutputEntry }>> {
    try {
      const messages = await getSessionMessages(sessionId, {
        dir: cwd,
        includeSystemMessages: true,
      });

      const entries: Array<{ seq: number; entry: OutputEntry }> = [];
      let seq = 0;
      for (const msg of messages) {
        // Convert SessionMessage to OutputEntry via sdkAdapter
        const sdkMsg = { ...msg, session_id: sessionId } as SDKMessage;
        const converted = sdkMessageToEntries(sdkMsg);
        for (const entry of converted) {
          entries.push({ seq: ++seq, entry });
        }
      }
      return entries;
    } catch (err) {
      this.events.log(`[SDK] Failed to load persisted history for ${sessionId}: ${err}`);
      return [];
    }
  }

  getHistoryCount(sessionId: string): number {
    return this.sessions.get(sessionId)?.history.length ?? 0;
  }

  getPermissionMode(sessionId: string): PermissionMode | undefined {
    return this.sessions.get(sessionId)?.permissionMode;
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Record one answer for a pending AskUserQuestion and resolve the promise
   * once all questions in the group have been answered.
   */
  private resolveQuestionAnswer(
    session: ManagedSession,
    toolUseId: string,
    questionText: string,
    answer: string,
  ): void {
    const pending = session.pendingQuestions.get(toolUseId);
    if (!pending) return;

    // SDK 0.3.x AskUserQuestion keys answers by the full question text (see
    // AskUserQuestionOutput.answers: "question text -> answer string"), NOT the
    // short header. Keying by header leaves the per-question lookup undefined and
    // crashes the SDK's result builder ("undefined is not an object ... map").
    pending.answers[questionText] = answer;
    pending.remaining--;

    if (pending.remaining <= 0) {
      // All questions answered — resolve the canUseTool promise
      session.answeredQuestions.add(toolUseId);
      session.pendingQuestions.delete(toolUseId);

      // Prune answered set to prevent unbounded growth
      if (session.answeredQuestions.size > 50) {
        const first = session.answeredQuestions.values().next().value;
        if (first !== undefined) session.answeredQuestions.delete(first);
      }

      // Echo the original input (questions/options/multiSelect) and add the
      // collected answers. The SDK fills AskUserQuestionInput.answers from here.
      pending.resolve({
        behavior: 'allow',
        updatedInput: { ...pending.input, answers: pending.answers },
      });
    }
  }

  /**
   * Resolve a question option selection by keypress number (1-based).
   * Scans session history for the most recent unanswered ask_question entry,
   * extracts its options, and resolves the pending promise with the selected label.
   * Returns true if the answer was sent.
   */
  resolveQuestionKeypress(sessionId: string, key: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.alive) return false;

    const keyNum = parseInt(key, 10);
    if (isNaN(keyNum) || keyNum < 1) return false;

    // Scan history backwards for the most recent unanswered ask_question
    for (let i = session.history.length - 1; i >= 0; i--) {
      const entry = session.history[i].entry;
      if (entry.metadata?.special !== 'ask_question') continue;

      const toolUseId = entry.metadata.tool_use_id as string | undefined;
      if (!toolUseId || session.answeredQuestions.has(toolUseId)) continue;

      const pending = session.pendingQuestions.get(toolUseId);
      if (!pending) continue;

      const options = entry.metadata.options as Array<{ label: string }> | undefined;
      if (!options || keyNum > options.length) continue;

      const selected = options[keyNum - 1];
      const qIdx = (entry.metadata.question_index as number | undefined) ?? 0;
      const questionText = pending.questions[qIdx]?.question ?? entry.content;
      session.lastActivity = new Date().toISOString();
      this.resolveQuestionAnswer(session, toolUseId, questionText, selected.label);
      return true;
    }

    this.events.log(`[SDK] No pending question for keypress '${key}' in ${sessionId}`);
    return false;
  }

  /** Dispose all sessions. */
  dispose(): void {
    if (this.gitPollTimer) { clearInterval(this.gitPollTimer); this.gitPollTimer = undefined; }
    for (const [id] of this.sessions) {
      this.closeSession(id);
    }
  }

  // --- Internal ---

  /**
   * Reconcile one session's `committed` flag with git: flip it to true once HEAD has
   * advanced past the hash captured at session start. Returns true if it changed.
   */
  private async detectCommit(session: ManagedSession): Promise<boolean> {
    if (!session.alive || session.committed || !session.baseHead) return false;
    const head = await gitHeadHash(session.cwd);
    if (head && head !== session.baseHead) {
      session.committed = true;
      return true;
    }
    return false;
  }

  /** Poll every uncommitted session for new commits (agent- or user-made) and notify the phone. */
  private async pollGitCommits(): Promise<void> {
    let changed = false;
    for (const [, session] of this.sessions) {
      if (await this.detectCommit(session)) changed = true;
    }
    if (changed) this.events.onSessionListChanged(this.getSessions());
  }

  /** Consume SDK messages and forward as OutputEntry to the Nostr relay. */
  private async consumeMessages(sessionId: string, session: ManagedSession, q: Query): Promise<void> {
    try {
      for await (const msg of q) {
        if (!session.alive) break;

        // Auth error detection: SDK emits auth_status with error field on failure
        if (msg.type === 'auth_status') {
          const authMsg = msg as import('@anthropic-ai/claude-agent-sdk').SDKAuthStatusMessage;
          if (authMsg.error) {
            this.events.log(`[SDK] Auth error for ${sessionId}: ${authMsg.error}`);
            this.events.onAuthError(sessionId, authMsg.error);
          }
          continue; // Don't forward auth_status to phone
        }

        // Auth success detection: init message means Claude Code is running
        if (msg.type === 'system' && (msg as SDKSystemMessage).subtype === 'init') {
          const sysMsg = msg as SDKSystemMessage;
          session.permissionMode = sysMsg.permissionMode;
          this.events.onAuthSuccess(sessionId, {
            model: sysMsg.model,
            apiKeySource: sysMsg.apiKeySource,
            version: sysMsg.claude_code_version,
          });
          this.events.onSessionListChanged(this.getSessions());
        }

        // Track session state changes (idle = waiting for user input).
        // SDK 0.3.x: session_state_changed is its own message type (SDKSessionStateChangedMessage),
        // no longer a subtype of SDKSystemMessage.
        if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'session_state_changed') {
          const stateMsg = msg as SDKSessionStateChangedMessage;
          session.sessionState = stateMsg.state === 'idle' ? 'idle' : 'running';
        }

        const entries = sdkMessageToEntries(msg);
        if (entries.length === 0) continue;

        // Parse session-meta tag from first assistant response
        if (!session.summarized) {
          for (const entry of entries) {
            if (entry.entryType === 'text' && entry.metadata?.role === 'assistant') {
              const match = entry.content.match(/<!--\s*session-meta:\s*(\{[^}]+\})\s*-->/);
              if (match) {
                try {
                  const meta = JSON.parse(match[1]);
                  if (meta.topic) session.title = String(meta.topic).slice(0, 40);
                  if (meta.project) session.projectOverride = String(meta.project).slice(0, 40);
                  session.summarized = true;
                  this.events.log(`[SDK] Session meta: topic="${session.title}", project="${session.projectOverride}"`);
                  // Strip the tag from the entry content
                  entry.content = entry.content.replace(/<!--\s*session-meta:\s*\{[^}]+\}\s*-->/g, '').trim();
                  // Trigger session list update so phone sees new metadata
                  this.events.onSessionListChanged(this.getSessions());
                } catch { /* ignore parse errors */ }
              }
            }
          }
        }

        // Fast path: the agent may have just run `git commit`. Verify against git HEAD right away so
        // the badge updates without waiting for the next poll. (Manual commits are caught by the poll.)
        if (!session.committed) {
          for (const entry of entries) {
            if (entry.entryType === 'tool_use'
                && entry.metadata?.tool_name === 'Bash'
                && /\bgit\s+commit\b(?!\s+--help)/.test(
                     String((entry.metadata?.tool_input as Record<string, unknown>)?.command ?? ''))) {
              void this.detectCommit(session).then((changed) => {
                if (changed) {
                  this.events.log(`[SDK] Git commit detected in session ${sessionId}`);
                  this.events.onSessionListChanged(this.getSessions());
                }
              });
              break;
            }
          }
        }

        const seqEntries = entries.map(entry => ({
          seq: ++session.seqCounter,
          entry,
        }));

        // Store in history (cap at 500)
        session.history.push(...seqEntries);
        if (session.history.length > 500) {
          session.history = session.history.slice(-500);
        }

        session.lastActivity = new Date().toISOString();
        this.events.onOutput(sessionId, seqEntries);
      }
    } catch (err) {
      if (!session.alive) return; // Intentional close, don't restart

      this.events.log(`[SDK] Session ${sessionId} message stream error: ${err}`);

      // Attempt auto-restart if under the retry limit
      if (session.restartCount < SdkSessionManager.MAX_RESTARTS) {
        session.restartCount++;
        this.events.log(`[SDK] Restarting session ${sessionId} (attempt ${session.restartCount}/${SdkSessionManager.MAX_RESTARTS})`);

        // Notify phone that we're restarting
        const restartEntry: OutputEntry = {
          entryType: 'system',
          content: `Session interrupted — restarting (attempt ${session.restartCount})...`,
          timestamp: new Date().toISOString(),
          metadata: { special: 'session_restart' },
        };
        this.events.onOutput(sessionId, [{ seq: ++session.seqCounter, entry: restartEntry }]);

        // Re-create input channel and query with resume
        const newInput = createInputChannel();
        const newAbort = new AbortController();
        session.input = newInput;
        session.abortController = newAbort;

        const resumeEffort = toOptionsEffort(session.effortLevel);
        const newQ = query({
          prompt: newInput.generator,
          options: {
            resume: sessionId,
            cwd: session.cwd,
            permissionMode: session.permissionMode,
            abortController: newAbort,
            canUseTool: async (toolName, toolInput, options) => {
              return this.handlePermission(sessionId, session, toolName, toolInput, options);
            },
            settingSources: ['user', 'project'],
            systemPrompt: { type: 'preset', preset: 'claude_code' },
            tools: { type: 'preset', preset: 'claude_code' },
            fallbackModel: FALLBACK_MODEL,
            ...(session.model ? { model: session.model } : {}),
            ...(resumeEffort ? { effort: resumeEffort } : {}),
          },
        });
        session.query = newQ;

        // Resume consuming messages
        this.consumeMessages(sessionId, session, newQ);
        return; // Don't fall through to cleanup
      }

      // Max restarts exceeded — give up
      session.alive = false;
      this.events.log(`[SDK] Session ${sessionId} failed after ${session.restartCount} restarts`);
      const errorEntry: OutputEntry = {
        entryType: 'error',
        content: 'Session ended unexpectedly after multiple restart attempts.',
        timestamp: new Date().toISOString(),
        metadata: { special: 'session_died' },
      };
      this.events.onOutput(sessionId, [{ seq: ++session.seqCounter, entry: errorEntry }]);
    } finally {
      // Only clean up if we're not restarting (session still in map = restart happened)
      if (this.sessions.has(sessionId) && !session.alive) {
        this.sessions.delete(sessionId);
        this.events.onSessionEnded(sessionId);
        this.events.onSessionListChanged(this.getSessions());
        this.events.log(`[SDK] Session ${sessionId} ended`);
      } else if (!this.sessions.has(sessionId)) {
        // Session was already removed (e.g. closeSession called during restart)
        this.events.onSessionEnded(sessionId);
        this.events.onSessionListChanged(this.getSessions());
        this.events.log(`[SDK] Session ${sessionId} ended`);
      }
    }
  }

  /**
   * Handle a permission request from the SDK.
   *
   * The SDK only calls canUseTool for tools that actually need approval given
   * the current permissionMode. We don't re-implement permission logic here —
   * just forward to the phone for manual approval, or block AskUserQuestion
   * until the user answers on the phone.
   */
  private handlePermission(
    sessionId: string,
    session: ManagedSession,
    toolName: string,
    toolInput: Record<string, unknown>,
    options: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    // SECURITY: device-test sessions run with full Read/Bash/Grep and (in YOLO mode) auto-approve.
    // Hard-deny any tool call that touches signing keystores / secret files, BEFORE the mode check,
    // so a prompt-injected or confused test agent can never exfiltrate release keys through the
    // Nostr output channel. This is an enforced control, not a prose guideline. Mode-independent.
    if (session.testSession && touchesSecretPath(toolName, toolInput)) {
      this.events.log(`[SDK] DENIED secret-path access by test session ${sessionId}: ${toolName}`);
      return Promise.resolve({
        behavior: 'deny',
        message: 'Blocked: device-test sessions may not read signing keystores or secret files (keystore/.jks/.p12/key.properties/keystore.properties/.env). This is a hard security boundary.',
      });
    }

    // AskUserQuestion: block until the user answers on the phone.
    // The SDK expects answers via updatedInput.answers (keyed by question header).
    // Question entries appear in the output stream via sdkAdapter, and the phone
    // sends answers back through sendQuestionInput() / resolveQuestionKeypress().
    if (toolName === 'AskUserQuestion') {
      const rawQuestions = (toolInput.questions as Array<{ question: string; header?: string }>) || [];
      this.events.onAskQuestion(sessionId, options.toolUseID, rawQuestions);

      return new Promise<PermissionResult>((resolve) => {
        const timer = setTimeout(() => {
          session.pendingQuestions.delete(options.toolUseID);
          this.events.log(`[SDK] Question timed out (${options.toolUseID}) in ${sessionId}`);
          resolve({ behavior: 'deny', message: 'Question timed out' });
        }, SdkSessionManager.PERMISSION_TIMEOUT_MS);

        const wrappedResolve = (result: PermissionResult) => {
          clearTimeout(timer);
          resolve(result);
        };

        session.pendingQuestions.set(options.toolUseID, {
          input: toolInput,
          questions: rawQuestions,
          answers: {},
          remaining: rawQuestions.length,
          resolve: wrappedResolve,
        });
      });
    }

    // EnterPlanMode: SDK is autonomously entering plan mode. Update our tracked
    // mode so subsequent canUseTool calls (especially ExitPlanMode) are correctly
    // forwarded to the phone instead of auto-approved.
    if (toolName === 'EnterPlanMode') {
      session.permissionMode = 'plan';
      this.events.onSessionListChanged(this.getSessions());
      this.events.onAutoModeChange?.(sessionId, 'plan');
      this.events.log(`[SDK] EnterPlanMode: switched ${sessionId} to plan mode`);
      return Promise.resolve({ behavior: 'allow' as const, updatedInput: {} });
    }

    // Default mode = YOLO: auto-approve everything (matches old bridge behavior
    // where the bridge simulated pressing '1' for every permission prompt)
    const mode = session.permissionMode;
    if (mode === 'default') {
      return Promise.resolve({ behavior: 'allow', updatedInput: {} });
    }

    // Plan / acceptEdits: forward to phone for manual approval
    return new Promise<PermissionResult>((resolve) => {
      const timer = setTimeout(() => {
        session.pendingPermissions.delete(options.toolUseID);
        this.events.log(`[SDK] Permission timed out for ${toolName} (${options.toolUseID}) in session ${sessionId}`);
        resolve({ behavior: 'deny', message: 'Permission timed out' });
      }, SdkSessionManager.PERMISSION_TIMEOUT_MS);

      const wrappedResolve = (result: PermissionResult) => {
        clearTimeout(timer);
        resolve(result);
      };

      session.pendingPermissions.set(options.toolUseID, { toolName, resolve: wrappedResolve });

      this.events.onPermissionRequest({
        sessionId,
        toolName,
        toolUseId: options.toolUseID,
        toolInput,
        title: options.title,
        description: options.description,
        resolve: wrappedResolve,
      });
    });
  }
}
