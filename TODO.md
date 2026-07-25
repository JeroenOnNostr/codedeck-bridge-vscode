# TODO — Codedeck Bridge (VSCode Extension)

## Agent SDK follow-ups (unlocked by 0.3.220, see CDB-028)

- [ ] **CDB-029: Stop downgrading mid-session `max` effort to `xhigh`** — `sdkSession.ts:629-646` maps `max` → `xhigh` when the phone changes effort mid-session, because SDK 0.3.177's `applyFlagSettings` typed `Settings.effortLevel` as `low|medium|high|xhigh` only. SDK 0.3.220 documents `effortLevel` as accepting `'max'` on `applyFlagSettings` (session-scoped, never persisted to settings files) — so true `max` no longer needs a fresh session. Drop the mapping + the log line and let `max` through, keeping `auto` → clear.
- [ ] **CDB-030: Advertise the SDK's live model list instead of the phone's hardcoded one** — The selectable model list lives in `codedeck/src/constants/models.ts` and has to be hand-edited on every model launch (CD-050 was exactly that). SDK 0.3.220 exposes `query.supportedModels(): Promise<ModelInfo[]>`; the bridge could report it in the session list / a new `models` message so the phone's picker is always current, falling back to the hardcoded list for older bridges.

## Mode Tracking

- [ ] **CDB-001: Optimistic mode tracking drifts from actual terminal state** — The Shift+Tab keystroke approach for mode switching is unreliable: Claude Code can change its own mode between our Shift+Tab sends and the next observation. Investigate reading the actual mode from terminal output or Claude Code's state instead of tracking it optimistically.

## Permissions

- [ ] **CDB-002: Consider `--dangerously-skip-permissions` CLI flag** — For sessions that start in default (YOLO) mode, spawn Claude with `--dangerously-skip-permissions` instead of using the bridge auto-approve approach. Eliminates race conditions and latency from keypress-based auto-approval. Can't be toggled mid-session (requires process restart), so keep bridge auto-approve fallback for mid-session switches.

## Relay Hygiene (NIP-40 Expiration)

- [ ] **CDB-003: Add 1-hour expiration to history response events** — `nostrRelay.ts:publishHistory()` — Add `['expiration', ...]` tag to kind 29515 history events. These are one-shot catch-up payloads, pure waste after delivery.
- [ ] **CDB-004: Add 7-day expiration to output stream events** — `nostrRelay.ts:publishOutput()` — Add `['expiration', ...]` tag to kind 29515 output events. Matches the bridge's own 7-day `MAX_AGE_MS` session filter.
