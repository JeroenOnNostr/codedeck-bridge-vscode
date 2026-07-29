/**
 * Core bridge orchestrator — coordinates Nostr relay ↔ SDK sessions.
 *
 * This module is the extraction boundary: everything here is pure Node.js.
 * The VSCode extension (extension.ts) is a thin wrapper that provides
 * configuration, pairing UI, and status bar.
 *
 * Architecture (post SDK migration):
 *   Phone ──Nostr──> NostrRelay → BridgeCore → SdkSessionManager → SDK → Claude Code subprocess
 *   Claude Code subprocess → SDK → SdkSessionManager → BridgeCore → NostrRelay ──Nostr──> Phone
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { NostrRelay, NostrRelayEvents } from './nostrRelay';
import { SdkSessionManager } from './sdkSession';
import { buildScreenshotEntry } from './screenshotDelivery';
import * as meshAdmin from './meshAdmin';
import { getGsdState } from './gsdState';

/**
 * Resolve the working directory for a new session (CDB-033).
 *
 * Before this, every session ran at `workspaceFolders[0]`. In a workspace holding many sibling
 * repos that meant anything reading the session's cwd — GSD above all — could only ever see the
 * multi-project root, never an actual project.
 *
 * The phone may now ask for a subdirectory, and that is untrusted input, so it is confined to the
 * workspace root: the resolved path must be the root or beneath it, and must already exist as a
 * directory. Anything else logs and falls back to the root rather than failing the request — a
 * stale bookmark on the phone should not make sessions un-creatable.
 */
export function resolveSessionCwd(
  root: string,
  requested: string | undefined,
  log: (m: string) => void = () => {},
  opts: { create?: boolean } = {},
): string {
  const rootReal = path.resolve(root);
  if (!requested) return rootReal;

  const resolved = path.resolve(rootReal, requested);
  // Compare on path segments, never string prefix: `/ws/app-2` must not count as inside `/ws/app`.
  const rel = path.relative(rootReal, resolved);
  const inside = resolved === rootReal || (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel));
  if (!inside) {
    log(`[Codedeck] Rejected session cwd outside the workspace: ${requested} → using ${rootReal}`);
    return rootReal;
  }
  try {
    if (!fs.statSync(resolved).isDirectory()) {
      log(`[Codedeck] Session cwd is not a directory: ${resolved} → using ${rootReal}`);
      return rootReal;
    }
    return resolved;
  } catch {
    // Doesn't exist yet.
    if (!opts.create) {
      log(`[Codedeck] Session cwd does not exist: ${resolved} → using ${rootReal}`);
      return rootReal;
    }
  }

  // `create` is the "start a new project from the phone" path. Without it you could only ever root
  // a session in a directory that already existed, so a new project had to be created on the laptop
  // first — which defeats the point of starting one from the phone.
  //
  // It is `git init`-ed on creation, not left bare, because GSD's own new-project runs `git init`
  // when the directory isn't a repo — and doing that HERE, in a directory we just made, is safe,
  // whereas letting GSD do it at a multi-project root is the CD-056 hazard. It also means the
  // phone's Start GSD button (gated on `hasGit`) is live immediately instead of dead on arrival.
  try {
    fs.mkdirSync(resolved, { recursive: true });
    log(`[Codedeck] Created session cwd: ${resolved}`);
  } catch (e) {
    log(`[Codedeck] Could not create session cwd ${resolved}: ${e} → using ${rootReal}`);
    return rootReal;
  }
  try {
    if (!fs.existsSync(path.join(resolved, '.git'))) {
      execFileSync('git', ['-C', resolved, 'init', '--quiet'], { timeout: 10_000 });
      log(`[Codedeck] git init ${resolved}`);
    }
  } catch (e) {
    // A directory without a repo is still usable — GSD will just offer to init it itself.
    log(`[Codedeck] git init failed in ${resolved}: ${e} (continuing)`);
  }
  return resolved;
}

/** Directories that are never a project, only build/dependency noise. */
const FOLDER_SCAN_SKIP = new Set([
  'node_modules', 'target', 'dist', 'build', 'out', 'venv', '__pycache__', 'vendor',
]);

/** Bounds the session-list event: a workspace with a pathological number of folders must not
 *  bloat an event the phone needs for every session update. */
const FOLDER_SCAN_LIMIT = 200;

/** Manifests that mark a directory as a project in its own right. Deliberately build-file-ish:
 *  `src/`, `docs/` and friends carry none of these, a genuine project carries at least one.
 *  `.git` is NOT here on purpose — see PROJECT_MARKERS. */
