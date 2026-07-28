# TODO — Codedeck Bridge (VSCode Extension)

## GSD integration

- [ ] **CDB-033: a session can only ever be rooted at `workspaceFolders[0]`** — the blocker that made
  CD-053 untestable end-to-end. `extension.ts:74` is
  `const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;` — always folder `[0]`,
  with no way to choose. `nostr-apps.code-workspace` declares exactly one folder (`"path": "."`), so
  **every** CodeDeck session on this machine is rooted at the multi-project workspace root, which is
  not a git repo and holds 27 sibling repos. The New Session sheet's `WORKSPACE` field therefore has
  one option and is decorative.
  *Consequence:* GSD can never be driven from the phone against a real project — `Start GSD` can only
  target the root, where it would `git init` over 27 repos (see **CD-056**). A full GSD lifecycle test
  on 2026-07-28 had to be run from a terminal-side session instead of by tapping the strip, so no
  strip state (waiting / executing / recovery / idle) has ever actually been observed.
  *Fix:* let a session carry an explicit `cwd`. Cheapest version: make the existing `WORKSPACE` picker
  select among `workspaceFolders[n]` and pass the choice through to `sdkSession`. Better: allow an
  arbitrary subdirectory, since `gsd-tools --cwd` already walks up to the project root
  (`gsdState.ts:277`), so a subdir cwd works for GSD without further changes.
  *Note:* `gsdEnabledSessions` is keyed by `sessionId` (`sessionStore.ts:75`, `:1100`), so the GSD
  opt-in evaporates on every new session for the same repo. Keying it by `cwd` instead would make the
  opt-in stick per project and remove most of the need for a New Session checkbox.

- [x] **CDB-032: widen the GSD snapshot — `installed`, live execution, recovery signals, pre-flight (protocol v7)** — ✅ code + tests done, **device-verify owed** (covered by CD-053's run-sheet; this side has no separate UI). `gsdState.ts` now also runs `query phase-plan-index N` (capped at 3, only for phases GSD wants executed) and `git log`, reconstructing task-level progress from GSD's atomic `type(phase-plan): desc` commits — the only thing that moves during a parallel wave. Two live-CLI corrections landed with it: `smart-entry`'s `current_phase` arrives as a **number** (must be coerced or the phone's current-phase highlight silently never fires), and `has_checkpoints` is derived from `autonomous: false` alone, so counting non-autonomous plans supersedes it. 162 tests.

- [x] **CDB-031: Serve GSD workflow state to the phone (`gsd-request` / `gsd-state`)** — ✅ code + tests done, device-verify owed.
  New `src/gsdState.ts` shells out to GSD's own CLI (`~/.claude/gsd-core/bin/gsd-tools.cjs`) for a session's
  `cwd` and returns a `GsdState` snapshot; `core.ts onGsdRequest` publishes it via `nostrRelay.publishGsdState`
  (reuses `publishToAllPhones`, 90s NIP-40 expiry — no new event kind). Protocol bumped to **v6**.
  Paired with **CD-052** in `codedeck/`.

  <details><summary>Device-verification run-sheet</summary>

  **Preconditions.** Build + install this extension (`npm run build`, then reload the VSCode window —
  or `npm run package` and install the .vsix). GSD Core must be installed at
  `~/.claude/gsd-core/bin/gsd-tools.cjs` (it is, v1.8.0). A phone running Codedeck ≥ the CD-052 build,
  paired with this bridge. Test project: `src/__tests__/fixtures/gsd-project` (committed; 3 phases,
  phase 1 complete, phase 2 planned, 50%). Copy it somewhere writable first —
  `cp -r src/__tests__/fixtures/gsd-project /tmp/gsd-verify` — so the run doesn't dirty the repo.

  **Steps.**
  1. From the phone, create a new session with cwd `/tmp/gsd-verify` (or open VSCode on that folder
     and start a session there).
  2. Wait for the session to go idle.
  3. Observe the area directly under the session header.
  4. Tap the trailing chip on the strip.
  5. Tap the summary text (left part of the strip) to open the sheet; tap the row for phase 2.
  6. Open a session whose cwd is any NON-GSD project (e.g. this repo).

  **Pass oracle.**
  - Step 3: a one-line strip reading `v1.0 · Phase 2/3 · Executing · 50%` (or similar; exact
    milestone text depends on STATE.md) with a small progress meter. **Pre-fix behaviour: no strip
    existed at all** — GSD state was invisible on the phone.
  - Step 4: the chip's command (e.g. `/gsd-execute-phase 2`) appears in the output stream as if
    typed, and Claude Code actually runs it — *not* an "Unknown slash command" error. An
    `Unknown slash command: /gsd:execute-phase` failure means `normalizeCommand()` picked the wrong
    install layout (namespaced vs flat) — that is the specific regression this step exists to catch.
  - Step 5: a bottom sheet lists all 3 phases with D·P·E marks (`✓✓✓` for phase 1, `✓✓○` for phase 2);
    phase 1's row is non-tappable, phase 2's row sends `/gsd-execute-phase 2`.
  - Step 6: **no strip at all** — an ordinary session must look exactly as it did before.

  **On failure.** Check the VSCode Output panel (Codedeck channel) for
  `Failed to publish gsd-state`. Reproduce the bridge side directly with
  `node ~/.claude/gsd-core/bin/gsd-tools.cjs smart-entry --json --cwd /tmp/gsd-verify`.
  </details>

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
