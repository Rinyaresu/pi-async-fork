# pi-async-fork specification

## Specification status

This document specifies the approved V2 target before implementation. New creation calls must explicitly choose both role and effort; context has role-dependent defaults. Requirements below are not claims that V2 is already implemented or integration-validated.

The local working tree already contains the uncommitted `cancel_fork` implementation, its tests, and its documentation; the current repository HEAD does not. `src/index.ts` registers it and forwards to `Controller.cancel()` in `src/forks/controller.ts`. V2 must preserve that local cancellation behavior and regression coverage, not assume cancellation is absent or already released.

## Purpose

`pi-async-fork` makes forks durable, asynchronous context branches.

A main Pi agent creates bounded work and immediately continues. A pi-fleet agent runs the work independently. The extension sends meaningful intermediate reports and the final assistant response back to the parent as steering messages.

The parent remains the orchestrator and owns user intent, scope, approvals, decomposition, sequencing, integration, and final judgment. Async forks are temporary, bounded, one-off work branches. They are not user-facing agents, long-lived specialists, or workflow owners. Greater effort does not transfer authority. Roles are not mandatory pipeline stages: create only the bounded work whose context isolation, useful parallelism, or independent judgment serves the active goal.

## Behavior change

Synchronous `pi-fork` behavior is:

```text
fork → wait → result → continue
```

`pi-async-fork` behavior is:

```text
create fork → receive fork ID → continue → receive progress and final reports later
```

The first-order outcome is that bounded research or other safe background work does not block the parent agent's current reasoning.

## Runtime boundary

pi-fleet is the durable runtime for fork agents. It owns agent processes, worker recovery, and activity persistence.

`pi-async-fork` uses only the public `@elpapi42/pi-fleet-sdk`. It must not inspect, write, or depend on pi-fleet's internal state or LMDB implementation.

`pi-async-fork` owns:

- parent-session fork records;
- retained child Pi session files;
- active in-memory handles and receivers for the current parent session.

## Tool surface

### `create_fork`

```text
create_fork(name, task, description, role, effort, context?) → fork ID
```

The agent supplies a short semantic name for the work. The name does not need to be unique. It must contain one or two lowercase words, with one hyphen between two words. Each word contains letters only. The agent must not add a number because the tool appends the generated seven-digit suffix.

`description` is required. It gives the user a 3-to-6-word summary of the fork's purpose, such as `Trace login session validation`. It must describe the work, not fork mechanics. The extension trims outer whitespace, requires 3 to 6 whitespace-separated words, and rejects C0 or C1 controls plus Unicode line separators `U+2028` and `U+2029`. It validates this value before it creates a child session or pi-fleet agent.

Progress reports never wake you. Final reports and terminal notices always wake you when idle and queue as steering while you are working. Treat these terminal reports as internal work events. Do not write user-visible text only because one arrived. This can create one main-model turn for each staggered terminal report. Historical `fork.created` records may contain `triggerTurn`; the parser accepts this legacy field and ignores its value.

The tool creates a retained child session, creates a durable pi-fleet agent, starts its receiver, and sends the assigned task followed by a concise report-format requirement. It appends `fork.created` only after `agent.send()` accepts that message, then returns the canonical fork ID without waiting for completion.

Successful send acceptance is the registration boundary. The public pi-fleet SDK cannot reliably expose a separately observed `working` transition for fast tasks because a task can settle before status observation.

If child-session creation, fleet creation, or initial task delivery fails, the tool destroys any created fleet agent, deletes the unregistered child session file, writes no lifecycle entry, and returns a clear error. An uncertain send is a delivery failure and must not be retried automatically. If cleanup also fails, the error reports both the original failure and cleanup failure.

The `create_fork` tool description and its `name` parameter description must state all naming rules. They must include the one-or-two-word limit, lowercase letters-only rule, optional single separator, prohibition against agent-supplied numbers, generated suffix behavior, and requirement to use the returned fork ID for later calls.

#### Role, effort, and context

`role` and `effort` are required in every new call, at the tool schema and controller boundary. Missing or invalid values are creation errors before child-session or agent side effects. There is no role inference from effort or task text, no effort inference from role, and no silent capacity/cost default. Compatibility applies to historical records and rendering, not new invocations of the old signature.

`role` accepts:

- `investigate`: read-only discovery, analysis, comparison, or diagnosis within the assigned scope. Return evidence, bounded interpretation, and material unknowns; do not implement or modify the investigated work.
- `execute`: perform only the authorized bounded outcome, including necessary writes and ordinary local decisions. Stop and report ambiguity that changes behavior, architecture, scope, authorization, or the write surface. Do not take over the initiative or expand into adjacent work.
- `verify`: read-only independent verification of supplied requirements, a result, or a hypothesis. Try to falsify it; do not assume correctness. Return findings and blind spots; do not fix the reviewed work.

Read-only is an instruction contract, not a runtime sandbox or per-tool permission. It prohibits changing the investigated/reviewed work and unauthorized persistent mutations. Necessary temporary validation artifacts and authorized test fixtures are allowed; shared data, services, and external effects still require the applicable authorization. An `execute` role does not itself grant approval for arbitrary writes or external actions. All roles preserve project rules, main ownership, bounded scope, no nested delegation, and no adjacent work.

`effort` accepts `fast`, `balanced`, or `deep` and selects only the corresponding configurable model/thinking profile. The caller must explicitly choose the lowest effort that can reliably complete the result:

- `fast`: straightforward bounded work with little unresolved judgment, including fully specified implementation.
- `balanced`: ordinary significant judgment or interpretation.
- `deep`: genuinely difficult unresolved uncertainty where additional reasoning capability can materially change the outcome.

Writing files alone does not justify a stronger model. Effort does not change role, authorization, scope, context, ownership, or write coordination. All nine role/effort combinations are valid, including `execute + fast` and read-only `investigate + deep` or `verify + deep`. Profile names are configurable selectors, not proof of relative model capability or cost versus each other or the main. There is no automatic model routing, escalation, or role change; a worker reports material uncertainty to the main.

`context` accepts `inherit` or `isolated`. It is optional and resolves as follows:

| Role | Omitted context |
| --- | --- |
| `investigate` | `inherit` |
| `execute` | `inherit` |
| `verify` | `isolated` |