const SELF_CONTAINED_MARKERS = [
  '.planning', 'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml',
  'pubspec.yaml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'Gemfile',
];

/** What makes a *nested* directory worth listing. A repo nested inside a container counts even
 *  without a build file — but being a repo says nothing about whether a folder is a container,
 *  because a monorepo of sub-projects (`nostr-relays`) is a repo too. */
const PROJECT_MARKERS = ['.git', ...SELF_CONTAINED_MARKERS];

/**
 * List the workspace's project folders for the phone's "Project folder" picker (CDB-035).
 *
 * The phone can't read this filesystem, so before this its picker was fed by the basenames of the
 * cwds of sessions already running — a one-entry list naming the workspace root, since that is
 * where every session started. Enumerating here is the only way the picker can name real projects.
 *
 * Returns paths relative to `root`, so every entry is directly usable as `create-session.cwd`
 * (`resolveSessionCwd` resolves nested relative paths and confines them to the root).
 *
 * Depth: every immediate child, plus one level deeper — but a nested directory is only listed when
 * it carries a project marker of its own. That is what separates `nostr-relays/rocket-relay` (a
 * real project, invisible to a depth-1 scan) from `some-app/src` (internals nobody roots a session
 * in). Being a git repo is not the test on either side: `nostr-relays` is itself a repo *and* a
 * container of five projects, and plenty of real projects here have no repo yet.
 */
export function listWorkspaceFolders(root: string, log: (m: string) => void = () => {}): string[] {
  const isProjectDir = (parent: string, entry: fs.Dirent): boolean => {
    if (entry.name.startsWith('.')) return false;          // dotfiles can't be picked anyway
    if (FOLDER_SCAN_SKIP.has(entry.name)) return false;
    if (entry.isDirectory()) return true;
    // Symlinked projects are common in a workspace; resolve them rather than dropping them.
    if (!entry.isSymbolicLink()) return false;
    try {
      return fs.statSync(path.join(parent, entry.name)).isDirectory();
    } catch {
      return false; // broken symlink
    }
  };

  const hasAny = (dir: string, markers: string[]): boolean =>
    markers.some((marker) => fs.existsSync(path.join(dir, marker)));

  try {
    const rootReal = path.resolve(root);
    const found: string[] = [];

    for (const entry of fs.readdirSync(rootReal, { withFileTypes: true })) {
      if (!isProjectDir(rootReal, entry)) continue;
      const childPath = path.join(rootReal, entry.name);
      found.push(entry.name);

      // A folder with its own build file IS the project — its subdirectories are modules of it
      // (`codedeck/src-tauri`), and listing them buries the folder people actually want.
      if (hasAny(childPath, SELF_CONTAINED_MARKERS)) continue;
      try {
        for (const nested of fs.readdirSync(childPath, { withFileTypes: true })) {
          if (!isProjectDir(childPath, nested)) continue;
          if (!hasAny(path.join(childPath, nested.name), PROJECT_MARKERS)) continue;
          found.push(`${entry.name}/${nested.name}`);
        }
      } catch {
        // Unreadable child — the parent is still listed, which is the useful part.
      }
    }

    found.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    if (found.length > FOLDER_SCAN_LIMIT) {
      log(`[Codedeck] Workspace has ${found.length} folders — listing the first ${FOLDER_SCAN_LIMIT}`);
      return found.slice(0, FOLDER_SCAN_LIMIT);
    }
    return found;
  } catch (e) {
    // An unreadable workspace must cost the picker its list, never a session.
    log(`[Codedeck] Could not list workspace folders in ${root}: ${e}`);
    return [];
  }
}
import type { EffortLevel, OutputEntry, RemoteSessionInfo, PairedPhone, UploadImageBlossomMessage, UploadImageChunkMessage } from './types';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';

export interface BridgeCoreConfig {
  secretKey: Uint8Array;
  relays: string[];
  machineName: string;
  pairedPhones: PairedPhone[];
  workspaceCwd?: string;
  lastSeenTimestamp?: number;
  /** Optional user-facing notice hook (wired to a VSCode toast in extension.ts). Used to surface
   *  mesh-onboarding outcomes (e.g. "test device authorized" / "start the nvpn service"). */
  onMeshNotice?: (level: 'info' | 'warn', message: string) => void;
}

/**
 * Core bridge that wires up Nostr relay ↔ SDK session manager.
 * Does not depend on VSCode APIs.
 */
interface ImageUploadTracker {
  sessionId: string;
  filename: string;
  mimeType: string;
  text: string;
  totalChunks: number;
  received: Map<number, string>;
  timeoutId: ReturnType<typeof setTimeout>;
}

