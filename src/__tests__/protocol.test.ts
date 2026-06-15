import { describe, it, expect } from 'vitest';
import type {
  BridgeOutbound,
  BridgeInbound,
  SessionListMessage,
  OutputMessage,
  HistoryResponseMessage,
  InputMessage,
  PermissionResponseMessage,
  ModeChangeMessage,
  ModelChangeMessage,
  ModelConfirmedMessage,
  EffortChangeMessage,
  CreateSessionMessage,
  HistoryRequestMessage,
  OutputEntry,
  RemoteSessionInfo,
} from '../types';
import { SESSION_LIST_EVENT_KIND, OUTPUT_EVENT_KIND, PROTOCOL_VERSION } from '../types';

describe('Protocol types', () => {
  describe('Event kinds', () => {
    it('session list uses NIP-33 replaceable kind (30000-39999)', () => {
      expect(SESSION_LIST_EVENT_KIND).toBe(30515);
      expect(SESSION_LIST_EVENT_KIND).toBeGreaterThanOrEqual(30000);
      expect(SESSION_LIST_EVENT_KIND).toBeLessThan(40000);
    });

    it('output uses regular event kind (1-9999)', () => {
      expect(OUTPUT_EVENT_KIND).toBe(4515);
      expect(OUTPUT_EVENT_KIND).toBeGreaterThanOrEqual(1);
      expect(OUTPUT_EVENT_KIND).toBeLessThan(10000);
    });
  });

  describe('Bridge outbound messages (bridge → phone)', () => {
    it('serializes session list message', () => {
      const sessions: RemoteSessionInfo[] = [
        { id: 'sess-1', slug: 'my-project', cwd: '/workspace', lastActivity: '2026-02-09T19:00:00Z', lineCount: 42, title: 'Fix the auth bug', project: 'workspace' },
        { id: 'sess-2', slug: 'other-proj', cwd: '/other', lastActivity: '2026-02-09T18:00:00Z', lineCount: 10, title: null, project: 'other' },
      ];

      const msg: SessionListMessage = {
        type: 'sessions',
        machine: 'jeroen-laptop',
        sessions,
      };

      const json = JSON.stringify(msg);
      const parsed: BridgeOutbound = JSON.parse(json);

      expect(parsed.type).toBe('sessions');
      if (parsed.type === 'sessions') {
        expect(parsed.machine).toBe('jeroen-laptop');
        expect(parsed.sessions).toHaveLength(2);
        expect(parsed.sessions[0].slug).toBe('my-project');
      }
    });

    it('session list advertises the protocol version', () => {
      expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(1);
      const msg: SessionListMessage = {
        type: 'sessions',
        machine: 'laptop',
        sessions: [],
        protocolVersion: PROTOCOL_VERSION,
      };
      const parsed: BridgeOutbound = JSON.parse(JSON.stringify(msg));
      if (parsed.type === 'sessions') {
        expect(parsed.protocolVersion).toBe(PROTOCOL_VERSION);
      }
    });

    it('serializes output message with seq counter', () => {
      const entry: OutputEntry = {
        entryType: 'text',
        content: 'Hello from Claude',
        timestamp: '2026-02-09T19:00:00Z',
        metadata: { role: 'assistant', model: 'claude-opus-4-6' },
      };

      const msg: OutputMessage = {
        type: 'output',
        sessionId: 'sess-1',
        seq: 42,
        entry,
      };

      const json = JSON.stringify(msg);
      const parsed: BridgeOutbound = JSON.parse(json);

      expect(parsed.type).toBe('output');
      if (parsed.type === 'output') {
        expect(parsed.sessionId).toBe('sess-1');
        expect(parsed.seq).toBe(42);
        expect(parsed.entry.entryType).toBe('text');
        expect(parsed.entry.content).toBe('Hello from Claude');
      }
    });

    it('serializes history response', () => {
      const entries = [
        { seq: 1, entry: { entryType: 'text' as const, content: 'First', timestamp: 't1' } },
        { seq: 2, entry: { entryType: 'tool_use' as const, content: 'Bash: ls', timestamp: 't2' } },
      ];

      const msg: HistoryResponseMessage = {
        type: 'history',
        sessionId: 'sess-1',
        entries,
        totalEntries: 100,
        fromSeq: 1,
        toSeq: 2,
        chunkIndex: 0,
        totalChunks: 5,
        requestId: 'req-abc-123',
      };

      const json = JSON.stringify(msg);
      const parsed: BridgeOutbound = JSON.parse(json);

      expect(parsed.type).toBe('history');
      if (parsed.type === 'history') {
        expect(parsed.entries).toHaveLength(2);
        expect(parsed.totalEntries).toBe(100);
        expect(parsed.fromSeq).toBe(1);
        expect(parsed.toSeq).toBe(2);
        expect(parsed.chunkIndex).toBe(0);
        expect(parsed.totalChunks).toBe(5);
        expect(parsed.requestId).toBe('req-abc-123');
      }
    });

    it('serializes model-confirmed feedback', () => {
      const msg: ModelConfirmedMessage = {
        type: 'model-confirmed',
        sessionId: 'sess-1',
        model: 'claude-sonnet-4-6',
      };

      const parsed: BridgeOutbound = JSON.parse(JSON.stringify(msg));
      expect(parsed.type).toBe('model-confirmed');
      if (parsed.type === 'model-confirmed') {
        expect(parsed.model).toBe('claude-sonnet-4-6');
      }
    });

    it('session list reports per-session model', () => {
      const sessions: RemoteSessionInfo[] = [
        { id: 'sess-1', slug: 'p', cwd: '/w', lastActivity: 't', lineCount: 1, title: null, project: 'w', model: 'claude-opus-4-8', effortLevel: 'max' },
      ];
      const msg: SessionListMessage = { type: 'sessions', machine: 'laptop', sessions };
      const parsed: BridgeOutbound = JSON.parse(JSON.stringify(msg));
      if (parsed.type === 'sessions') {
        expect(parsed.sessions[0].model).toBe('claude-opus-4-8');
        expect(parsed.sessions[0].effortLevel).toBe('max');
      }
    });
  });

  describe('Bridge inbound messages (phone → bridge)', () => {
    it('serializes input message', () => {
      const msg: InputMessage = {
        type: 'input',
        sessionId: 'sess-1',
        text: 'Fix the bug in auth.ts',
      };

      const json = JSON.stringify(msg);
      const parsed: BridgeInbound = JSON.parse(json);

      expect(parsed.type).toBe('input');
      if (parsed.type === 'input') {
        expect(parsed.text).toBe('Fix the bug in auth.ts');
      }
    });

    it('serializes permission response', () => {
      const msg: PermissionResponseMessage = {
        type: 'permission-res',
        sessionId: 'sess-1',
        requestId: 'req-123',
        allow: true,
      };

      const json = JSON.stringify(msg);
      const parsed: BridgeInbound = JSON.parse(json);

      expect(parsed.type).toBe('permission-res');
      if (parsed.type === 'permission-res') {
        expect(parsed.allow).toBe(true);
        expect(parsed.requestId).toBe('req-123');
      }
    });

    it('serializes mode change', () => {
      const msg: ModeChangeMessage = {
        type: 'mode',
        sessionId: 'sess-1',
        mode: 'default',
      };

      const json = JSON.stringify(msg);
      const parsed: BridgeInbound = JSON.parse(json);

      expect(parsed.type).toBe('mode');
      if (parsed.type === 'mode') {
        expect(parsed.mode).toBe('default');
      }
    });

    it('serializes effort change with xhigh level', () => {
      const msg: EffortChangeMessage = {
        type: 'effort',
        sessionId: 'sess-1',
        level: 'xhigh',
      };

      const parsed: BridgeInbound = JSON.parse(JSON.stringify(msg));
      expect(parsed.type).toBe('effort');
      if (parsed.type === 'effort') {
        expect(parsed.level).toBe('xhigh');
      }
    });

    it('serializes model change', () => {
      const msg: ModelChangeMessage = {
        type: 'model',
        sessionId: 'sess-1',
        model: 'claude-opus-4-8',
      };

      const parsed: BridgeInbound = JSON.parse(JSON.stringify(msg));
      expect(parsed.type).toBe('model');
      if (parsed.type === 'model') {
        expect(parsed.model).toBe('claude-opus-4-8');
      }
    });

    it('serializes create-session with model and default effort', () => {
      const msg: CreateSessionMessage = {
        type: 'create-session',
        defaultEffort: 'max',
        model: 'claude-fable-5',
      };

      const parsed: BridgeInbound = JSON.parse(JSON.stringify(msg));
      expect(parsed.type).toBe('create-session');
      if (parsed.type === 'create-session') {
        expect(parsed.defaultEffort).toBe('max');
        expect(parsed.model).toBe('claude-fable-5');
      }
    });

    it('serializes bare create-session (no model/effort)', () => {
      const msg: CreateSessionMessage = { type: 'create-session' };
      const parsed = JSON.parse(JSON.stringify(msg));
      expect(parsed.type).toBe('create-session');
      expect(parsed.model).toBeUndefined();
      expect(parsed.defaultEffort).toBeUndefined();
    });

    it('serializes history request', () => {
      const msg: HistoryRequestMessage = {
        type: 'history-request',
        sessionId: 'sess-1',
        afterSeq: 50,
      };

      const json = JSON.stringify(msg);
      const parsed: BridgeInbound = JSON.parse(json);

      expect(parsed.type).toBe('history-request');
      if (parsed.type === 'history-request') {
        expect(parsed.sessionId).toBe('sess-1');
        expect(parsed.afterSeq).toBe(50);
      }
    });

    it('serializes history request without afterSeq (full history)', () => {
      const msg: HistoryRequestMessage = {
        type: 'history-request',
        sessionId: 'sess-1',
      };

      const json = JSON.stringify(msg);
      const parsed = JSON.parse(json);

      expect(parsed.afterSeq).toBeUndefined();
    });
  });

  describe('Seq counter semantics', () => {
    it('seq numbers are monotonically increasing per session', () => {
      const messages: OutputMessage[] = [];
      let seq = 0;

      for (let i = 0; i < 5; i++) {
        seq++;
        messages.push({
          type: 'output',
          sessionId: 'sess-1',
          seq,
          entry: { entryType: 'text', content: `Message ${i}`, timestamp: `t${i}` },
        });
      }

      for (let i = 1; i < messages.length; i++) {
        expect(messages[i].seq).toBeGreaterThan(messages[i - 1].seq);
      }
    });

    it('different sessions have independent seq counters', () => {
      const counters = new Map<string, number>();

      function nextSeq(sessionId: string): number {
        const current = counters.get(sessionId) ?? 0;
        const next = current + 1;
        counters.set(sessionId, next);
        return next;
      }

      expect(nextSeq('sess-1')).toBe(1);
      expect(nextSeq('sess-1')).toBe(2);
      expect(nextSeq('sess-2')).toBe(1); // independent
      expect(nextSeq('sess-1')).toBe(3);
      expect(nextSeq('sess-2')).toBe(2);
    });
  });

  describe('Nostr event tag structure', () => {
    it('session list events should have d-tag for NIP-33 replaceability', () => {
      // NIP-33: parameterized replaceable events use d-tag as identifier
      const machineName = 'jeroen-laptop';
      const tags = [
        ['p', 'phone-pubkey-hex'],
        ['d', machineName],
      ];

      expect(tags.find(t => t[0] === 'd')?.[1]).toBe(machineName);
    });

    it('output events should have s-tag for session filtering', () => {
      const sessionId = 'sess-123';
      const seq = 42;
      const tags = [
        ['p', 'phone-pubkey-hex'],
        ['s', sessionId],
        ['seq', String(seq)],
      ];

      expect(tags.find(t => t[0] === 's')?.[1]).toBe(sessionId);
      expect(tags.find(t => t[0] === 'seq')?.[1]).toBe('42');
    });

    it('history response events should have t=history tag', () => {
      const tags = [
        ['p', 'phone-pubkey-hex'],
        ['s', 'sess-123'],
        ['t', 'history'],
      ];

      expect(tags.find(t => t[0] === 't')?.[1]).toBe('history');
    });
  });
});