Every role may explicitly override either mode. The extension resolves and persists the effective mode. Context controls parent session-history inheritance only; it does not isolate the worker's system prompt, profile, resources, credentials, tools, environment, filesystem, or external memory. An isolated task must supply the requirements and evidence needed without relying on the parent conversation. Its framing can still bias a verifier; isolation is not proof of independent judgment.

In the Pi TUI, new `create_fork` calls use one content line: `create_fork [<role>/<effort>/<effective context>] <fork ID> · <description>`. Before creation returns the generated ID, it shows `<name>-…`. Omitted context is displayed using its resolved role default. Historical calls without role retain the effort-only format, accepting historical `effort` or `tier` metadata without inferring a role; they are legacy calls, not a newly authorized role. The expanded view adds the full task under `─── Task ───`. `steer_fork` uses `steer_fork <fork ID>` and adds the full steering message under `─── Message ───` only when expanded. After its result returns, `fork_status` uses `fork_status <fork ID> · <description>: <state>` and shows observed activity only when expanded. Historical calls without a description retain the existing `fork_status <fork ID>: <state>` format. Normal successful result output, usage, cost, and expansion hints remain hidden. Tool errors remain visible. The displayed ID is the public fork ID, not pi-fleet's internal agent UUID.

Fork result custom messages retain the model-visible fork-ID prefix `<forkId>:\n\n` followed by a progress, final, or notice sentence and then the report. Progress says `This is an intermediate progress report. The fork is still working and can receive steering.` Final output says `This is the final report. The fork finished and can no longer receive steering. Treat this report as an internal work event. Do not write user-visible text only because it arrived.` A notice says `This is a terminal notice. The fork finished and can no longer receive steering. Treat this notice as an internal work event. Do not write user-visible text only because it arrived.` The description is display metadata only and never changes this envelope.

A dedicated TUI renderer shows `● fork <forkId> · <description>: working` for progress, `✓ fork <forkId> · <description>: completed` for a response, or `⚠ fork <forkId> · <description>: terminal` for a notice. In Pi's global collapsed mode, it shows only that header. In expanded mode, it adds a blank line and Markdown report output. It uses the active theme's `customMessageBg` panel and `customMessageText` body color so the result remains distinct from user and assistant messages. Delivery metadata carries `kind: "progress" | "response" | "notice"` and an optional description for this display only. The renderer removes the model-only classification sentence from Markdown. Legacy result messages without `kind` use a neutral marker, and historical messages without a description omit it. The renderer does not expose pi-fleet agent IDs or cursors.

### `steer_fork`

```text
steer_fork(fork ID, message) → acceptance or error
```

The tool uses pi-fleet's existing adaptive steering delivery. If the fork is working, Pi queues the message as steering before the next LLM call. If the fork is idle, Pi treats it as a normal prompt and starts a turn. The tool does not wait for the work to finish.

### `fork_status`

```text
fork_status(fork ID, limit?) → current fork state and active activity snapshot
```

The tool resolves the fork ID against the current active-branch ledger.

- An active fork returns its current raw pi-fleet state without extension remapping. It also opens an independent pi-fleet `receive({ fromStart: true })` stream for an observed activity snapshot.
- The activity stream stops after one second without an event or three seconds total. It is best effort, can take one to three seconds, and can miss history during replay, stream failure, or subscriber overflow.
- The snapshot includes ordered UTC timestamps plus `thinking`, `message`, and `tool <name> <compact args>` entries. It excludes thinking content, message content, and tool output. Tool arguments are redacted and size-limited, but this is not a secret-safe audit log.
- Without `limit`, status returns all observed mapped entries within collector output limits. A positive integer `limit` returns only the latest observed entries. Activity collection errors do not fail a valid status result.
- A fork with matching `fork.created` and `fork.destroyed` entries returns the terminal public state `completed` without contacting pi-fleet or activity history because automatic cleanup removes the journal.
- An ID with no `fork.created` entry on the active branch returns a not-found error.

`idle` means that pi-fleet reports settlement. It is not steerable. Automatic pi-fleet destruction is an internal cleanup detail, so the public terminal state is `completed`, not `destroyed`.

Tool output must not expose the retained child session path or other internal storage paths.

The `fork ID` parameter descriptions for `steer_fork`, `fork_status`, and `cancel_fork` must tell the caller to use the complete ID returned by `create_fork`. The caller must not shorten, modify, or reconstruct it.

### `cancel_fork`

```text
cancel_fork(fork ID, reason?) → { state: "completed", outcome: "cancelled" | "already_completed" }
```

The tool explicitly ends a fork owned by the active branch. It validates the branch-scoped fork ID and immutable agent identity, and serializes cancellation in the existing lifecycle queue. It does not require a prior status call and can cancel starting, working, or terminal forks still waiting in the grace period. The first finalization applied in the queue wins, not the first received report candidate. A completed fork returns `already_completed` without another destruction, entry, or notice, preserving its original output.

Cancellation reuses finalization: destroy through the public SDK, append `fork.destroyed` with `kind: "notice"` and `Fork explicitly cancelled.` plus the optional reason, then request the parent notification. It preserves the child session JSONL and leaves the public `fork_status` state as `completed`. Finalization explicitly reports whether it applied or ignored a stale context; a no-op cannot produce cancellation success. A queued cancellation rejects a changed generation or mismatched identity before destruction.

An aborted tool signal prevents destruction when observed before it starts. After destruction starts, the operation finishes recording and notification request even if the tool is aborted, because abort cannot reverse an external action. Session tree transitions drain already-started lifecycle work before switching branch. If a veto or aborted summary left the controller paused without `session_tree`, a subsequent idle context or active agent turn can recover it; a tool call must not clear pause during actual navigation.

Errors distinguish unconfirmed destruction, SDK-confirmed destruction with failed outcome recording, and successful recording with failed notification request. Pi can mutate its in-memory entries before a persistence error, so finding an entry in `getBranch()` does not confirm its successful recording. After a recording failure, the current controller retains the error for the public fork ID and immutable agent ID and drops the stopped handle rather than destroying again or processing late callbacks. That error survives branch reconciliation within the controller: a matching record cannot be restored or replayed, and cancellation and status report the recording failure instead of accepting an in-memory completion. A different agent identity does not inherit it. Transient availability errors continue to be recomputed during reconciliation. Recording-failure knowledge is cleared when the controller stops; this adds no durable recovery mechanism. `pi.sendMessage()` has no acknowledgement, and only synchronous request failures can reach this tool; asynchronous notification failures are outside its success guarantee.