export class BridgeCore {
  private static readonly IMAGE_ASSEMBLY_TIMEOUT_MS = 60_000;

  public readonly relay: NostrRelay;
  public readonly sdk: SdkSessionManager;
  private workspaceCwd: string;
  private imageChunks: Map<string, ImageUploadTracker> = new Map();
  private log: (msg: string) => void;
  private onMeshNotice?: (level: 'info' | 'warn', message: string) => void;
  // Folder scan cached across session-list publishes (heartbeat is every 60s, and a session change
  // republishes too). Folders change on the timescale of starting a project, not of a heartbeat.
  private static readonly FOLDER_CACHE_TTL_MS = 30_000;
  private folderCache: { folders: string[]; at: number } | null = null;

  constructor(config: BridgeCoreConfig, log: (msg: string) => void = console.log) {
    this.workspaceCwd = config.workspaceCwd ?? '';
    this.log = log;
    this.onMeshNotice = config.onMeshNotice;

    // --- SDK Session Manager ---
    this.sdk = new SdkSessionManager({
      onOutput: (sessionId, entries) => {
        this.relay.publishOutput(sessionId, entries).catch(err => {
          console.error('[Codedeck] Failed to publish output:', err);
        });
      },
      onPermissionRequest: (request) => {
        // Emit permission card to phone via a system entry with special metadata
        const entry: OutputEntry = {
          entryType: 'system',
          content: request.title || `Permission needed: ${request.toolName}`,
          timestamp: new Date().toISOString(),
          metadata: {
            special: 'permission_request',
            tool_name: request.toolName,
            tool_use_id: request.toolUseId,
            tool_input: request.toolInput,
            description: request.description,
            subagent: request.isSubAgent || undefined,
            agent_id: request.agentId,
            agent_label: request.agentLabel,
          },
        };
        // Unique per-session seq (CDB-025): a constant seq collides with the phone's per-seq
        // dedup, so a session's 2nd+ permission card would be dropped → "waiting" pill with no
        // tappable card → wedged turn.
        this.relay.publishOutput(request.sessionId, [{ seq: this.sdk.nextSeq(request.sessionId), entry }]).catch(err => {
          console.error('[Codedeck] Failed to publish permission request:', err);
        });
      },
      onAskQuestion: (_sessionId, _toolUseId, _questions) => {
        // AskUserQuestion entries are already emitted by sdkAdapter in the
        // assistant message output stream — no extra action needed here.
      },
      onAutoModeChange: (sessionId, mode) => {
        this.relay.publishModeConfirmed(sessionId, mode).catch(err => {
          log(`[Codedeck] Failed to publish auto mode-confirmed: ${err}`);
        });
      },
      onSessionListChanged: (sessions) => {
        this.relay.publishSessionList(sessions).catch(err => {
          console.error('[Codedeck] Failed to publish session list:', err);
        });
      },
      onSessionEnded: (sessionId) => {
        log(`[Codedeck] Session ${sessionId} ended`);
      },
      onAuthError: (sessionId, error) => {
        log(`[Codedeck] AUTH ERROR for session ${sessionId}: ${error}`);
        // Emit error to phone so user sees a clear message
        const entry: OutputEntry = {
          entryType: 'error',
          content: `Authentication failed: ${error}`,
          timestamp: new Date().toISOString(),
          metadata: { special: 'auth_error' },
        };
        this.relay.publishOutput(sessionId, [{ seq: this.sdk.nextSeq(sessionId), entry }]).catch(err => {
          console.error('[Codedeck] Failed to publish auth error:', err);
        });
        this.relay.publishSessionFailed(sessionId, 'auth-failed').catch(err => {
          console.error('[Codedeck] Failed to publish session-failed:', err);
        });
      },
      onAuthSuccess: (sessionId, info) => {
        log(`[Codedeck] Session ${sessionId} authenticated: ${info.model} via ${info.apiKeySource} (v${info.version})`);
      },
      log,
    });

    // Deliver device screenshots (captured by the test-session MCP tools) to the phone inline.
    // Downscales then publishes as a tool_result output entry with an image data-URI in metadata.
    this.sdk.onDeviceScreenshot = async (sessionId, artifactPath, serial) => {
      const built = buildScreenshotEntry(artifactPath, serial);
      if (!built) return 'capture saved but image could not be read';
      await this.relay.publishOutput(sessionId, [{ seq: this.sdk.nextSeq(sessionId), entry: built.entry as OutputEntry }]).catch((err) => {
        console.error('[Codedeck] Failed to publish screenshot:', err);
      });
      // Best-effort cleanup of the on-disk artifact (it's already delivered).
      try { require('fs').unlinkSync(artifactPath); } catch { /* ignore */ }
      return `delivered to phone (${Math.round(built.sizeBytes / 1024)} KB)`;
    };

    // --- Nostr relay events (phone → bridge) ---
    const relayEvents: NostrRelayEvents = {
      onInput: async (sessionId, text, _phonePubkey) => {
        log(`[Codedeck] Input for session ${sessionId}: ${text.slice(0, 50)}...`);
        const sent = this.sdk.sendInput(sessionId, text);
        if (!sent) {
          log(`[Codedeck] No SDK session for ${sessionId}`);
          this.relay.publishInputFailed(sessionId, 'no-terminal').catch(err => {
            console.error('[Codedeck] Failed to publish input-failed:', err);
          });
        }
      },
      onQuestionInput: async (sessionId, text, _optionCount, _phonePubkey) => {
        log(`[Codedeck] Question input for session ${sessionId}: ${text.slice(0, 50)}...`);
        // With the SDK, question answers go through the same input channel.
        // The SDK handles routing it to the pending AskUserQuestion tool.
        const sent = this.sdk.sendQuestionInput(sessionId, text);
        if (!sent) {
          this.relay.publishInputFailed(sessionId, 'no-terminal').catch(err => {
            console.error('[Codedeck] Failed to publish input-failed:', err);
          });
        }
      },
      onCreateSession: async (defaultEffort?, model?, testSession?, requestedCwd?, createCwd?) => {
        const sessionId = crypto.randomUUID();
        const effort = defaultEffort as EffortLevel | undefined;
        log(`[Codedeck] Create session request — spawning SDK session ${sessionId}${effort ? ` (effort: ${effort})` : ''}${model ? ` (model: ${model})` : ''}${testSession ? ' [test session: device tools enabled]' : ''}${requestedCwd ? ` (cwd: ${requestedCwd})` : ''}`);

        try {
          const root = this.workspaceCwd || process.cwd();
          const cwd = resolveSessionCwd(root, requestedCwd, log, { create: !!createCwd });
          // A folder just created from the phone should appear in the picker on the next publish,
          // not up to a cache TTL later — that gap is exactly when the user goes looking for it.
          if (createCwd) this.folderCache = null;
          // Apply model + effort at query() construction so 'max'/'xhigh' take effect from the first turn.
          // testSession attaches the on-device adb MCP tools (Phase 2.3).
          this.sdk.createSession(sessionId, cwd, 'plan', model, effort, { testSession: !!testSession });

          // Publish session-pending so the phone creates a placeholder
          await this.relay.publishSessionPending(sessionId);

          // Brief delay for relay rate-limiting
          await new Promise(resolve => setTimeout(resolve, 1_000));

          // Build session info, seeding the effort/model the session was born with
          const project = cwd.split('/').pop() || cwd;
          const session: RemoteSessionInfo = {
            id: sessionId,
            cwd,
            slug: `session-${sessionId.slice(0, 8)}`,
            lastActivity: new Date().toISOString(),
            lineCount: 0,
            title: null,
            project,
            permissionMode: 'plan',
            effortLevel: effort,
            model,
          };

          // Publish session-ready
          log(`[Codedeck] Publishing session-ready for ${sessionId}`);
          const success = await this.relay.publishSessionReady(sessionId, session);
          if (!success) {
            log(`[Codedeck] WARNING: session-ready for ${sessionId} failed on all relays`);
          }
        } catch (err) {
          log(`[Codedeck] Session creation failed for ${sessionId}: ${err}`);
          await this.relay.publishSessionFailed(sessionId, 'terminal-failed');
        }
      },
      onPermissionResponse: async (sessionId, requestId, allow, modifier) => {
        log(`[Codedeck] Permission response for ${sessionId}: ${allow ? 'allow' : 'deny'}${modifier ? ` (${modifier})` : ''}`);
        this.sdk.resolvePermission(sessionId, requestId, allow, modifier);
      },
      onKeypress: async (sessionId, key, context?) => {
        log(`[Codedeck] Keypress for session ${sessionId}: ${key}${context ? ` (context: ${context})` : ''}`);

        // Plan approval: resolve the pending ExitPlanMode tool permission,
        // then set the appropriate mode for subsequent tools.
        if (context === 'plan-approval') {
          switch (key) {
            case '1': {
              // Approve plan + auto-accept edits
              const tid1 = this.sdk.findPendingPermission(sessionId, 'ExitPlanMode');
              if (tid1) this.sdk.resolvePermission(sessionId, tid1, true);
              await this.sdk.setPermissionMode(sessionId, 'acceptEdits');
              this.relay.publishModeConfirmed(sessionId, 'acceptEdits').catch(err => {
                log(`[Codedeck] Failed to publish mode-confirmed: ${err}`);
              });
              break;
            }
            case '2': {
              // Approve plan + manual edits
              const tid2 = this.sdk.findPendingPermission(sessionId, 'ExitPlanMode');
              if (tid2) this.sdk.resolvePermission(sessionId, tid2, true);
              await this.sdk.setPermissionMode(sessionId, 'default');
              this.relay.publishModeConfirmed(sessionId, 'default').catch(err => {
                log(`[Codedeck] Failed to publish mode-confirmed: ${err}`);
              });
              break;
            }
            case '3': {
              // Revise plan — deny ExitPlanMode so Claude stays in plan mode.
              // The user's revision text will arrive as the next input message.
              const toolUseId = this.sdk.findPendingPermission(sessionId, 'ExitPlanMode');
              if (toolUseId) {
                this.sdk.resolvePermission(sessionId, toolUseId, false);
              }
              break;
            }
          }
        }
        // Question option selection: map keypress number → option label → sendInput
        if (context === 'question') {
          const sent = this.sdk.resolveQuestionKeypress(sessionId, key);
          if (!sent) {
            log(`[Codedeck] No pending question for keypress '${key}' in ${sessionId}`);
          }
        }

        // Exit plan mode (plan-less ExitPlanMode): resolve the pending ExitPlanMode permission
        // ourselves — the generic permission card is suppressed for ExitPlanMode, so this card
        // is the only thing that can resolve the SDK promise (mirrors the 'plan-approval' path).
        if (context === 'exit-plan') {
          const tid = this.sdk.findPendingPermission(sessionId, 'ExitPlanMode');
          if (key === '1') {
            // Yes — exit plan mode
            if (tid) this.sdk.resolvePermission(sessionId, tid, true);
            await this.sdk.setPermissionMode(sessionId, 'default');
            this.relay.publishModeConfirmed(sessionId, 'default').catch(err => {
              log(`[Codedeck] Failed to publish mode-confirmed: ${err}`);
            });
          } else if (key === '2') {
            // No — stay in plan mode (deny ExitPlanMode so the SDK promise resolves)
            if (tid) this.sdk.resolvePermission(sessionId, tid, false);
          }
        }
      },
      onModeChange: async (sessionId, mode) => {
        log(`[Codedeck] Mode change for session ${sessionId}: ${mode}`);
        const sdkMode = (mode === 'bypassPermissions' ? 'default' : mode) as PermissionMode;
        const success = await this.sdk.setPermissionMode(sessionId, sdkMode);
        if (success) {
          this.relay.publishModeConfirmed(sessionId, mode).catch(err => {
            log(`[Codedeck] Failed to publish mode-confirmed: ${err}`);
          });
        }
      },
      onEffortChange: async (sessionId, effort) => {
        log(`[Codedeck] Effort change for session ${sessionId}: ${effort}`);
        const { confirmedLevel } = await this.sdk.setEffortLevel(sessionId, effort);
        // Always confirm back so the phone UI stays in sync, even if the level was unsupported
        this.relay.publishEffortConfirmed(sessionId, confirmedLevel).catch(err => {
          log(`[Codedeck] Failed to publish effort-confirmed: ${err}`);
        });
      },
      onModelChange: async (sessionId, model) => {
        log(`[Codedeck] Model change for session ${sessionId}: ${model}`);
        const { confirmedModel } = await this.sdk.setModel(sessionId, model);
        // Always confirm back so the phone UI stays in sync, even if the change failed
        this.relay.publishModelConfirmed(sessionId, confirmedModel).catch(err => {
          log(`[Codedeck] Failed to publish model-confirmed: ${err}`);
        });
      },
      onUsageRequest: async (sessionId) => {
        const usage = await this.sdk.getUsage(sessionId);
        // Unsupported SDK / non-subscription / fetch failure → publish nothing; phone keeps last value.
        if (!usage) { return; }
        this.relay.publishUsage(sessionId, usage).catch(err => {
          log(`[Codedeck] Failed to publish usage: ${err}`);
        });
      },
      onGsdRequest: async (sessionId) => {
        const cwd = this.sdk.getSessionCwd(sessionId);
        if (!cwd) { return; }
        // Always publishes, including `available: false`, so the phone can retire a stale strip
        // when a session moves off a GSD project (or GSD gets uninstalled mid-session).
        const gsd = await getGsdState(cwd);
        this.relay.publishGsdState(sessionId, gsd).catch(err => {
          log(`[Codedeck] Failed to publish gsd-state: ${err}`);
        });
      },
      onHistoryRequest: async (sessionId, afterSeq, _phonePubkey) => {
        log(`[Codedeck] History request for ${sessionId} (afterSeq: ${afterSeq})`);

        // Try in-memory history first
        let entries = this.sdk.getHistory(sessionId, afterSeq);

        // Fall back to persisted JSONL history if memory is empty
        if (entries.length === 0 && (afterSeq === undefined || afterSeq === 0)) {
          log(`[Codedeck] No in-memory history for ${sessionId} — loading from disk`);
          entries = await this.sdk.getPersistedHistory(sessionId, this.workspaceCwd || undefined);
        }

        const totalEntries = entries.length || this.sdk.getHistoryCount(sessionId);
        log(`[Codedeck] Sending ${entries.length} history entries (total: ${totalEntries}) for ${sessionId}`);
        this.relay.publishHistory(_phonePubkey, sessionId, entries, totalEntries).catch(err => {
          console.error('[Codedeck] Failed to publish history:', err);
        });
      },
      onRefreshSessions: () => {
        log('[Codedeck] Refresh sessions request');
        const sessions = this.sdk.getSessions();
        this.relay.publishSessionList(sessions).catch(err => {
          console.error('[Codedeck] Failed to publish session list:', err);
        });
      },
      onInterrupt: (sessionId) => {
        log(`[Codedeck] Interrupt request for session ${sessionId}`);
        this.sdk.interruptSession(sessionId);
      },
      onCloseSession: async (sessionId) => {
        log(`[Codedeck] Close session request for ${sessionId}`);
        const found = this.sdk.closeSession(sessionId);
        // Re-publish session list
        const sessions = this.sdk.getSessions();
        this.relay.publishSessionList(sessions).catch(err => {
          console.error('[Codedeck] Failed to publish session list:', err);
        });
        this.relay.publishCloseSessionAck(sessionId, found).catch(err => {
          console.error('[Codedeck] Failed to publish close-session-ack:', err);
        });
      },
      onUploadImage: (msg, _phonePubkey) => {
        if ('hash' in msg) {
          this.handleBlossomImage(msg as UploadImageBlossomMessage);
        } else {
          const chunk = msg as UploadImageChunkMessage;
          this.handleImageChunk(chunk.sessionId, chunk.uploadId, chunk.filename, chunk.mimeType, chunk.base64Data, chunk.text, chunk.chunkIndex, chunk.totalChunks);
        }
      },
      onSetDeviceConfig: (deviceConfig, phonePubkey) => {
        this.handleSetDeviceConfig(deviceConfig, phonePubkey).catch(err => {
          log(`[Codedeck] set-device-config handler error: ${err}`);
        });
      },
    };

    this.relay = new NostrRelay(
      config.secretKey,
      config.relays,
      config.pairedPhones,
      config.machineName,
      relayEvents,
      log,
      config.lastSeenTimestamp,
    );

    // The relay publishes the session list from four different places (heartbeat, session changes,
    // …), none of which knows about the filesystem — so it pulls the folder list at publish time
    // instead of every caller having to carry one (CDB-035).
    this.relay.setFolderProvider(() => this.workspaceFolders());
  }

