/**
 * Shared types for the Codedeck Bridge protocol.
 *
 * These types define the message format exchanged between the VSCode extension
 * (bridge) and the Codedeck mobile app over Nostr relays.
 */

// --- Session Discovery ---

export interface RemoteSessionInfo {
  id: string;
  slug: string;
  cwd: string;
  lastActivity: string;
  lineCount: number;
  title: string | null;
  project: string;
  hasTerminal?: boolean;
  permissionMode?: PermissionMode;
  effortLevel?: EffortLevel;
  model?: string;
  committed?: boolean;
  state?: 'idle' | 'running' | 'waiting_permission' | 'waiting_question';
}

export interface AuthStatus {
  hasAnthropicKey: boolean;
  hasGithubPat: boolean;
  hasEnvKey: boolean;
}

export interface SessionListMessage {
  type: 'sessions';
  machine: string;
  sessions: RemoteSessionInfo[];
  authStatus?: AuthStatus;
  /** Bridge protocol version (see PROTOCOL_VERSION). Absent → pre-v1 bridge with no model support. */
  protocolVersion?: number;
}

// --- Output Relay (bridge → phone) ---

export type OutputEntryType = 'text' | 'tool_use' | 'tool_result' | 'system' | 'error' | 'progress';

export interface OutputEntry {
  entryType: OutputEntryType;
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface OutputMessage {
  type: 'output';
  sessionId: string;
  seq: number;
  entry: OutputEntry;
}

// --- Input (phone → bridge) ---

export interface InputMessage {
  type: 'input';
  sessionId: string;
  text: string;
}

/** Free-text answer to a pending AskUserQuestion. The bridge selects the
 *  "Type something" Ink TUI option (keypress optionCount+1), waits for the
 *  mode switch, then sends the text directly (no Escape workaround). */
export interface QuestionInputMessage {
  type: 'question-input';
  sessionId: string;
  text: string;
  optionCount: number;
}

export interface PermissionResponseMessage {
  type: 'permission-res';
  sessionId: string;
  requestId: string;
  allow: boolean;
  /** Optional modifier: 'always' → always allow this tool, 'never' → don't ask again (deny). */
  modifier?: 'always' | 'never';
}

/** Single raw keypress for Claude Code's Ink TUI prompts (plan approval, question selection). */
export interface KeypressMessage {
  type: 'keypress';
  sessionId: string;
  key: string;
  context?: 'plan-approval' | 'question';
}

export type PermissionMode = 'default' | 'acceptEdits' | 'plan';

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';

export interface ModeChangeMessage {
  type: 'mode';
  sessionId: string;
  mode: PermissionMode;
}

export interface EffortChangeMessage {
  type: 'effort';
  sessionId: string;
  level: EffortLevel;
}

export interface ModelChangeMessage {
  type: 'model';
  sessionId: string;
  model: string;
}

// --- History catch-up (phone → bridge → phone) ---

export interface HistoryRequestMessage {
  type: 'history-request';
  sessionId: string;
  afterSeq?: number; // resume from this seq, or 0/undefined for full history
}

export interface HistoryResponseMessage {
  type: 'history';
  sessionId: string;
  entries: Array<{ seq: number; entry: OutputEntry }>;
  totalEntries: number;
  fromSeq: number;
  toSeq: number;
  chunkIndex: number;   // 0-based index of this chunk
  totalChunks: number;  // total number of chunks in this response
  requestId: string;    // unique ID to correlate chunks from the same request
}

// --- Session creation (phone → bridge) ---

export interface CreateSessionMessage {
  type: 'create-session';
  /** Initial effort level for the new session (applied at query() construction). */
  defaultEffort?: EffortLevel;
  /** Claude model ID for the new session (e.g. 'claude-opus-4-8'). */
  model?: string;
  /**
   * When true, attach the on-device test MCP tools (adb install/launch/logcat/screenshot/tap/...)
   * to this session. Only test sessions get device control; normal coding sessions do not.
   */
  testSession?: boolean;
}

// --- Refresh sessions (phone → bridge) ---

export interface RefreshSessionsMessage {
  type: 'refresh-sessions';
}

// --- Close session (phone → bridge) ---

export interface CloseSessionMessage {
  type: 'close-session';
  sessionId: string;
}

// --- Image upload (phone → bridge) ---

/** Legacy chunked upload (pre-Blossom) */
export interface UploadImageChunkMessage {
  type: 'upload-image';
  sessionId: string;
  uploadId: string;
  filename: string;
  mimeType: string;
  base64Data: string;
  text: string;
  chunkIndex: number;
  totalChunks: number;
}

/** Blossom upload — single event with hash reference to AES-256-GCM encrypted blob */
export interface UploadImageBlossomMessage {
  type: 'upload-image';
  sessionId: string;
  hash: string;
  url: string;
  key: string;
  iv: string;
  filename: string;
  mimeType: string;
  text: string;
  sizeBytes: number;
}

export type UploadImageMessage = UploadImageChunkMessage | UploadImageBlossomMessage;

// --- Two-phase session creation (bridge → phone) ---

export interface SessionPendingMessage {
  type: 'session-pending';
  pendingId: string;    // bridge-generated UUID
  machine: string;
  createdAt: string;    // ISO timestamp
}

export interface SessionReadyMessage {
  type: 'session-ready';
  pendingId: string;
  session: RemoteSessionInfo;
}

export interface SessionFailedMessage {
  type: 'session-failed';
  pendingId: string;
  reason: string;       // 'timeout' | 'terminal-failed'
}

// --- Input delivery feedback (bridge → phone) ---

export interface InputFailedMessage {
  type: 'input-failed';
  sessionId: string;
  reason: 'no-terminal' | 'expired';
}

// --- Close session acknowledgment (bridge → phone) ---

export interface CloseSessionAckMessage {
  type: 'close-session-ack';
  sessionId: string;
  success: boolean;
}

// --- Session replacement (bridge → phone) ---

export interface SessionReplacedMessage {
  type: 'session-replaced';
  oldSessionId: string;
  newSession: RemoteSessionInfo;
}

// --- Mode confirmation (bridge → phone) ---

export interface ModeConfirmedMessage {
  type: 'mode-confirmed';
  sessionId: string;
  mode: PermissionMode;
}

export interface EffortConfirmedMessage {
  type: 'effort-confirmed';
  sessionId: string;
  level: EffortLevel;
}

export interface ModelConfirmedMessage {
  type: 'model-confirmed';
  sessionId: string;
  model: string;
}

export interface InterruptMessage {
  type: 'interrupt';
  sessionId: string;
}

// --- Subscription usage / rate-limit windows ---

/** A single claude.ai plan rate-limit window. `utilization` is 0-100 (percent of
 *  the window consumed); `resetsAt` is an ISO 8601 timestamp. Either may be null
 *  when the SDK reports the window but not its value. */
export interface UsageWindow {
  utilization: number | null;
  resetsAt: string | null;
}

/** Normalized subscription usage snapshot — the bridge-friendly projection of the
 *  Agent SDK's structured `/usage` response. We deliberately forward only the fields
 *  the phone renders (not the raw, experimental SDK shape) to keep the protocol stable. */
export interface UsageData {
  /** Mirrors SDK `rate_limits_available`. False for API-key / Bedrock / Vertex sessions. */
  available: boolean;
  /** 'pro' | 'max' | 'team' | 'enterprise' or null for non-subscription sessions. */
  subscriptionType: string | null;
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  sevenDayOpus?: UsageWindow;
  sevenDaySonnet?: UsageWindow;
  /** Accumulated cost of the current session in USD, when reported. */
  sessionCostUsd?: number;
  /** ISO timestamp (bridge clock) of when this snapshot was fetched — for "as of" + staleness. */
  fetchedAt: string;
}

/** Phone → bridge: request a fresh usage snapshot for a session. */
export interface UsageRequestMessage {
  type: 'usage-request';
  sessionId: string;
}

/** Bridge → phone: usage snapshot for a session. */
export interface UsageMessage {
  type: 'usage';
  sessionId: string;
  usage: UsageData;
}

// --- Credentials (phone → bridge) ---

export interface SetCredentialsMessage {
  type: 'set-credentials';
  anthropicApiKey?: string | null;
  githubPat?: string | null;
}

/** Test-device config sent from the phone (mirrors codedeck/src/types.ts DeviceConfig). */
export interface DeviceConfig {
  label: string;
  /** Device role. 'test-target' phones get auto-authorized on the mesh and their adb serial is
   *  derived bridge-side from their pubkey. Absent/'controller' means a normal control phone. */
  role?: 'controller' | 'test-target';
  /** adb serial (mesh ip:port). Optional: a 'test-target' phone reports its real mesh IP via
   *  `meshIp` and the bridge builds the serial as `<meshIp>:0` (port 0 → adb port discovery). */
  serial?: string;
  /** The phone's REAL mesh tunnel IP (the mesh engine has its own key, separate from the pairing
   *  key, so the bridge canNOT derive this from the pairing pubkey — the phone reports it). */
  meshIp?: string;
  /** The phone's MESH-engine pubkey (hex) — the identity to authorize on the mesh roster. */
  meshPubkey?: string;
  appUnderTest: 'kubo' | 'veil' | 'custom';
  customPackage?: string;
  customBuildCmd?: string;
  projectDir?: string;
}

export interface SetDeviceConfigMessage {
  type: 'set-device-config';
  config: DeviceConfig;
}

export interface DeviceConfigAckMessage {
  type: 'device-config-ack';
  success: boolean;
  reachable?: boolean;
  error?: string;
}

export interface CredentialsAckMessage {
  type: 'credentials-ack';
  machine: string;
  success: boolean;
  hasAnthropicKey: boolean;
  hasGithubPat: boolean;
  keyValid?: boolean;
  error?: string;
}

// --- Auto-pairing handshake ---

/** Phone → bridge: request to pair, sent right after the phone ingests the QR
 *  deep-link. Carries the phone's own identity plus the one-time token embedded
 *  in this pairing session's QR. Only accepted while a pairing window is open. */
export interface PairRequestMessage {
  type: 'pair-request';
  npub: string;
  pubkeyHex: string;
  label: string;   // device label, e.g. "Codedeck Phone"
  token: string;   // one-time token echoed from the QR
}

/** Bridge → phone: pairing result. */
export interface PairAckMessage {
  type: 'pair-ack';
  machine: string;
  ok: boolean;
  reason?: 'bad-token' | 'window-closed';
}

// --- Union ---

export type BridgeOutbound = SessionListMessage | OutputMessage | HistoryResponseMessage | SessionPendingMessage | SessionReadyMessage | SessionFailedMessage | InputFailedMessage | CloseSessionAckMessage | SessionReplacedMessage | ModeConfirmedMessage | EffortConfirmedMessage | ModelConfirmedMessage | UsageMessage | CredentialsAckMessage | PairAckMessage;
export type BridgeInbound = InputMessage | QuestionInputMessage | PermissionResponseMessage | KeypressMessage | ModeChangeMessage | EffortChangeMessage | ModelChangeMessage | HistoryRequestMessage | CreateSessionMessage | RefreshSessionsMessage | CloseSessionMessage | UploadImageMessage | InterruptMessage | UsageRequestMessage | SetCredentialsMessage | SetDeviceConfigMessage | PairRequestMessage;
export type BridgeMessage = BridgeOutbound | BridgeInbound;

/**
 * Bridge protocol version, advertised on the session list message.
 * v1 = supports per-session model selection (`model` / `model-confirmed`) and the widened
 * effort set (`xhigh`). v2 = supports the auto-pairing handshake (`pair-request` / `pair-ack`).
 * v3 = supports subscription usage snapshots (`usage-request` / `usage`).
 * A phone uses this to gate features against older bridges.
 */
export const PROTOCOL_VERSION = 3;

// --- Nostr event kinds ---

/** Replaceable event kind for session list (NIP-33 parameterized replaceable: 30000-39999) */
export const SESSION_LIST_EVENT_KIND = 30515;

/** Regular event kind for output/messages (stored by relays, retrievable for catch-up).
 *  Must be in range 1-9999 (regular events). Was 29515 which falls in 20000-29999 (ephemeral)
 *  and caused unreliable delivery — relays dropped events instead of storing/forwarding them. */
export const OUTPUT_EVENT_KIND = 4515;

// --- Pairing ---

export interface PairingInfo {
  npub: string;
  relays: string[];
  machine: string;
  /** One-time pairing token embedded in the QR for the auto-pairing handshake. */
  token?: string;
  /** Fresh `nvpn://invite/...` code folded into the QR so the phone can self-join the mesh.
   *  Absent when nvpn/mesh isn't available — the pure-pairing QR still works. */
  mesh?: string;
  /** Active mesh network id (e.g. "a237c978"), paired with `mesh`. */
  netid?: string;
}

export interface PairedPhone {
  npub: string;
  pubkeyHex: string;
  label: string;
  pairedAt: string;
}