The tool does not roll back files or other effects and does not promise immediate interruption or the termination of external jobs, escaped processes, or subprocesses created by custom tools. It uses the SDK's child Pi shutdown. Actual native-shell cleanup depends on the Pi runtime and requires integration testing.

In the TUI, the collapsed call is `cancel_fork <fork ID>: <outcome>` after success and `cancel_fork <fork ID>` while pending. Expanded output adds an optional reason under `─── Reason ───`. Errors remain visible. There is no `destroy_fork` tool or cancellation UI command.

## Fork ID

Fork IDs use this format:

```text
<name>-<seven-digit suffix>
```

Examples:

```text
research-1234567
review-0429183
tests-8301742
```

The supplied name must match:

```text
^[a-z]{1,20}(?:-[a-z]{1,20})?$
```

The complete supplied name must not exceed 30 characters. The extension rejects invalid names instead of rewriting them.

A valid name contains one or two lowercase words. Each word contains letters only and has at most 20 characters. One hyphen separates two words. Numbers, underscores, leading or trailing hyphens, repeated hyphens, and three-word names are invalid.

Examples:

```text
allowed: research
allowed: window-researcher
allowed: api-review

rejected: researcher-1
rejected: researcher1
rejected: window-api-review
rejected: window_researcher
```

The suffix comes directly from Node's `crypto.randomInt(0, 10_000_000)`, converted to decimal and left-padded with zeroes to seven digits. UUID generation and hashing are not used because they add no entropy after truncation to seven decimal digits.

Before creation, the extension checks the current active-branch ledger for the candidate ID. It uses the complete fork ID as the pi-fleet agent name. If pi-fleet returns `AgentNameTakenError`, the extension generates another suffix and retries. It makes at most ten generation attempts, then returns a clear creation error.

The readable fork ID is a session-branch-scoped handle. The separate immutable pi-fleet agent ID remains the internal identity used for recovery checks.

## Fork completion and delivery

The extension receives pi-fleet activity in the background. Forks remain one-off workers: multi-phase tasks report meaningful checkpoints while working, then send one final report or terminal notice before automatic destruction.

A multi-phase task must send one intermediate report only after a completed phase produces a concrete, task-relevant finding supported by evidence already obtained. Plans, intended sources, and unstarted work do not qualify. An intermediate report states what the evidence changes, material uncertainty, remaining work, and the next action. It must not use completion language. A later report must add evidence that changes the recommendation, scope, risk, or next action, resolve a named uncertainty, or complete a distinct phase. New citations, restated findings, and repeated next actions do not qualify. Workers do not report simple one-phase work, raw thinking, each tool action, elapsed time, or waiting. Every visible checkpoint and final worker report must use `## Output` and `## Learnings`. An intermediate report stays short and focused, with source URLs inline when needed. This brevity requirement does not apply to final reports, which retain the task-adapted report contract. An intermediate report must include the next necessary tool call in the same assistant response so the current Pi run continues. A text-only response with no next tool call is final.

Each active-fork receiver holds visible pi-fleet `message.finished` text and its cursor in arrival order. It reports raw later activity only to the controller, never to the parent. Later activity, including a newer visible message, proves that the previous held report continued. The controller delivers that report as progress only when the latest monitored pi-fleet status is `working`, the owning branch is active, and no persisted parent custom message has the same public fork ID, immutable agent ID, and cursor. It does not remove a held report before branch-safe delivery succeeds.

The controller keeps held reports pending when pi-fleet status becomes `idle`. It waits ten seconds from the first terminal-state observation because status polling and activity delivery are separate paths. Delayed activity marks earlier reports as continued but does not replace an authoritative terminal status. If status returns to `working`, those reports can be delivered as progress. If terminal status remains through the grace period, only the latest held report becomes the idle final response. If no report remains, or status returns `interrupted` or `failed`, the extension creates a plain terminal notice. It does not attempt its own worker recovery.

Before progress delivery, finalization, or notice handling, the extension confirms that the current active-branch ledger owns the exact fork ID and immutable pi-fleet agent ID. If the owning branch is inactive, the extension does not deliver a report or notice, destroy the fleet agent, or append an entry. It leaves the fleet agent and its replayable activity intact. When that branch becomes active again, the extension reconnects, replays held reports, checks current status, and then handles progress, settlement, or a no-result condition. A fork report or notice must never enter a sibling branch.

For an active owning branch, finalization or no-result handling occurs in this order:

```text
capture output or create notice → destroy pi-fleet agent → append fork.destroyed → deliver to parent
```

Parent delivery does not keep the finished fleet agent alive.

Each parent report retains this visible fork-ID prefix:

```text
<forkId>:

<classification sentence>

<report>
```

A progress report uses the explicit progress sentence and says that steering remains possible. A final report uses the explicit final sentence and says that steering is no longer possible. A terminal notice uses the explicit notice sentence. Its custom-message metadata separately includes the fork ID, immutable agent ID, report kind, optional description, and pi-fleet cursor when available. A parent custom message with the same identity marks that report as delivered.

Parent delivery uses different turn-trigger behavior for progress and terminal reports:

```ts
pi.sendMessage(message, {
  deliverAs: "steer",
  triggerTurn: kind !== "progress",
})
```

Progress never starts a parent turn. If the parent is idle, Pi stores and displays the message without waking the agent. If the parent is working, Pi appends it after the current turn's tool results. A later model call can use it, but progress alone does not cause that call.

Final reports and terminal notices always queue as steering before the next LLM call while you are working, or start a turn while you are idle. Progress remains quiet. Historical `triggerTurn` fields remain parse-compatible but do not change this behavior. The extension serializes all delivery calls. Each staggered terminal report can create a main-model turn, which is accepted to prevent stalled dependent work.

Progress remains delivery history only. It never adds `fork.created` or `fork.destroyed` entries. A completed `fork.destroyed` record retains only the final output or notice, its kind (`response` or `notice`), and the pi-fleet cursor when available. After restart, an active working fork can resend missing progress when the active branch has no matching parent custom message. A completed fork can resend its missing final report from `fork.destroyed`. This adds no lifecycle entry.