  /** Workspace project folders for the phone's picker, memoized (see FOLDER_CACHE_TTL_MS). */
  private workspaceFolders(): string[] {
    const now = Date.now();
    if (this.folderCache && now - this.folderCache.at < BridgeCore.FOLDER_CACHE_TTL_MS) {
      return this.folderCache.folders;
    }
    const folders = listWorkspaceFolders(this.workspaceCwd || process.cwd(), this.log);
    this.folderCache = { folders, at: now };
    return folders;
  }

  /** Connect to Nostr relays if phones are paired. */
  connect(): void {
    this.relay.connect();
  }

  /** Disconnect from Nostr relays. */
  disconnect(): void {
    this.relay.disconnect();
  }

  /** Dispose all resources. */
  dispose(): void {
    this.sdk.dispose();
    this.relay.dispose();
  }

  // --- Test-device config + mesh onboarding ---

  /**
   * Handle a `set-device-config` from the phone. For a 'test-target' phone this is also where the
   * bridge does the formerly-manual mesh onboarding, with ZERO operator/CLI involvement.
   *
   * IMPORTANT: the phone's mesh VpnService runs its OWN nostr key, separate from the bridge-pairing
   * key — so the bridge canNOT derive the phone's mesh IP from the pairing pubkey. The phone reports
   * its real mesh identity (`meshIp` + `meshPubkey`, read from the engine's own state). The bridge:
   *   1. Authorizes the reported MESH pubkey on the roster (`nvpn add-participant`) — idempotent.
   *   2. Sets the adb serial to `<meshIp>:0` (port 0 → deviceActions.ensureConnected/discoverAdbPort
   *      sweeps for the rotating Wireless-Debugging port at connect time). No mesh IP:port typed.
   *   3. Warns if the local nvpn daemon is down (roster change won't propagate).
   * Then persist to .codedeck/device-config.json so the autonomous test-session can read it.
   */
  private async handleSetDeviceConfig(
    deviceConfig: import('./types').DeviceConfig,
    phonePubkey: string,
  ): Promise<void> {
    const config = { ...deviceConfig };

    if (config.role === 'test-target') {
      const label = config.label || 'phone';
      // The identity to authorize on the mesh is the phone's MESH pubkey (reported), NOT the
      // bridge-pairing pubkey. Fall back to the pairing pubkey only if the phone didn't report one
      // (older app) — though that will only be correct if the two keys happen to coincide.
      const meshPubkey = config.meshPubkey || phonePubkey;
      if (!config.meshPubkey) {
        this.log('[Codedeck] Phone did not report a mesh pubkey — falling back to the pairing pubkey (may be wrong)');
      }

      // 1. Authorize on the mesh roster (best-effort; idempotent).
      const authorized = await meshAdmin.addParticipant(meshPubkey);
      if (authorized) {
        this.log(`[Codedeck] Authorized test device on mesh roster: ${meshPubkey.slice(0, 12)}…`);
        if (await meshAdmin.daemonRunning()) {
          this.onMeshNotice?.('info', `Test device "${label}" authorized on the mesh.`);
        } else {
          this.onMeshNotice?.(
            'warn',
            `Mesh roster updated for "${label}", but the nvpn service isn't running — start it on this laptop to finish authorizing the device.`,
          );
        }
      } else {
        this.log('[Codedeck] add-participant failed or nvpn unavailable — test device not authorized on mesh');
        this.onMeshNotice?.('warn', `Couldn't authorize "${label}" on the mesh (is nvpn installed and a network active?).`);
      }

      // 2. Build the adb serial from the phone's REAL reported mesh IP (authoritative).
      if (!config.serial && config.meshIp && /^10\.44\.\d{1,3}\.\d{1,3}$/.test(config.meshIp)) {
        config.serial = `${config.meshIp}:0`; // port 0 → discoverAdbPort sweeps for the live WD port
        this.log(`[Codedeck] Test-device mesh serial (phone-reported): ${config.serial}`);
      } else if (!config.serial) {
        // Legacy fallback: derive from the pairing pubkey (only correct if mesh key == pairing key).
        const ip = await meshAdmin.derivePeerIp(meshPubkey);
        if (ip) {
          config.serial = `${ip}:0`;
          this.log(`[Codedeck] Test-device mesh serial (derived fallback): ${config.serial}`);
        } else {
          this.log('[Codedeck] No mesh IP reported and could not derive one — serial left unset');
        }
      }
    }

    // Strip transport-only fields before persisting — device-config.json is consumed by the
    // test-session and only needs label/serial/app; meshIp/meshPubkey were inputs, not config.
    const { meshIp: _mi, meshPubkey: _mp, ...persisted } = config;

    try {
      const dir = path.join(this.workspaceCwd || '.', '.codedeck');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'device-config.json'), JSON.stringify(persisted, null, 2));
      this.log(`[Codedeck] Device config saved: ${persisted.label} (${persisted.serial ?? 'no serial'}, app=${persisted.appUnderTest}, role=${persisted.role ?? 'controller'})`);
    } catch (err) {
      this.log(`[Codedeck] Failed to save device config: ${err}`);
    }
  }

  // --- Image upload: Blossom (encrypted blob) ---

  private async handleBlossomImage(msg: UploadImageBlossomMessage): Promise<void> {
    this.log(`[Codedeck] Blossom image: downloading ${msg.url} (${msg.sizeBytes} bytes)`);

    try {
      const response = await fetch(msg.url);
      if (!response.ok) {
        throw new Error(`Blossom download failed: ${response.status} ${response.statusText}`);
      }
      const encryptedBytes = new Uint8Array(await response.arrayBuffer());

      const hashBuffer = crypto.createHash('sha256').update(encryptedBytes).digest();
      const hashHex = hashBuffer.toString('hex');
      if (hashHex !== msg.hash) {
        throw new Error(`Hash mismatch: expected ${msg.hash}, got ${hashHex}`);
      }

      const key = Buffer.from(msg.key, 'hex');
      const iv = Buffer.from(msg.iv, 'hex');
      const authTag = encryptedBytes.slice(-16);
      const ciphertext = encryptedBytes.slice(0, -16);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

      const uploadsDir = path.join(this.workspaceCwd || '.', '.codedeck', 'uploads');
      fs.mkdirSync(uploadsDir, { recursive: true });

      const safeName = msg.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const ext = msg.mimeType === 'image/png' ? '.png' : '.jpg';
      const timestamp = Date.now();
      const hasExt = safeName.toLowerCase().endsWith(ext);
      const finalName = `${timestamp}-${safeName}${hasExt ? '' : ext}`;
      const filePath = path.join(uploadsDir, finalName);

      fs.writeFileSync(filePath, decrypted);
      this.log(`[Codedeck] Blossom image saved: ${filePath} (${decrypted.length} bytes)`);

      const userText = msg.text.trim();
      const terminalText = userText
        ? `${userText}\n\n[Attached image: ${filePath} — use the Read tool to view it]`
        : `Please examine this image: ${filePath}`;

      const sent = this.sdk.sendInput(msg.sessionId, terminalText);
      if (!sent) {
        this.log(`[Codedeck] No SDK session for image upload to ${msg.sessionId}`);
      }
    } catch (err) {
      this.log(`[Codedeck] Blossom image download/decrypt failed: ${err}`);
    }
  }

  // --- Image upload chunk assembly (legacy) ---

  private handleImageChunk(
    sessionId: string, uploadId: string, filename: string, mimeType: string,
    base64Data: string, text: string, chunkIndex: number, totalChunks: number,
  ): void {
    let tracker = this.imageChunks.get(uploadId);

    if (!tracker) {
      const timeoutId = setTimeout(() => {
        const t = this.imageChunks.get(uploadId);
        this.log(`[Codedeck] Image upload ${uploadId} timed out (received ${t?.received.size ?? 0}/${totalChunks} chunks)`);
        this.imageChunks.delete(uploadId);
      }, BridgeCore.IMAGE_ASSEMBLY_TIMEOUT_MS);

      tracker = { sessionId, filename, mimeType, text, totalChunks, received: new Map(), timeoutId };
      this.imageChunks.set(uploadId, tracker);
    }

    if (chunkIndex < 0 || chunkIndex >= totalChunks) {
      this.log(`[Codedeck] Image chunk ${chunkIndex} out of range [0, ${totalChunks}) — skipping`);
      return;
    }
    tracker.received.set(chunkIndex, base64Data);
    if (chunkIndex === 0 && text) {
      tracker.text = text;
    }

    this.log(`[Codedeck] Image chunk ${chunkIndex + 1}/${totalChunks} for upload ${uploadId}`);

    if (tracker.received.size >= totalChunks) {
      clearTimeout(tracker.timeoutId);
      this.imageChunks.delete(uploadId);
      this.assembleAndWriteImage(tracker);
    }
  }

  private async assembleAndWriteImage(tracker: ImageUploadTracker): Promise<void> {
    const parts: string[] = [];
    for (let i = 0; i < tracker.totalChunks; i++) {
      const chunk = tracker.received.get(i);
      if (chunk === undefined) {
        this.log(`[Codedeck] Missing chunk ${i} for image upload — aborting`);
        return;
      }
      parts.push(chunk);
    }
    const fullBase64 = parts.join('');

    const uploadsDir = path.join(this.workspaceCwd || '.', '.codedeck', 'uploads');
    try {
      fs.mkdirSync(uploadsDir, { recursive: true });
    } catch (err) {
      this.log(`[Codedeck] Failed to create uploads dir: ${err}`);
      return;
    }

    const safeName = tracker.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const ext = tracker.mimeType === 'image/png' ? '.png' : '.jpg';
    const timestamp = Date.now();
    const hasExt = safeName.toLowerCase().endsWith(ext);
    const finalName = `${timestamp}-${safeName}${hasExt ? '' : ext}`;
    const filePath = path.join(uploadsDir, finalName);

    try {
      const buffer = Buffer.from(fullBase64, 'base64');
      fs.writeFileSync(filePath, buffer);
      this.log(`[Codedeck] Image saved: ${filePath} (${buffer.length} bytes)`);
    } catch (err) {
      this.log(`[Codedeck] Failed to write image: ${err}`);
      return;
    }

    const userText = tracker.text.trim();
    const terminalText = userText
      ? `${userText}\n\n[Attached image: ${filePath} — use the Read tool to view it]`
      : `Please examine this image: ${filePath}`;

    const sent = this.sdk.sendInput(tracker.sessionId, terminalText);
    if (!sent) {
      this.log(`[Codedeck] No SDK session for image upload to ${tracker.sessionId}`);
    }
  }
}
