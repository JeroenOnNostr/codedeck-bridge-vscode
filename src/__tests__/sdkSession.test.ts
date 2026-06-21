import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SdkSessionManager } from '../sdkSession';
import type { SdkSessionEvents } from '../sdkSession';
import type { OutputEntry } from '../types';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';

// Mock the SDK module so createSession() doesn't spawn a real subprocess
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(() => {
    // Return a mock Query that is an async generator yielding nothing
    const gen = (async function* () { /* never yields */ })();
    return Object.assign(gen, {
      setPermissionMode: vi.fn().mockResolvedValue(undefined),
      applyFlagSettings: vi.fn().mockResolvedValue(undefined),
      setModel: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined),
    });
  }),
  getSessionMessages: vi.fn().mockResolvedValue([]),
}));

function createMockEvents(): SdkSessionEvents & { logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    onOutput: vi.fn(),
    onPermissionRequest: vi.fn(),
    onAskQuestion: vi.fn(),
    onSessionListChanged: vi.fn(),
    onSessionEnded: vi.fn(),
    onAuthError: vi.fn(),
    onAuthSuccess: vi.fn(),
    log: (msg: string) => { logs.push(msg); },
  };
}

/**
 * Inject a question entry into a session's history AND a pending question promise.
 * Returns a promise that resolves with the PermissionResult when the question is answered.
 */
function injectQuestionHistory(
  sdk: SdkSessionManager,
  sessionId: string,
  toolUseId: string,
  options: Array<{ label: string; description?: string }>,
  header = 'question',
): Promise<PermissionResult> {
  const sessions = (sdk as any).sessions as Map<string, any>;
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  session.history.push({
    seq: ++session.seqCounter,
    entry: {
      entryType: 'system',
      content: 'What should I do?',
      timestamp: new Date().toISOString(),
      metadata: {
        special: 'ask_question',
        tool_use_id: toolUseId,
        header,
        options,
        question_index: 0,
        question_count: 1,
      },
    } as OutputEntry,
  });
  // Also inject the pending question promise (mirrors handlePermission behavior).
  // `input` is the full original tool input, echoed back in updatedInput.
  return new Promise<PermissionResult>((resolve) => {
    session.pendingQuestions.set(toolUseId, {
      input: { questions: [{ question: 'What should I do?', header, options, multiSelect: false }] },
      questions: [{ question: 'What should I do?', header }],
      answers: {},
      remaining: 1,
      resolve,
    });
  });
}

/** Inject a pending permission into a session for testing resolvePermission. */
function injectPendingPermission(
  sdk: SdkSessionManager,
  sessionId: string,
  toolUseId: string,
  toolName: string,
): Promise<PermissionResult> {
  const sessions = (sdk as any).sessions as Map<string, any>;
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  return new Promise<PermissionResult>((resolve) => {
    session.pendingPermissions.set(toolUseId, { toolName, resolve });
  });
}