All report delivery must serialize. Several progress or final reports can arrive while the parent is idle, and concurrent parent turn triggers can race. `pi.sendMessage()` has no delivery acknowledgement. The extension provides at-least-once replay with cursor duplicate suppression after a parent custom message persists. It does not provide exactly-once delivery, and a parent process can lose a queued progress report before Pi consumes and persists it.

## Session and context model

Every fork receives its own retained child Pi session with a fresh session ID and `parentSession` referencing the actual parent path. Parent and child must never append to the same writable JSONL. Retain the child after fleet destruction, including cancellation; remove only an unregistered session during failed creation cleanup.

The current `toolCallId` must identify the invoking assistant entry in the active branch in both modes. Missing invocation or parent path is a clear creation error; never fall back to an active leaf with an unresolved tool batch. Sibling calls use the same cut, not another child's session.

### `inherit`

Preserve the existing projection: derive the child header from the parent with a fresh session ID and lineage; copy earlier active-branch entries up to the invoking assistant, excluding all later entries. Cloning history may include system checkpoints, compactions, summaries, context edits, and tool results, not just user text.

Clone the invoking assistant entry and remove every `toolCall` block, including sibling calls from the same batch. Preserve remaining thinking and text in order and change `toolUse` to `stop`. Retain a thinking-only cleaned entry; omit only an empty cleaned entry. Append the child marker linked to the cleaned entry, or the invoking entry's parent if cleaning removed all content.

Keep the current synthetic assistant boundary representation for this path, linked after the marker with a fresh entry ID, zero usage, no source response ID or reasoning signature, and `stopReason: "stop"`. Its content is the V2 common boundary plus inherited-context framing and the selected role contract. It must not treat previous assistant actions or requests as the child's own work or active task.

### `isolated`

Construct a new native session in memory rather than projecting the parent branch:

```ts
// Construction algorithm; not an assertion of completed implementation.
const child = SessionManager.inMemory(cwd, { parentSession: parentPath });
const sessionId = child.getHeader().id;
child.appendCustomEntry("pi-async-fork-child", {
  version: 1, sessionId, forkId,
});
child.appendCustomMessageEntry(
  "pi-async-fork-boundary",
  buildForkBoundary(forkId, role, "isolated"),
  false,
);
// mkdir async-forks as needed; serialize header and entries as JSONL.
await writeFile(childPath, serializeJsonl([
  child.getHeader(), ...child.getEntries(),
]), { mode: 0o600, flag: "wx" });
```

Keep the current path shape `<parent session directory>/async-forks/<sessionId>.jsonl`. Use the native in-memory header and entry IDs/links, then the existing exclusive secure writer. Do not use persistent `SessionManager.create()` followed by chmod: its initial permission depends on umask, and chmod afterward leaves a permission window. Do not alter process-global umask.

The initial isolated file contains only the new header, root child marker, and new boundary `custom_message`. It contains no parent messages, thinking, checkpoints, compactions, context edits, branch summaries, response metadata, or invoking-assistant clone. The custom boundary needs no provider/model/usage metadata. `display: false` hides it from normal UI, not from model context; Pi converts custom-message content to user context. The assigned task is delivered separately through the existing `agent.send()` flow.

Do not copy or fabricate a system checkpoint in the host. Pi must load the worker's own profile/resources and declare its current system/tools during initialization of the first request, including when that checkpoint follows the initial boundary in persisted entry order.

`parentSession` is lineage metadata, not a history-import instruction. Preserve it. Acceptance requires demonstrating no indirect parent-history recovery on the real worker path while the link remains intact and the parent file remains present and readable; inspecting the initial JSONL alone is insufficient.

### Marker and prompt composition

Both modes retain the `pi-async-fork-child` custom marker with version `1`, fresh child session ID, and public fork ID. The marker is extension state outside model context. Detection uses all entries and requires the marker session ID to match the header; copied ancestor markers do not identify a new session.

Compose boundary content as common ownership/one-off rules + context framing + a small role contract + the existing report contract. Do not duplicate the entire prompt per role. The exact identity prefix is `I am a fork. I am not the main agent.` In inherit framing, earlier conversation belongs to the main; in isolated framing, the prior conversation was not supplied and the explicit task/evidence is the available conversational basis. Do not claim inherited context exists in isolated mode.

The common boundary commits the worker to the assigned task, bounded scope, no adjacent work, and reporting material ambiguity. Explicitly prohibit `create_fork`, `fork_status`, `steer_fork`, `cancel_fork`, shell/CLI delegation, and other delegation tools even when available. Preserve the two-section `Output`/`Learnings` report protocol and prohibition on deferring completion to later runs, future wake-ups, passive waits, or background continuations. This prohibition is capability-based, not tool-name-based; ordinary tools returning in the current run remain allowed. Keep the fork ID at the end of the boundary.

History isolation does not change `cwd`, `agentDir`, env, permissions, resources, or external memory availability. The same project/profile can supply instructions in either mode.

## Parent-session ledger

The parent Pi session is the source of truth for fork ownership in that session branch.

The extension appends only these lifecycle custom entries:

```text
fork.created
fork.destroyed
```

`fork.created` is appended only after pi-fleet creates the agent and `agent.send()` accepts the initial task. It records the fork ID, pi-fleet name, immutable pi-fleet agent ID, selected state directory, child session path, selected effort under the existing required `tier` field, effective `role`, effective `context`, and description. Persist resolved context even when omitted by the caller. Do not duplicate `tier` as another ledger `effort` field.

The parser retains its required valid `tier` contract and accepts historical records without role/context. Missing historical role means unknown/legacy, never inferred from tier or task. Missing historical context means `inherit`, matching the former session construction. Description remains optional for old records; legacy `triggerTurn` is accepted and ignored. Validate new fields when present; malformed values are not silently treated as historical absence.

Do not migrate old ledger entries or child session files, infer historical roles, retrofit new prompts into restored workers, or change their selected model. Historical parse/render compatibility does not permit new creation calls missing role or effort.

`fork.destroyed` is appended only after pi-fleet destruction succeeds. It identifies the same fork and immutable agent ID, and stores the final output or situation notice, its kind, and the pi-fleet cursor when available for parent-delivery replay.

The extension rebuilds the fork ledger by reading relevant custom entries from root to tip of the active session branch. The projection retains every fork created on that branch. A create without a matching destroy is active, while a fork with both entries is historically completed.

