# TODO — Codedeck Bridge (VSCode Extension)

## GSD integration

- [ ] **CDB-035: the phone had no way to know what folders the workspace holds** — ✅ code + tests
  done, **device-verify owed**. CDB-033 let a session be rooted in one project, but the phone can't
  read this filesystem, so its *Project folder* picker could only offer the folder names of sessions
  already running — and since every session starts at the workspace root, that was a list of exactly
  one entry naming the root itself. The picker named everything except a project.

  `listWorkspaceFolders()` (core.ts, beside `resolveSessionCwd`) now enumerates the workspace and
  the list rides on the session list as `folders` — protocol **v9** — so it is already on the phone
  when the New Session sheet opens instead of a relay round trip after it. Entries are relative
  paths, so each one is directly usable as `create-session.cwd`. Depth is one level plus one
  more *inside a folder that has no build file of its own*: `nostr-relays` is a repo **and** a
  container of five relay projects, so "descend into non-repos" would have hidden exactly what this
  exists to surface, while `codedeck/src-tauri` is a module of a project and not a project. Scan is
  memoized for 30s (the session list republishes every heartbeat) and invalidated when a session
  creates a folder, capped at 200 entries with a log line rather than a silent truncation, and any
  failure degrades to no list — never to a failed publish. Real workspace: 45 folders, 816 bytes,
  10ms. 198 tests (+12).

  <details><summary>Device-verification run-sheet</summary>

  **Preconditions.** Laptop running a bridge built from this commit (`npm run package` → install the
  `.vsix` → **Reload Window**; the reload is what activates it). Phone on a CodeDeck build carrying
  CD-059. Paired as usual; the workspace is the 32-project one.

  **Steps.**
  1. On the phone, tap **+** on the Framework machine to open **New Session**.
  2. Tap the **Project folder** field.
  3. Type `nostr` to filter.

  **Pass oracle.** Step 2 lists the real workspace folders (`atna`, `codedeck`, `gantry`, `yenn`, …)
  and step 3 narrows to `nostr-relays` plus its nested projects `nostr-relays/rocket-relay`,
  `nostr-relays/impostr-relay` and the other three. **Pre-fix the dropdown had one entry — "VScode
  workspace for building nostr apps", the workspace root itself.** Then pick `yenn`, start the
  session, and confirm on the laptop that the session's cwd really is `…/yenn` (bridge output
  channel logs the created session, and the session card's project reads `yenn`) — the list is only
  worth anything if the entries it offers are accepted verbatim as `cwd`.
  </details>

- [ ] **CDB-034: the session-meta request rewrites a slash command's arguments** — ✅ code + tests
  done, **device-verify owed**. `sendInput()` appends
  `<!-- emit-session-meta: … -->` to a session's first message to get a topic/project label back.
  Claude Code treats everything after a slash command's name as that command's `$ARGUMENTS`, so on a
  session opened with one — which is now the normal case, since CodeDeck's GSD strip sends a command
  for every tap and "New GSD project" opens the session with `/gsd-new-project` — the command is
  quietly asked to do something else. `/gsd-execute-phase 2` arrives as phase
  `"2\n\n<!-- emit-session-meta: … -->"`. Fixed by `isSlashCommand()`: skip the append for
  commands and track the outstanding ask in a new `metaRequested` flag rather than in `title`, so a
  session that opened with a command still gets labelled on its first ordinary message. 7 tests.

  <details><summary>Device-verification run-sheet</summary>

  **Preconditions.** Laptop running a bridge built from this commit (`npm run package` →
  `codedeck-bridge-2026.7.31.vsix` → install → **Reload Window**; the reload is what activates it).
  Phone on CodeDeck 2026.7.31+. A GSD project with a roadmap of ≥2 phases — `gsd-testbed` is one.

  **Steps.**
  1. From the phone, create a session with **Project folder** = `gsd-testbed`.
  2. As the session's **very first** input, tap the strip's phase row for phase 2 (or type
     `/gsd-execute-phase 2`).
  3. Watch the laptop-side stream / `.planning/` for which phase GSD acts on.

  **Pass oracle.** GSD executes **phase 2**. **Pre-fix, the first-message path appended the
  metadata comment to the arguments**, so the command's `$ARGUMENTS` was `2` followed by two
  newlines and an HTML comment — GSD either mis-parsed the phase or dragged the comment into its
  reasoning. Also confirm the session card still acquires a topic/project label after the *second*
  (ordinary, non-slash) message — that is the half of the fix that must not regress. If the card
  stays titled `/gsd-execute-phase 2` forever, `metaRequested` is not being cleared.
  </details>

- [x] **CDB-033: a session can only ever be rooted at `workspaceFolders[0]`** — ✅ code + tests done,
  **device-verify owed**. Fixed in `46926e4` (+ phone `3f29615`): `create-session` takes an optional
  `cwd`, and `resolveSessionCwd()` confines it to the workspace root — containment is checked on
  path *segments*, never `startsWith` (or `/ws/app-2` would pass as inside `/ws/app`), the target
  must already exist as a directory, and anything else logs and falls back to the root so a stale
  bookmark on the phone cannot make sessions un-creatable. The phone gained a **Project folder**
  field on the New Session sheet (blank = workspace root). Protocol **v8**. 174 tests (+12).

  <details><summary>Device-verification run-sheet</summary>

  **Preconditions.** Laptop running this bridge build; phone on `3f29615`+. The VSCode workspace is
  the multi-project root (`nostr-apps.code-workspace`, one folder: `.`), which is the whole point —
  `gsd-testbed/` is a real git repo inside it.

  **Steps + pass oracle.**
  1. New Session with **Project folder** left blank. → Session cwd is the workspace root, exactly as
     before. This is the compatibility case; if it regresses, every existing session breaks.
  2. New Session with **Project folder** = `gsd-testbed`. → The bridge log shows
     `Create session request … (cwd: gsd-testbed)` and the session's cwd is
     `<workspace>/gsd-testbed`. The GSD strip then shows that project's real state
     (`Phase 1/5 · 20%` — see CD-054), **not** the workspace root's "GSD not set up here".
     **Pre-fix: this was impossible — every session landed on the root, which is why the strip had
     never once been driven against a real GSD project.**
  3. New Session with **Project folder** = `../` or `/etc`. → Bridge log shows
     `Rejected session cwd outside the workspace`, and the session opens at the root rather than
     failing. Confinement is the security property here; an escape is a hard fail.
  4. New Session with **Project folder** = `does-not-exist`. → Log shows
     `Session cwd does not exist`, session opens at the root.
  5. Kill the bridge mid-create and let the phone's optimistic retry fire. → The retried create
     carries the same `cwd` (it is stored on the optimistic record), not a silent fallback to root.
  </details>


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
