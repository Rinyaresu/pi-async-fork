# pi-async-fork

`pi-async-fork` runs bounded Pi work in durable pi-fleet agents without blocking the main Pi agent.

It provides `create_fork`, `steer_fork`, `fork_status`, and `cancel_fork`. Forks use a separate retained Pi session, send meaningful progress and final reports as parent steering messages, and preserve branch-scoped ownership in the parent Pi session.

Progress reports never wake an idle parent. During active work, Pi appends progress after the current turn's tool results for a later model call. Progress alone does not cause that call.

Progress reports never wake an idle agent. Final reports and terminal notices always wake the agent when idle and queue as steering while it is working. This can create one main-model turn for each staggered terminal report. The agent must process routine reports as internal work events and write user-visible text only for material communication. Historical `triggerTurn` values remain valid ledger data but do not change terminal wake behavior.

## Fork creation

`create_fork` requires `name`, `task`, `description`, `role`, and `effort`. `context` is optional. Missing role or effort is an error; neither is inferred from the other or from task text. The description is a single-line, 3-to-6-word purpose summary for the user, such as `Trace login session validation`. Describe the work, not fork mechanics. The extension trims outer whitespace and rejects C0 or C1 controls and Unicode line separators `U+2028` and `U+2029`.

New fork records store `description`. The description appears only in TUI metadata. It does not change the model-visible report envelope. Creation and progress, final, and notice headers append ` · <description>` after the public fork ID. Status appends the description after a successful result. Steering headers do not change. Historical records or result messages without a description retain their current headers. Historical `fork.created` records may contain `triggerTurn`; the parser accepts it for compatibility and ignores it.

## Fork status activity

`fork_status` accepts an optional positive integer `limit`. For an active fork, it opens an independent pi-fleet replay from the start and returns an observed activity history. Without `limit`, it returns all observed mapped entries within collector output limits. With `limit`, it retains only the latest observed entries.

Collection stops after one second without an event or three seconds total, so status can take one to three seconds. The result is best effort, not a complete journal snapshot. It can miss activity during replay, stream failure, or subscriber overflow. A collection problem adds a warning but does not fail a valid state result.

The activity list preserves stream order and shows UTC timestamps with `thinking`, `message`, or `tool <name> <compact args>`. It excludes thinking content, visible message content, and tool output. Tool arguments are size-limited and redacted for secret-shaped keys, credentials in URLs, and common authorization strings. This is not a secret-safe audit log.

Automatic cleanup removes completed fork activity with the pi-fleet journal. Completed and historical forks return state and description without an activity section. The collapsed TUI header remains `fork_status <forkId> · <description>: <state>`. Expanded status output shows the observed activity section.

## Fork cancellation

Use `cancel_fork({ forkId, reason? })` to explicitly end a fork owned by the current session branch. Supply the complete ID returned by `create_fork`. An optional reason is included in the cancellation notice.

```ts
cancel_fork({ forkId: "research-1234567", reason: "The investigation is no longer needed." })
// { state: "completed", outcome: "cancelled" }
```

Cancellation uses the same lifecycle queue as steering and automatic finalization. The first finalization in that queue wins. A fork can be cancelled while working, starting, or waiting through the terminal grace period. Repeating cancellation after completion returns `{ state: "completed", outcome: "already_completed" }` without destroying again or replacing its original report. `fork_status` continues to return `completed`.

The extension records a terminal cancellation notice after the SDK confirms destruction and then requests a parent notification. The retained child session is not deleted. There is no notification acknowledgement: success means the SDK confirmed destruction, recording returned successfully, and notification was requested, not that the parent consumed the message. Missing terminal messages can replay from the ledger under the existing delivery rules.

Errors distinguish unconfirmed SDK destruction, confirmed destruction with failed outcome recording, and a recorded outcome with failed notification request. A recording error may leave the Pi branch updated in memory without the entry on disk. The current controller retains that error for the same fork and immutable agent identity across branch navigation: cancellation and status report it, and reconciliation does not restore the stopped agent or replay the unconfirmed outcome. This knowledge ends when the controller stops; it is not durable recovery. No automatic retry or rollback is added. An abort before destruction leaves the fork untouched; after destruction starts, cancellation finishes its bookkeeping rather than abandoning the outcome.

Cancellation is not necessarily immediate: it can wait for earlier lifecycle operations and SDK shutdown. It does not undo file changes, requests, jobs, or other side effects. The SDK stops the child Pi process; Pi runtimes that clean tracked shell groups on shutdown can also stop native shell commands. This is not a guarantee that custom-tool subprocesses, escaped processes, or external jobs have stopped. Closing or reloading the parent still does not implicitly cancel forks.

## Role, effort, and context

Choose each dimension independently:

| Dimension | Values and meaning |
| --- | --- |
| Required `role` | `investigate`: read-only discovery, analysis, or diagnosis. `execute`: perform an authorized bounded outcome, including necessary writes. `verify`: read-only independent verification, returning findings without fixes. |
| Required `effort` | `fast`: straightforward work with little unresolved judgment, including fully specified implementation. `balanced`: ordinary significant judgment. `deep`: genuinely difficult unresolved uncertainty. |
| Optional `context` | `inherit`: copy the active parent branch up to the creation call. `isolated`: start without parent session history. Defaults: investigate/execute → inherit; verify → isolated. All roles may override either mode. |

Explicitly choose the lowest effort that can reliably complete the result. There is no silent capacity/cost default. Writing files alone does not require a stronger model: `execute + fast` is valid. Conversely, investigate/verify remain read-only at any effort. Effort selects only the configured model/thinking profile; names do not prove relative capability or cost versus each other or the main. There is no automatic model routing or escalation.

```ts
create_fork({
  name: "apply-fix",
  description: "Apply the agreed correction",
  task: "Implement only the supplied correction in the allowed files, then run the focused tests.",
  role: "execute",
  effort: "fast",
}) // context defaults to inherit

create_fork({
  name: "review-fix",
  description: "Verify the corrected behavior",
  task: "Independently check the supplied requirements against the implementation; report findings, do not fix it.",
  role: "verify",
  effort: "balanced",
}) // context defaults to isolated
```

The main retains intent, scope, approvals, integration, and final judgment. Roles are bounded work contracts, not mandatory pipeline stages. Read-only is an instruction contract, not a sandbox or per-tool permission: do not alter investigated/reviewed work or make unauthorized persistent mutations. Necessary temporary validation artifacts and authorized test fixtures are allowed; shared-data mutations and external effects still require authorization. Execute never grants arbitrary write approval. Workers report material ambiguity rather than change roles, widen scope, or take over the initiative.

Isolated creates a native fresh Pi session with the same lineage (`parentSession`) and a model-visible custom boundary. It copies no parent messages, thinking, summaries, compactions, checkpoints, or context edits. The worker still loads its own system/profile instructions, project resources, tools, environment, credentials, accessible files, and external memory. Supply a self-contained task and evidence; history isolation is not filesystem isolation or proof of unbiased verification.

Historical ledger records and sessions remain readable: `tier` retains its effort meaning, missing historical role stays unknown/legacy, and missing context means inherit. Restoring a historical worker neither rewrites its prompt nor changes its model. Historical rendering supports effort/tier-only headers without inventing roles; this compatibility does not permit new calls with missing role or effort. New call headers show `[role/effort/effective context]`.

## Configuration

Add this to global or project Pi settings:

```json
{
  "pi-async-fork": {
    "agentDir": "/absolute/path/to/fork-agent-profile",
    "stateDir": "/absolute/path/to/pi-fleet-state",
    "env": { "PI_OBSERVATIONAL_MEMORY_PASSIVE": "1" },
    "fast": { "provider": "openai-codex", "model": "gpt-5.6-luna", "thinking": "medium" },
    "balanced": { "provider": "openai-codex", "model": "gpt-5.6-terra", "thinking": "high" },
    "deep": { "provider": "openai-codex", "model": "gpt-5.6-sol", "thinking": "high" }
  }
}
```

`agentDir` is optional. Omit it, or set it to `null`, to use pi-fleet's default Pi profile. Set a non-empty path to use a dedicated fork profile. A project `agentDir: null` overrides a configured global path.

`stateDir` is optional. Omit it, or set it to `null`, to use pi-fleet's default state directory, `~/.pi-fleet`. Set a non-empty path to isolate fork state. A project `stateDir: null` overrides a configured global path.

`env` is an optional string-to-string overlay for fork Pi processes. It does not change the parent Pi process or the pi-fleet worker. A project `env` object merges by key with the global object. A project string overrides one global value, a project `null` value removes one inherited key, `env: null` clears all inherited values, and `env: {}` keeps inherited values. Omit `env`, or resolve no entries, to pass no overlay.

`PATH` and `PI_CODING_AGENT_DIR` are reserved. Names must be non-empty and cannot contain `=` or a null byte. Values must be strings without null bytes; empty strings are valid. pi-fleet persists values in agent state and backups, then applies them to Pi startup and recovery. Do not use `env` for secrets. Existing forks retain their recorded environment until destruction; changes affect only new forks. pi-async-fork does not duplicate environment data in its session ledger.

A dedicated fork profile controls child resources and extensions. When the default profile loads `pi-async-fork` inside a child, an extension-owned session marker prevents all four async-fork tools from starting or managing forks. The tools remain visible so an attempted call can return a task-focused error.