describe('SdkSessionManager', () => {
  let sdk: SdkSessionManager;
  let events: ReturnType<typeof createMockEvents>;
  const SESSION_ID = 'test-session-001';

  beforeEach(() => {
    events = createMockEvents();
    sdk = new SdkSessionManager(events);
    sdk.createSession(SESSION_ID, '/tmp/test', 'plan');
  });

  describe('resolveQuestionKeypress', () => {
    it('maps keypress to correct option and resolves promise with answer', async () => {
      const resultPromise = injectQuestionHistory(sdk, SESSION_ID, 'tool_q1', [
        { label: 'Option A' },
        { label: 'Option B' },
        { label: 'Option C' },
      ], 'Approach');

      const sent = sdk.resolveQuestionKeypress(SESSION_ID, '2');
      expect(sent).toBe(true);

      const result = await resultPromise;
      expect(result.behavior).toBe('allow');
      if (result.behavior === 'allow') {
        // SDK 0.3.x: answers keyed by question text (not header), questions echoed back
        expect(result.updatedInput!.answers).toEqual({ 'What should I do?': 'Option B' });
        expect(result.updatedInput!.questions).toBeDefined();
      }

      const sessions = (sdk as any).sessions as Map<string, any>;
      expect(sessions.get(SESSION_ID).answeredQuestions.has('tool_q1')).toBe(true);
    });

    it('returns false for key out of range', () => {
      injectQuestionHistory(sdk, SESSION_ID, 'tool_q2', [
        { label: 'Only option' },
      ]);

      const result = sdk.resolveQuestionKeypress(SESSION_ID, '5');
      expect(result).toBe(false);
    });

    it('returns false when no pending question exists', () => {
      const result = sdk.resolveQuestionKeypress(SESSION_ID, '1');
      expect(result).toBe(false);
    });

    it('skips already-answered questions and finds the next one', async () => {
      // First question (already answered)
      injectQuestionHistory(sdk, SESSION_ID, 'tool_q_old', [
        { label: 'Old option' },
      ]);
      // Mark as answered (remove from pendingQuestions too)
      const sessions = (sdk as any).sessions as Map<string, any>;
      sessions.get(SESSION_ID).answeredQuestions.add('tool_q_old');
      sessions.get(SESSION_ID).pendingQuestions.delete('tool_q_old');

      // Second question (pending)
      const resultPromise = injectQuestionHistory(sdk, SESSION_ID, 'tool_q_new', [
        { label: 'New A' },
        { label: 'New B' },
      ], 'Method');

      const sent = sdk.resolveQuestionKeypress(SESSION_ID, '1');
      expect(sent).toBe(true);

      const result = await resultPromise;
      expect(result.behavior).toBe('allow');
      if (result.behavior === 'allow') {
        expect(result.updatedInput!.answers).toEqual({ 'What should I do?': 'New A' });
        expect(result.updatedInput!.questions).toBeDefined();
      }
    });

    it('returns false for non-existent session', () => {
      const result = sdk.resolveQuestionKeypress('nonexistent', '1');
      expect(result).toBe(false);
    });
  });

  describe('sendQuestionInput', () => {
    it('resolves pending question promise with free-text answer', async () => {
      const resultPromise = injectQuestionHistory(sdk, SESSION_ID, 'tool_qt1', [
        { label: 'Option A' },
      ], 'Library');

      const sent = sdk.sendQuestionInput(SESSION_ID, 'Use axios instead');
      expect(sent).toBe(true);

      const result = await resultPromise;
      expect(result.behavior).toBe('allow');
      if (result.behavior === 'allow') {
        expect(result.updatedInput!.answers).toEqual({ 'What should I do?': 'Use axios instead' });
        expect(result.updatedInput!.questions).toBeDefined();
      }
    });

    it('falls back to sendInput when no pending question exists', () => {
      const sent = sdk.sendQuestionInput(SESSION_ID, 'hello');
      // sendInput returns true if session exists
      expect(sent).toBe(true);
      expect(events.logs.some(l => l.includes('falling back to sendInput'))).toBe(true);
    });

    // Regression: a multi-question group must collect answers q0,q1,... IN ORDER. The old
    // backward-scan keyed off the entry's own question_index (always the LAST question), so a
    // 2-question group overwrote q1 twice and dropped q0. Now it keys off `remaining`.
    it('resolves a 2-question group in order (q0 then q1), not overwriting the last', async () => {
      const sessions = (sdk as any).sessions as Map<string, any>;
      const session = sessions.get(SESSION_ID);
      const q0 = { question: 'First question?', header: 'Q0', options: [{ label: 'a0' }] };
      const q1 = { question: 'Second question?', header: 'Q1', options: [{ label: 'b1' }] };
      // Two ask_question history entries sharing one tool_use_id, indices 0 and 1.
      for (const [idx, q] of [q0, q1].entries()) {
        session.history.push({
          seq: ++session.seqCounter,
          entry: {
            entryType: 'system', content: q.question, timestamp: new Date().toISOString(),
            metadata: { special: 'ask_question', tool_use_id: 'grp', header: q.header, options: q.options, question_index: idx, question_count: 2 },
          },
        });
      }
      const resultPromise = new Promise<PermissionResult>((resolve) => {
        session.pendingQuestions.set('grp', {
          input: { questions: [q0, q1] },
          questions: [q0, q1],
          answers: {},
          remaining: 2,
          resolve,
        });
      });

      // Answer in order; group resolves only after BOTH.
      expect(sdk.sendQuestionInput(SESSION_ID, 'answer-zero')).toBe(true);
      expect(sdk.sendQuestionInput(SESSION_ID, 'answer-one')).toBe(true);

      const result = await resultPromise;
      expect(result.behavior).toBe('allow');
      if (result.behavior === 'allow') {
        expect(result.updatedInput!.answers).toEqual({
          'First question?': 'answer-zero',
          'Second question?': 'answer-one',
        });
      }
    });
  });

  // Regression guard for CDB-022: SDK 0.3.177 changed the AskUserQuestion answer
  // contract. The host must return updatedInput = original input (with `questions`)
  // PLUS `answers` keyed by the full question text. The old shape
  // (`{ answers: { [header]: label } }`, no questions) crashed the SDK's Bun/JSC
  // result builder with "undefined is not an object (evaluating 'H.map')".
  describe('AskUserQuestion answer contract (SDK 0.3.177)', () => {
    it('echoes the original questions array and keys answers by question text', async () => {
      const resultPromise = injectQuestionHistory(sdk, SESSION_ID, 'tool_contract', [
        { label: 'Yes', description: 'do it' },
        { label: 'No', description: 'skip it' },
      ], 'Confirm');

      expect(sdk.resolveQuestionKeypress(SESSION_ID, '1')).toBe(true);

      const result = await resultPromise;
      expect(result.behavior).toBe('allow');
      if (result.behavior === 'allow') {
        const updated = result.updatedInput as { questions?: unknown[]; answers?: Record<string, string> };
        // `questions` must survive — the SDK maps over it to build the output
        expect(Array.isArray(updated.questions)).toBe(true);
        expect(updated.questions!.length).toBe(1);
        // answers keyed by the full question text, NOT the short header
        expect(updated.answers).toEqual({ 'What should I do?': 'Yes' });
        expect(updated.answers).not.toHaveProperty('Confirm');
      }
    });
  });

  describe('resolvePermission', () => {
    it('resolves allow without modifier — no updatedPermissions', async () => {
      const resultPromise = injectPendingPermission(sdk, SESSION_ID, 'tool_01', 'Bash');
      sdk.resolvePermission(SESSION_ID, 'tool_01', true);
      const result = await resultPromise;
      expect(result.behavior).toBe('allow');
      expect('updatedPermissions' in result && result.updatedPermissions).toBeFalsy();
    });

    it('resolves allow with always — includes addRules for projectSettings', async () => {
      const resultPromise = injectPendingPermission(sdk, SESSION_ID, 'tool_02', 'Bash');
      sdk.resolvePermission(SESSION_ID, 'tool_02', true, 'always');
      const result = await resultPromise;
      expect(result.behavior).toBe('allow');
      if (result.behavior === 'allow') {
        expect(result.updatedPermissions).toBeDefined();
        expect(result.updatedPermissions!.length).toBe(1);
        const rule = result.updatedPermissions![0];
        expect(rule.type).toBe('addRules');
        if (rule.type === 'addRules') {
          expect(rule.rules[0].toolName).toBe('Bash');
          expect(rule.behavior).toBe('allow');
          expect(rule.destination).toBe('projectSettings');
        }
      }
    });

    it('resolves deny with never modifier', async () => {
      const resultPromise = injectPendingPermission(sdk, SESSION_ID, 'tool_03', 'Bash');
      sdk.resolvePermission(SESSION_ID, 'tool_03', false, 'never');
      const result = await resultPromise;
      expect(result.behavior).toBe('deny');
      if (result.behavior === 'deny') {
        expect(result.message).toContain('never');
      }
    });

    it('resolves deny without modifier', async () => {
      const resultPromise = injectPendingPermission(sdk, SESSION_ID, 'tool_04', 'Bash');
      sdk.resolvePermission(SESSION_ID, 'tool_04', false);
      const result = await resultPromise;
      expect(result.behavior).toBe('deny');
      if (result.behavior === 'deny') {
        expect(result.message).toBe('User denied');
      }
    });
  });

  describe('handlePermission — ExitPlanMode card suppression', () => {
    // handlePermission is private; the returned promise stays pending until the permission is
    // resolved/timed out, so we never await it directly — we resolve it explicitly to clean up.
    function callHandlePermission(toolName: string, toolInput: Record<string, unknown>, toolUseID: string) {
      const session = (sdk as any).sessions.get(SESSION_ID);
      return (sdk as any).handlePermission(SESSION_ID, session, toolName, toolInput, {
        toolUseID,
        title: `${toolName} title`,
        description: '',
      }) as Promise<PermissionResult>;
    }

    it('registers the ExitPlanMode permission but does NOT publish a generic permission_request card', () => {
      // Session is created in 'plan' mode (beforeEach), so this reaches the forward block.
      const pending = callHandlePermission('ExitPlanMode', { plan: 'do the thing' }, 'tu_exit');
      // No duplicate generic card — the dedicated plan_approval card is the sole UI.
      expect(events.onPermissionRequest).not.toHaveBeenCalled();
      // But the permission IS registered so the plan-approval / exit-plan keypress can resolve it.
      expect(sdk.findPendingPermission(SESSION_ID, 'ExitPlanMode')).toBe('tu_exit');
      // waiting_permission state is still published (derived from pendingPermissions.size).
      expect(events.onSessionListChanged).toHaveBeenCalled();
      // Resolve to clear the pending promise/timeout.
      sdk.resolvePermission(SESSION_ID, 'tu_exit', false);
      return pending;
    });

    it('still publishes a generic permission_request card for normal tools', () => {
      const pending = callHandlePermission('Bash', { command: 'ls' }, 'tu_bash');
      expect(events.onPermissionRequest).toHaveBeenCalledTimes(1);
      expect(sdk.findPendingPermission(SESSION_ID, 'Bash')).toBe('tu_bash');
      sdk.resolvePermission(SESSION_ID, 'tu_bash', false);
      return pending;
    });
  });

  describe('nextSeq — CDB-025: out-of-band entries must not collide on a shared seq', () => {
    it('returns distinct, monotonically increasing, non-zero seqs', () => {
      // The old bug published every permission card with a constant seq: 0; the phone's per-seq
      // dedup then dropped the 2nd+ card. Each allocation must be unique and > 0.
      const a = sdk.nextSeq(SESSION_ID);
      const b = sdk.nextSeq(SESSION_ID);
      const c = sdk.nextSeq(SESSION_ID);
      expect(a).toBeGreaterThan(0);
      expect(b).toBeGreaterThan(a);
      expect(c).toBeGreaterThan(b);
      expect(new Set([a, b, c]).size).toBe(3);
    });

    it('gives a second permission card its own seq (the exact wedge repro)', () => {
      // Sub-agent write card, then parent read card, in one session — both must survive.
      const firstCard = sdk.nextSeq(SESSION_ID);
      const secondCard = sdk.nextSeq(SESSION_ID);
      expect(secondCard).not.toBe(firstCard);
    });

    it('shares the counter with normal output so an out-of-band entry never reuses a stream seq', () => {
      const session = (sdk as any).sessions.get(SESSION_ID);
      session.seqCounter = 7; // pretend 7 stream entries have been emitted
      expect(sdk.nextSeq(SESSION_ID)).toBe(8);
    });

    it('returns 0 (fail-safe) for an unknown session', () => {
      expect(sdk.nextSeq('no-such-session')).toBe(0);
    });
  });

  describe('setEffortLevel', () => {
    it('passes low/medium/high/xhigh through unchanged', async () => {
      for (const level of ['low', 'medium', 'high', 'xhigh'] as const) {
        const { applied, confirmedLevel } = await sdk.setEffortLevel(SESSION_ID, level);
        expect(applied).toBe(true);
        expect(confirmedLevel).toBe(level);
      }
    });

    it('maps mid-session max → xhigh (true max needs a fresh session)', async () => {
      const { applied, confirmedLevel } = await sdk.setEffortLevel(SESSION_ID, 'max');
      expect(applied).toBe(true);
      expect(confirmedLevel).toBe('xhigh');
    });

    it('resets to model default on auto', async () => {
      const { applied, confirmedLevel } = await sdk.setEffortLevel(SESSION_ID, 'auto');
      expect(applied).toBe(true);
      expect(confirmedLevel).toBe('auto');
    });

    it('returns not-applied for an unknown session', async () => {
      const { applied } = await sdk.setEffortLevel('nope', 'high');
      expect(applied).toBe(false);
    });
  });

  // Regression guard for the AskUserQuestion wedge: an orphaned pending question (or permission)
  // must be denied+cleared on interrupt/close/restart, or its canUseTool promise dangles forever
  // and the SDK emits "Tool permission stream closed before response received".
  describe('denyAllPending — drain on interrupt/close', () => {
    it('interruptSession denies pending PERMISSIONS and QUESTIONS and clears both maps', async () => {
      const permPromise = injectPendingPermission(sdk, SESSION_ID, 'tool_perm', 'Bash');
      const qPromise = injectQuestionHistory(sdk, SESSION_ID, 'tool_q', [{ label: 'A' }], 'Q');

      const ok = sdk.interruptSession(SESSION_ID);
      expect(ok).toBe(true);

      const perm = await permPromise;
      const q = await qPromise;
      expect(perm.behavior).toBe('deny');
      expect(q.behavior).toBe('deny');

      const session = (sdk as any).sessions.get(SESSION_ID);
      expect(session.pendingPermissions.size).toBe(0);
      expect(session.pendingQuestions.size).toBe(0);
      // phone is told to clear its waiting state
      expect(events.onSessionListChanged).toHaveBeenCalled();
    });

    it('closeSession denies a pending QUESTION (not just permissions)', async () => {
      const qPromise = injectQuestionHistory(sdk, SESSION_ID, 'tool_q2', [{ label: 'A' }], 'Q');
      const ok = sdk.closeSession(SESSION_ID);
      expect(ok).toBe(true);
      const q = await qPromise;
      expect(q.behavior).toBe('deny');
    });

    it('a phone answer arriving AFTER the drain is a harmless no-op (no double-resolve)', async () => {
      const qPromise = injectQuestionHistory(sdk, SESSION_ID, 'tool_q3', [{ label: 'A' }], 'Q');
      sdk.interruptSession(SESSION_ID);
      const first = await qPromise; // resolved by the drain
      expect(first.behavior).toBe('deny');
      // Late keypress finds no pending question → returns false, does NOT throw or re-resolve.
      expect(sdk.resolveQuestionKeypress(SESSION_ID, '1')).toBe(false);
    });
  });

  describe('setModel', () => {
    it('applies a model and confirms it back', async () => {
      const { applied, confirmedModel } = await sdk.setModel(SESSION_ID, 'claude-opus-4-8');
      expect(applied).toBe(true);
      expect(confirmedModel).toBe('claude-opus-4-8');
      const sessions = (sdk as any).sessions as Map<string, any>;
      expect(sessions.get(SESSION_ID).model).toBe('claude-opus-4-8');
    });

    it('returns not-applied for an unknown session', async () => {
      const { applied, confirmedModel } = await sdk.setModel('nope', 'claude-opus-4-8');
      expect(applied).toBe(false);
      expect(confirmedModel).toBe('claude-opus-4-8');
    });

    it('reports the model in getSessions()', async () => {
      await sdk.setModel(SESSION_ID, 'claude-sonnet-4-6');
      const session = sdk.getSessions().find(s => s.id === SESSION_ID);
      expect(session?.model).toBe('claude-sonnet-4-6');
    });
  });
});