Fork records on inactive or sibling session branches are not part of the current projection. Historical completed records remain available to `fork_status`, but their internal child session paths are not returned through tool output.

Normal tool failures return errors directly. V2 does not add intent/outcome records, a transactional workflow engine, or a second state database. A crash between an external pi-fleet action and its session entry can leave an orphan or stale record. Recovery handles that case through status and identity checks.

## Restart and lifecycle behavior

On `session_start`, the extension:

1. Reads the current active branch and rebuilds the fork inventory.
2. Connects to the configured pi-fleet state directory.
3. Restores each active fork by its pi-fleet name.
4. Verifies the returned immutable agent ID against the ledger.
5. Checks status so pi-fleet can recover a missing worker and determine settlement or a no-result condition.
6. Restarts report receivers for active forks.
7. Resends missing progress or completed `fork.destroyed` reports only when parent custom-message metadata has no match.

Restoration uses the recorded agent name and immutable ID, not a new profile selection from tier/role/context. Role/context are persisted contract and display metadata; they do not cause session reconstruction or a prompt retrofit. Existing workers retain their original session and runtime configuration.

On `session_shutdown`, the extension stops receivers and closes its SDK client. It does not destroy active pi-fleet agents.

A restored fork with a missing name or mismatched immutable ID is not adopted or destroyed automatically. The extension reports the inconsistency through status.

Receiver and delivery callbacks must use a session generation guard. An old callback must not deliver into a replaced session or a different active branch. Completion processing must also recheck active-branch ownership before destruction, ledger writes, or parent delivery.

## Configuration

Configuration lives under `pi-async-fork` in normal Pi settings.

```json
{
  "pi-async-fork": {
    "agentDir": "/home/elpapi/.pi/profiles/async-fork",
    "stateDir": "~/.pi-fleet",
    "env": { "PI_OBSERVATIONAL_MEMORY_PASSIVE": "1" },
    "fast": {
      "provider": "openai-codex",
      "model": "gpt-5.6-luna",
      "thinking": "medium"
    },
    "balanced": {
      "provider": "openai-codex",
      "model": "gpt-5.6-terra",
      "thinking": "high"
    },
    "deep": {
      "provider": "openai-codex",
      "model": "gpt-5.6-sol",
      "thinking": "high"
    }
  }
}
```

The configuration has five concepts only:

- `agentDir`: optional complete global Pi profile for every fork. Omit it, or set it to `null`, to let pi-fleet use Pi's default profile. A project `null` overrides a configured global path;
- `stateDir`: optional pi-fleet state-directory selector. Omit it, or set it to `null`, to use pi-fleet's default `~/.pi-fleet` state directory. A project `null` overrides a configured global path;
- `env`: optional string-to-string overlay for fork Pi processes. It is not applied to the parent Pi process or pi-fleet worker;
- `fast`, `balanced`, and `deep`: model and thinking profiles.

`PATH` and `PI_CODING_AGENT_DIR` are reserved. Environment names must be non-empty and cannot contain `=` or a null byte. Values must be strings without null bytes. Empty string values are valid. Do not use `env` for secrets: pi-fleet persists values in agent state and backups, and child processes can expose them in logs or activity.

The explicitly required effort alone selects a profile and maps it to Pi model flags when the agent is created. Role and context must not select, alter, or validate profiles differently. The three profiles and all existing settings/merge rules remain unchanged; V2 introduces no role profiles, effort default setting, or automatic model-routing configuration. The resolved `env` map passes only to that Pi child. Pi-fleet persists it through Pi and worker recovery. Existing forks retain their immutable recorded map until destruction, so configuration changes affect only new forks. pi-async-fork does not duplicate this map in its session ledger. A missing or invalid selected profile leaves the auto-discovered extension inactive and makes all four tools return the same configuration error. It must not fail Pi session startup. Reload or restart Pi after adding valid configuration.

Global and project settings both apply. Project scalar settings replace global values. A project `null` for `agentDir` or `stateDir` explicitly selects the corresponding Pi or pi-fleet default. A project effort profile replaces the matching global profile as one complete profile. Project `env` objects merge by key with global values: a project string overrides one value, a project key set to `null` removes one inherited value, `env: null` clears all inherited values, and `env: {}` retains inherited values. Omitted or empty resolved maps pass no SDK overlay.

## Fork Pi profile

Pi's default agent directory is `~/.pi/agent`. `PI_CODING_AGENT_DIR` selects another global Pi profile before Pi starts.

When configured, the fork `agentDir` is the complete worker-profile boundary. It can contain its own `settings.json`, `SYSTEM.md`, `AGENTS.md`, extensions, skills, prompts, themes, model definitions, package resources, and credentials policy. When it is omitted or `null`, pi-fleet starts the worker with Pi's default agent directory instead. When `stateDir` is omitted or `null`, the extension omits the SDK option and pi-fleet uses `~/.pi-fleet`.

The profile controls stable resources and extensions. It does not contain fork-specific identity, role contract, task text, or report instructions. The extension adds identity, context framing, role contract, and the common report contract in a boundary at the child-session tail: synthetic assistant for inherit, native custom message for isolated. The next user message contains the unchanged assigned task followed by the progress protocol and concise requirement for the exact `Output` and `Learnings` headings. Profile/system resources remain independent of history mode.

`pi-async-fork` does not maintain an extension allowlist or pass individual extension flags to child Pi processes. The selected profile determines the fork's extension set. If the profile loads `pi-async-fork` inside a marked child session, the extension does not start its controller and all four async-fork tools return a task-focused child-session error. `Controller.create()` and `Controller.cancel()` repeat the guard for internal call paths.

Project-local `<cwd>/.pi` resources remain separate from the selected global agent directory. The fork profile's trust policy decides whether non-interactive Pi loads those project resources. Root and ancestor `AGENTS.md` context remains a Pi concern.

## Runtime guarantees and instruction contracts

Runtime must validate required role/effort and optional context before side effects, resolve context defaults, select the profile solely by effort, persist effective metadata, construct the correct session mode, and maintain the session-ID marker and this extension's child-tool guard. Preserve existing branch/identity/generation checks and lifecycle semantics.