After adding or changing this configuration, run `/reload` or restart Pi. Until valid configuration exists, the extension stays inactive and its tools return the configuration error.

Migrate routing instructions together with V2: remove fast = read-only, implementation = balanced, and automatic effort escalation rules from the active APPEND_SYSTEM/profile. Adding roles beside contradictory old instructions is insufficient. A trusted project APPEND_SYSTEM or another `agentDir` can replace the global append; inspect the actually selected instruction source. Isolated workers still receive those instructions.

## Operational limits

Forks share the parent project working directory in both context modes. The main coordinates its own writes and every fork's effects. Serialize execute forks by default at any effort; parallel execution requires known disjoint files and relevant shared resources. Independently bounded investigate/verify tasks may run concurrently only without conflicting effects: tests can still compete for databases, caches, ports, or services. No write locks, scheduler, sandbox, or workspace isolation is provided.

The child-session marker blocks `create_fork`, `steer_fork`, `fork_status`, and `cancel_fork` inside async forks. It does not block direct pi-fleet CLI commands through a shell. Use a restricted profile or sandbox when workers must not have shell access to pi-fleet.

The extension retains child session files under the parent session directory after normal completion. If creation cleanup cannot destroy an unregistered pi-fleet agent, it also retains that child session and returns the agent name and cleanup error. Inspect it with `pif status <name>`, or add `--state-dir <path>` for custom state. Destroy only that named agent with `pif destroy <name>`, or add `--state-dir <path>`.

A terminal fork waits ten seconds for delayed activity replay before it classifies its remaining report as final or sends a no-result notice. This wait is a first-version heuristic. Removing or disabling the extension does not destroy active pi-fleet agents, so inspect the configured state directory before rollback.

## Progress reports

Forks remain one-off workers. A multi-phase task must report only after a completed phase produces a concrete, evidence-backed finding. Plans, intended sources, and unstarted work do not qualify. An intermediate report must state what the evidence changes, material uncertainty, remaining work, and the next action. It must not imply that the task is complete. A later report must add evidence that changes the recommendation, scope, risk, or next action, resolve a named uncertainty, or complete a distinct phase. New citations, restated findings, and repeated next actions do not qualify. Forks do not report simple one-phase work, raw activity, elapsed time, or waiting. They automatically destroy themselves after the final report or a terminal notice.

Each visible checkpoint and final report uses `## Output` and `## Learnings`. Intermediate reports stay short and focused. Source URLs can appear inline. This brevity requirement does not apply to final reports, which retain the task-adapted report contract. To continue one Pi run, an intermediate report must include the next necessary tool call in the same assistant response. A text-only report with no next tool call is final.

The extension holds each visible child message until later pi-fleet activity proves that the child continued. It sends that report as progress only while the latest monitored pi-fleet status is `working`. If terminal status remains for ten seconds, only the latest remaining message is final. It sends these model-visible envelopes:

```text
<forkId>:

This is an intermediate progress report. The fork is still working and can receive steering.

<report>
```

```text
<forkId>:

This is the final report. The fork finished and can no longer receive steering. Treat this report as an internal work event. Do not write user-visible text only because it arrived.

<report>
```

A terminal notice says that the fork finished and can no longer receive steering, then instructs the agent to treat it as an internal work event without user-visible acknowledgment. The TUI renders only clean headers: `● fork <forkId> · <description>: working` for progress, `✓ fork <forkId> · <description>: completed` for final reports, and `⚠ fork <forkId> · <description>: terminal` for notices. The description is omitted for historical messages that lack it. The model-only status sentence does not appear in expanded Markdown.

Progress and final reports use pi-fleet cursors plus the public fork ID and immutable agent ID for duplicate suppression. Each report remains scoped to its owner branch. An inactive owner branch receives no delivery. If the fork is still working when that branch becomes active, missing progress can replay. If the fork is terminal, only its latest report becomes final. Progress does not add `fork.created` or `fork.destroyed` records.

`pi.sendMessage()` has no delivery acknowledgement. This provides at-least-once replay with cursor duplicate suppression after a persisted parent custom message, not exactly-once delivery. A parent process can still lose a queued progress message before Pi consumes and persists it.

## Development

```bash
npm install
npm test
npm run typecheck
```

The separate `test/integration/isolated-context.mjs` gate must capture the effective transcript and real provider request from disposable Pi/fleet workers against a local recording endpoint. Parent-only sentinels must be absent in isolated and effective sentinels present in inherited controls, while the parent stays readable and `parentSession` retains its link. The initial JSONL and unit tests alone do not prove isolation. See SPECIFICATION's decisive isolated-context gate for version-specific coverage; do not claim the minimum Pi version or modern context-edit/checkpoint coverage without running the matching integration. A main process must execute this agent-creating harness, not a fork.