Read-only, main ownership, bounded scope, no adjacent work, no indirect shell/CLI delegation, and ambiguity handling are prompt/task contracts. No universal tool guard or OS permission guarantee enforces them in V2. Removing edit/write tools would not make bash/custom tools read-only and is out of scope. Context isolation does not create a filesystem/security boundary. The lifecycle queue does not serialize worker execution or prove disjoint write surfaces.

## Coordinated instruction migration

Update the extension schema/descriptions, role/context prompts, README, tests, and the active `/home/kaique/.pi/agent/APPEND_SYSTEM.md` as one coherent V2 delivery. Do not leave a final configuration where the extension allows `execute + fast` but the loaded system prohibits fast implementation. Replace conflicting rules; merely appending V2 guidance is insufficient.

In APPEND_SYSTEM, remove fast = read-only, implementation = balanced, automatic evidence/judgment/implementation escalation by effort, and assumptions of capability relative to the main. Select role from work/authorization, effort from remaining reasoning uncertainty, and context from useful history versus anchoring. Update task contracts, speculative investigation, memory/context framing, and role-based write coordination. Preserve main ownership, bounded one-off work, fork-first without ceremony, no duplicate work, event-driven async delivery, no idle polling, no nested/adjacent work, and existing project authorization. Include `cancel_fork` in prohibited child operations.

Any retained effort-specific concurrency ceilings are resource/cost budgets only, not write-safety rules. Remove unlimited fast concurrency justified by read-only. Do not add an obligatory investigate → execute → verify pipeline or automated model escalation.

Pi can load a different agentDir or a trusted project APPEND_SYSTEM instead of the global append; project and global append are not necessarily combined. Verify the actually selected instruction sources for the supported worker profile, and document that external profiles carrying old routing rules must also be updated. Isolated history still loads those profile instructions.

## pi-fleet dependency

`pi-async-fork` requires `@elpapi42/pi-fleet-sdk` version `0.14.0` or later. This version provides public per-agent `agentDir` and child-Pi `env` creation options:

```ts
client.create({
  name,
  cwd,
  agentDir,
  env,
  piArgs,
})
```

pi-fleet persists both values in its agent record. It sets `PI_CODING_AGENT_DIR` from `agentDir` and applies `env` only when it starts or recovers that agent's Pi process. It does not apply `env` to the pi-fleet worker or SDK process.

## Proposed module structure

```text
src/
  index.ts
  configuration.ts
  forks/
    controller.ts
    identity.ts
    ledger.ts
    session.ts
    agent.ts
    delivery.ts
    render.ts
    task-prompt.ts

test/
  index.test.ts
  configuration.test.ts
  forks/
    controller.test.ts
    identity.test.ts
    ledger.test.ts
    session.test.ts
    agent.test.ts
    delivery.test.ts
    render.test.ts
    task-prompt.test.ts
  integration/
    isolated-context.mjs
```

The `forks/` directory is one cohesive feature boundary. Its files use that directory context instead of repeating a `fork-` prefix.

- `index.ts` registers Pi tools and lifecycle hooks, requires role and effort in the creation schema, describes independent role/effort/context semantics, and forwards creation options. It creates and stops the session-scoped controller without implementing fork lifecycle behavior.
- `configuration.ts` loads and validates `agentDir`, `stateDir`, `env`, and the three effort profiles. Configuration types remain with this module.
- `forks/controller.ts` validates/resolves creation options, selects profiles only by explicit effort, passes role/context into session construction, and persists effective metadata. It coordinates accepted creation, steer, status, explicit cancellation, restoration, branch protection, ordered report classification, settlement, situation notices, and finalization. It owns current in-memory fork state and the session generation guard, but no low-level storage, SDK, or message-formatting logic.
- `forks/identity.ts` owns name validation, seven-digit suffix generation, ID formatting, and collision attempts.
- `forks/ledger.ts` owns `fork.created` and `fork.destroyed` entry shapes, active-branch projection, historical lookup, lifecycle writes, and replayable output records.
- `forks/session.ts` owns invocation validation, inherited projection, native isolated construction, child-session marker/detection, mode-appropriate boundary entries, secure retained JSONL creation, and unregistered-session cleanup after creation failure.
- `forks/agent.ts` is the only module that imports the public pi-fleet SDK. It owns client lifetime, agent creation and restoration, status monitoring, ordered activity receivers, serialized steering, and destruction.
- `forks/delivery.ts` is the only module that calls `pi.sendMessage()`. It owns serialized parent progress, final, and notice delivery, model-visible envelopes, display metadata, and replay detection.
- `forks/render.ts` owns the async-fork TUI rendering. It transfers returned fork IDs and states through Pi's row-local renderer state, updates its retained call components directly without reentrant invalidation, hides normal successful fork output, and renders observed activity only in expanded successful `fork_status` output.
- `forks/task-prompt.ts` owns common boundary text, context framing, small role contracts, bounded-worker instructions, milestone-report protocol, and the full `Output` and `Learnings` report contract. It also owns the assigned-task user message, its evidence-, state-, novelty-, and brevity-gated progress-report requirement, and its concise final-response format requirement.
- `test/integration/isolated-context.mjs` exercises actual registered creation and real Pi/fleet workers against a local recording provider; it proves effective-context isolation, not just file construction. A main process must execute it because it creates agents; a bounded child may prepare it but must not bypass the no-nested-delegation rule to run it.

Types remain with the module that owns their meaning. V2 has no generic `utils`, `helpers`, `models`, `constants`, shared-code directory, repository abstraction, generic pi-fleet wrapper, custom database, cost footer, subprocess runner, JSONL event parser, or copied `pi-fork` architecture.

## Scope and non-goals

The extension does not provide workspace isolation. Fork agents share the project working directory, so the extension does not claim that concurrent writes are safe. The main/caller and harness policy remain responsible for write coordination, including the main's own writes.

Coordinate by work and role, not effort: serialize `execute` forks by default regardless of model. Parallel execution requires known disjoint write surfaces and relevant shared resources. Independently bounded `investigate`/`verify` work may run concurrently only without conflicting effects. Read-only tests can still contend for databases, caches, ports, and services; isolated conversation does not remove those conflicts.

It does not include:

- long-lived specialized agents;
- user-facing agent management;
- recursive async forks;
- a custom database or job engine;
- cost footer or cost aggregation;
- direct imports from `pi-fork` internals;
- exactly-once parent-result delivery guarantees;
- `write_scope`, locks, a new scheduler, or workspace/security sandbox;
- per-tool role permissions;
- a mandatory role pipeline, automatic model routing, or autonomous escalation.

Synchronous `pi-fork` remains separate and active.

## Validation required

Before daily use, prove:

1. Each child receives a distinct retained session with correct lineage and secure `0600` initial permissions. Inherit receives the intended active-branch cut; isolated receives only a fresh header, root marker, and native custom boundary before task delivery.
2. Inherit projection removes all invoking tool calls, preserves ordered text and thinking, changes `toolUse` to `stop`, and creates no synthetic missing-tool results. Isolated does not copy any invoking-assistant metadata or parent context-producing entries.
3. Inherit retains a thinking-only cleaned assistant and omits an empty one. Both modes place a valid child marker before their boundary, and reject a missing current `toolCallId`.
4. The marker contains version `1`, current child session ID, and public fork ID. Detection uses all entries but only matching header IDs. Boundaries link after the marker with distinct IDs and the fork ID at the end. The inherited assistant boundary has zero usage and no source response ID or reasoning signature; the isolated `custom_message` needs none of that assistant metadata and participates in context despite `display: false`.
5. Multiple `create_fork` calls from one assistant batch produce sibling sessions from the same cut point.
6. `create_fork` creates the child session and fleet agent, starts reception, sends the assigned task followed by the evidence-, state-, novelty-, and brevity-gated progress-report requirement and concise final-response format requirement as user content, receives initial-task acceptance, appends `fork.created`, and returns before the child completes.
7. Initial creation or task-send failures destroy any created agent, remove the unregistered child session, write no ledger entry, return a clear error, and report cleanup failure when it occurs. Uncertain sends are not retried.
8. Each receiver preserves visible `message.finished` reports and ordered later activity. A later activity marks the previous held report as continued. Current `working` status permits its progress delivery, while terminal status remains authoritative.
9. An idle fork waits ten seconds from its first terminal-state observation before classifying only its latest held report as final. Delayed activity can release progress only after current status returns to `working`. An idle fork with no held report, or an interrupted or failed fork, produces a plain situation notice without extension-level recovery and then follows the normal destruction and replay path.
10. `fork_status` forwards raw pi-fleet states for active forks, treats idle forks as not steerable, and returns `completed` only for historical destroyed forks.
11. A progress, response, or notice reaches the parent in report order with the fork-ID prefix and its explicit model-visible classification sentence. Progress says steering remains possible; response and notice say it is not.
12. Progress reports remain active-fork delivery history only. They do not add lifecycle records. Cursor metadata deduplicates already persisted progress and final reports across active-branch replay.
13. Several progress or final reports cannot race parent delivery while the parent is idle.
14. Automatic destruction occurs only when the owning branch is active, follows the required finalization order, writes replayable final output to `fork.destroyed`, and does not delete the child session file.
15. A progress, response, or notice is not delivered, destroyed, or recorded while its owning branch is inactive. Progress and final handling resume only when that branch becomes active.
16. Session restart rebuilds active fork inventory and reconnects receivers. An active working fork resends missing progress only when custom-message metadata has no match. A destroyed fork resends missing completed output from `fork.destroyed` under the same rule.
17. Machine or worker recovery preserves the configured `agentDir` profile, or continues with the default profile when no `agentDir` is configured.
18. Name reuse with a different immutable pi-fleet agent ID is detected and never adopted.
19. Parent session replacement or branch change prevents stale receiver delivery.
20. Both boundary modes start with `I am a fork. I am not the main agent.`, preserve the common one-off identity/scope/report rules, prohibit all four async-fork tools and indirect delegation, and prohibit capability-equivalent deferred completion without relying on tool names. Context framing differs correctly: inherit assigns previous conversation to the main and marks prior requests inactive; isolated does not claim to have received that conversation. Role contracts allow bounded `execute + fast` implementation, keep investigate/verify read-only at any effort, and require reporting material ambiguity. Preserve the two-section checkpoint/final report contract and same-response next-tool-call rule. The assigned user task retains the evidence-, state-, novelty-, and brevity-gated progress requirement and both exact final headings even for one-line tasks.
21. A marked child does not start an async-fork controller. All four public async-fork tools reject calls with the same task-focused error. Direct `Controller.create()` and `Controller.cancel()` calls repeat the guard before lifecycle work.
22. Fork names enforce the one-or-two-word rule in the tool and parameter descriptions, reject agent-supplied numbers, and produce IDs with exactly seven generated digits.
23. Fork IDs avoid current-branch history collisions and retry pi-fleet name collisions.
24. `create_fork` requires a single-line 3-to-6-word description, trims valid outer whitespace, rejects C0/C1 controls and `U+2028` or `U+2029`, validates it before side effects, and persists it in new `fork.created` records. Historical records without a description remain valid.
25. The collapsed new `create_fork` call displays role, explicit effort, effective context, public ID, and description on one line; the pending state uses `<name>-…`. Historical effort/tier-only calls remain renderable without an invented role, and old entries without descriptions retain their headers. Expanded creation adds only the full task. Progress/final/notice headers retain their description, steer message appears only expanded, and status displays its state/description with activity only expanded. Normal successful output/usage/cost/expansion hints stay hidden; errors remain visible.
26. Result custom-message content includes the fork-ID prefix and an explicit progress, final, or notice sentence for model context. The description appears only in display metadata. The TUI renderer shows `working` for progress, `completed` for final output, and `terminal` with a warning for notices. It shows Markdown output only in Pi's global expanded mode and never shows internal agent IDs, cursors, or the model-only sentence.
27. Progress never wakes you. Final reports and terminal notices always wake you when idle or queue steering during active work, including restored and replayed legacy records with `triggerTurn: false`. New records omit `triggerTurn`; historical parsing accepts and ignores it. Terminal model context instructs you to process the report internally without user-visible acknowledgment unless communication is material.
28. The extension does not imply workspace isolation or safe concurrent writes.
29. Environment configuration merges global and project values by the documented key rules, rejects reserved or invalid entries, reaches only new child Pi processes, and preserves empty strings. It is absent from the async-fork ledger, while pi-fleet persists and recovers it.

30. Explicit cancellation destroys exactly once, records a notice and requests notification only after destruction succeeds, and preserves the retained child session. Repeated calls and both completion/cancellation queue orders retain one outcome. Late callbacks cannot overwrite cancellation. Invalid branches, mismatched identities, stale contexts and active navigation cannot destroy an agent. A pause left by vetoed or aborted navigation can recover safely. Abort before destruction has no effect; abort during destruction does not abandon bookkeeping. Destruction, recording (including in-memory mutation before error), and notification-request failures are distinguishable. A recorded cancellation can replay a missing notification without another destruction.
31. A real worker in an isolated test environment running a harmless native shell command can be cancelled through the registered tool. Verify worker and tracked-shell termination, retained JSONL, cancellation notice, repeated cancellation, and completed status without assuming external side effects were undone. Retain existing cancellation tests and behavior across V2 rather than substituting role/context tests for them.
32. New calls reject absent/invalid role or effort before side effects. Test all nine role/effort combinations and both context overrides for every role; verify context defaults and profile selection independent of role/context. There is no silent effort default or inferred role.
33. Ledger tests preserve required `tier`, parse historical absent role as unknown/legacy and absent context as inherit, reject invalid present fields, and persist new effective role/context. Restore old and new forks by immutable agent identity without profile reselection, historical mutation, or prompt retrofit.
34. The effective-context integration gate below passes with real worker initialization. Initial JSONL inspection or unit projections alone cannot approve isolated.
35. Extension descriptions, role/context boundary tests, README, and the actually loaded APPEND_SYSTEM agree: execute + fast is permitted within authorization, and investigate/verify remain read-only contracts at every effort. No stale fast-read-only or implementation-balanced routing remains in the supported profile.

Use unit tests with a fake pi-fleet SDK and isolated real Pi plus pi-fleet integration tests. Unit tests alone cannot prove RPC startup, agent-directory selection, session loading, steering delivery, recovery, or the absence of indirect context import.

### Decisive isolated-context integration gate

Do not declare isolated complete until the real registered tool → child file → fleet → Pi → provider path proves history isolation. Execute workers in a disposable profile/cwd/private fleet with a deterministic OpenAI-compatible loopback endpoint and dummy credentials; do not use personal credentials or provider quota. Disable automatic compaction, retry, cache warming, and unrelated network/resource loading so assertions are attributable to the test.

Record both surfaces without changing context:

- the effective worker transcript before provider conversion, including system and tools (`context_with_system` on Pi versions supporting it);
- the actual HTTP request received by the loopback provider through Pi's real adapter.

Use fixtures built with the tested Pi version's native entries and unique sentinels present only in parent history, never in task, settings, environment, or shared instruction files. Cover user/assistant/tool-result messages, assistant thinking and invoking-assistant remnants, compaction summaries, retained messages, context-edit replacements, branch summaries, system updates, and compaction/system checkpoints where that version supports them. Include parent raw-history sentinels discarded by compaction/editing as negative probes, but distinguish them from sentinels actually effective in parent context.

Run paired inherit and isolated forks against the same fixture with identical role/effort, e.g. verify/fast, and explicit context mode. Correlate captures by child session ID and a task nonce, not sentinel text in the task. Inherit is the positive control for effective conversational sentinels, summaries, edits, and supported thinking. Verify fixture projection first; an inactive or discarded fixture entry is not a valid positive control. Configure thinking replay supported by the adapter, e.g. `reasoning_content` for the local OpenAI-compatible fixture. A parent checkpoint may be replaced by the worker's current system before transmission; record that normal transformation rather than demand an impossible wire-positive checkpoint.

For isolated, assert absence of every parent sentinel in both effective transcript and provider wire request. Positively assert worker boundary, assigned task/nonce, and worker-only system instruction so empty, failed, or miscorrelated captures cannot pass. Confirm successful provider completion, valid child marker, and `header.parentSession` equal to the actual parent path. Keep that parent file present and readable throughout; do not hide/delete it or sever lineage to make the test pass. Any import via parentSession is a gate failure. Preserve sanitized evidence, tested versions/capabilities, coverage and non-applicable categories, and private-fleet cleanup results.

Version handling must be explicit: declared Pi minimum is 0.85.0; the inspected checkout resolves 0.85.1, and the inspected global runtime is 1.0.1. The inspected 0.85.1 lacks `context_with_system` and context-edit APIs; use its supported conversational `context` event plus actual wire capture and supported fixtures, without pretending modern cases were exercised. Run the full transcript/system/context-edit/checkpoint coverage on 1.0.1. Validate the declared 0.85.0 minimum separately before claiming support, and document any version-specific unavailable observation. Native in-memory construction checks on 0.85.1/1.0.1 do not substitute for these real-worker tests.

This gate proves effective session-history isolation with retained lineage on the tested versions. It does not prove filesystem isolation, read-only enforcement, model quality, unbiased verification, or human TUI behavior.

## Known limits and open details

- `message.finished` has no task or tool-call correlation. The extension classifies a held report from later ordered activity or terminal grace. This requires real integration evidence.
- The ten-second terminal-state grace period is a deliberate first-version heuristic, not proof that pi-fleet activity replay has caught up. Delayed continuation beyond ten seconds can classify an intermediate report as final, while delayed final activity can still produce a no-result notice.
- `pi.sendMessage()` has no delivery acknowledgement. A queued progress report can be lost if the parent exits before Pi consumes and persists it. Cursor duplicate suppression applies only after the parent custom message exists.
- `steer_fork` checks status before adaptive delivery, but pi-fleet does not make that check and send atomic. A fork can become idle within that small interval.
- pi-fleet currently defines `failed` publicly but may not assign it in all failure paths. The extension forwards raw returned states and handles any returned `failed` as a no-result condition.
- Pi and pi-fleet do not share an atomic transaction. V2 retains the existing handling of rare stale or orphan records and reconciles them conservatively. A failed initial cleanup can still leave an unregistered external agent or child session.
- Pi branch navigation has restart semantics that need integration testing for a branch-scoped fork inventory.
- The child-session file location, custom-entry renderer, and exact status response schema remain implementation details.
- The child-session marker blocks this extension's tools. It does not block direct pi-fleet CLI commands through a shell; stronger command isolation requires a restricted profile or sandbox.
- The fork profile's `defaultProjectTrust` and credential strategy remain explicit profile decisions.
