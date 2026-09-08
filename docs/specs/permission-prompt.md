# Spec: TUI permission prompt

> Status: **complete 2026-09-30** — implemented, reviewed, live-smoked; the CLI surface for asks is docs/follow-ups/permission-cli.md (re-synced 2026-09-29 to the protocol/stream-merge refactor: `src/core/protocol/`, `protocol-server/`, stamped query-stream events). Derisk artifacts:
> `docs/derisk/permission-prompt/` (FINDINGS.md, probe payloads under
> `out/*.json`, native dialog captures under `out/*.claude.txt`). Verified
> against SDK 0.3.258 / claude 2.1.258; implemented against SDK 0.3.280 /
> claude 2.1.280 (see "Implementation-Time Decisions" for the `canUseTool`
> options that version added).

# SPEC

## Problem

The daemon sets no `canUseTool`, so every permission "ask" the CLI raises is
a terminal denial (`system/permission_denied`) — the model is told the tool
was rejected, and no human ever sees the question. This holds for every
mode: `auto` mode escalates to an ask too (verified: `rm -rf <outside cwd>`
under `permissionMode: "auto"` asked; plain `ls` asked in neither mode).

We want claude's behavior: the tool blocks until a human answers, and an
attached TUI renders the same dialog native claude renders, with the same
options and the same consequences.

## Definitions

- **Ask**: one `canUseTool` invocation. Identified by its `toolUseId`.
- **Pending ask**: an ask the daemon has received and nobody has resolved.
  Lives in `AgentState.pendingPermissions`, arrival-ordered.
- **Resolution**: `allow` (with the chosen permission updates), `deny`
  (with a message that becomes the tool result), or `cancelled` (the CLI
  aborted the ask — interrupt — or the Query was torn down).
- **Plain deny**: `No` / Esc. Sends claude's fixed message (below).
- **Amended deny**: Tab (or the plan dialog's "Tell Claude what to change"
  row) opens a one-line input; Enter sends the typed text as the deny
  message. This embeds the text in the tool result (no extra API round
  trip); we expose it because it is the SDK's API, knowing the model
  sometimes misreads such tool results.
- **Task**: an entry of the CLI's task map (`system/task_started` …
  `task_notification`): a subagent (`local_agent`), a background shell,
  an MCP task, a workflow. `AgentState.tasks` holds the live ones.
- **Blocked**: the main agent or a task has a pending ask. An ask from
  the main agent only happens mid-turn (`activity` is `working`); a
  task's ask can arrive while the main agent is `idle` — verified: a
  background subagent asked after the top-level `result`, and a prompt
  pushed meanwhile ran at once (FINDINGS.md, "Background-subagent ask").
  So a pending ask never changes `isIdle`; only the asking tool use is
  stalled.
- **Quiescent**: `isIdle` and no live tasks — nothing would be killed by
  a Query restart.

## Success criteria

1. **Always block.** With no subscriber attached, an ask stays pending
   indefinitely (no deadline, no implicit deny). `tail` prints one line when
   the ask appears and one when it resolves; the subscribe snapshot lists
   every pending ask, so a later attach sees and can answer it.
2. **Dialog parity.** For Bash, Edit, Write, Read, WebFetch, and
   ExitPlanMode the TUI dialog matches the native capture in
   `docs/derisk/permission-prompt/out/<tool>.claude.txt` in title, body,
   question, row labels, and hint line (plain text; ANSI is a later parity
   pass, as in tui-parity.md). Every other tool (MCP tools included) gets
   the generic dialog: title `displayName ?? toolName`, body `Name(arg)` +
   args, question `Do you want to proceed?`.
3. **Options work.** Row 1 allows. Row 2 (present only when the ask carries
   suggestions) allows with `updatedPermissions = suggestions` — the full
   set, as the SDK doc prescribes; its label is derived from the
   suggestions (table below). The final row / Esc is a plain deny. Tab is
   an amended deny. A digit selects the row displaying that number; ↑/↓ +
   Enter select the highlighted row. An ask with `suppressAlwaysAllowRule`
   has no row 2 even with suggestions; one with `defaultToNo` opens on its
   last row and ignores digits.
4. **Every subscriber agrees.** Two attached TUIs both show the dialog;
   the first `permission-response` wins, the loser's dialog closes on the
   `permissionResolved` event and its own late response fails silently.
5. **Interrupt dismisses.** ctrl+c (`app.interrupt`) while the dialog is up
   sends `interrupt` as usual; the CLI aborts the ask, the daemon emits
   `permissionResolved cancelled`, and every dialog closes. `set-context`
   requires `isQuiescent(state)` (a Query restart kills every task, ask
   or no ask — today it does so silently); `/compact` keeps its idle
   guard, switched to `isIdle(state)`. A pending permission is therefore
   only ever cleared by an explicit response, an interrupt, or daemon
   shutdown.
   Daemon shutdown cancels every pending ask (emitting their
   `permissionResolved cancelled`) _before_ emitting `shutdown`; no
   permission event follows `shutdown` (buffered `sdkMessage`s from the
   closing stream may).
6. **In order.** With several pending asks, the TUI shows the head of
   `pendingPermissions` and a `(+N more)` note; resolving it shows the next.
7. **Parity is checked, not assumed.** `scripts/tui-parity/capture-dialogs.ts`
   captures native claude's live dialogs and the clauctl TUI's for the
   scenario list below, normalizes, and diffs them like the transcript
   harness does. It checks rendering and the plain-deny path only (nothing
   is ever approved); allow consequences and races are covered by unit
   tests and the smoke. AskUserQuestion is captured on the claude side
   only (its clauctl counterpart is a follow-up spec) so drift is noticed.

## Dialog layout (from the captures)

```
────────────────────────────────────────  (full-width rule)
 <title>

   <body lines>                            (indented 3)

 <question>
 ❯ 1. Yes
   2. <row-2 label>                        (omitted when no suggestions;
   3. No                                    numbering then unverified — below)

 Esc to cancel · Tab to amend
```

Blank lines and the 3-space body indent match claude. No activity spinner
while an ask is pending (claude shows none; the dialog is the status).

Per tool (title / body / question):

| tool         | title                                                                                                      | body                                                                                                 | question                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Bash         | `Bash: <description>` (`Bash command` without one; decided: claude puts the description under the command) | command                                                                                              | `Do you want to proceed?`                                                          |
| Edit         | `Edit file`                                                                                                | basename; `╌` rule; `-` old_string lines then `+` new_string lines; `╌` rule                         | `Do you want to make this edit to <basename>?`                                     |
| Write        | `Create file`                                                                                              | basename; `╌` rule; line-numbered content; `╌` rule                                                  | `Do you want to create <basename>?`                                                |
| Read         | `Read file`                                                                                                | `Read(<path>)`                                                                                       | `Do you want to proceed?`                                                          |
| WebFetch     | `Fetch: <url>` (decided: claude has a `url:` body line)                                                    | `prompt: <prompt>`; `Claude wants to fetch content from <host>`                                      | `Do you want to allow Claude to fetch this content?`                               |
| ExitPlanMode | `Ready to code?`                                                                                           | `Here is Claude's plan:`; `╌` rule; plan markdown; `╌` rule                                          | `Claude has written up a plan and is ready to execute. Would you like to proceed?` |
| other        | `displayName ?? toolName`                                                                                  | `Name(headerArg)`; then one `key: value` line per input key in object order, values as one-line JSON | `title ?? "Do you want to proceed?"`                                               |

`title` (the SDK's "full permission prompt sentence", unpopulated over
stdio today) replaces the _question_ line of every dialog, known tools
included, when present.

The Edit body is a **decided divergence**: claude previews the file-anchored
line-numbered diff, which only exists once the tool runs (the transcript's
Edit view renders it from the result's `structuredPatch`). Recomputing it
before execution would duplicate the CLI's diff logic on a second code
path, so the preview shows the replacement itself, unnumbered.

ExitPlanMode's rows differ: `1. Yes, auto-accept edits` (allow,
`updatedPermissions: [setMode acceptEdits session]`), `2. Yes, manually
approve edits` (allow, no updates), `3. Tell Claude what to change` (opens
the amend input; Enter → amended deny). Its hint line is `Esc to cancel ·
ctrl+g to edit the plan` (claude's also offers Vim editing, a non-goal).
Esc is the plain deny on every dialog (`PermissionDialog.cancelDecision`).

WebFetch's native row 3 is the older `No, and tell Claude what to do
differently (esc)`; we render the uniform `No` + Tab-to-amend (decided
divergence: one deny model everywhere).

Row-2 label derivation (`suggestions` → label), first matching row wins;
`<dir>`/`<host>`/`<ruleContent>` come from the first element of the
matching update's `directories`/`rules`:

| suggestions contain                                           | label                                                                                                                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `addDirectories`                                              | `Yes, and always allow access to <dir> from this project`                                                                                                                                              |
| `addRules` for `WebFetch` with `domain:<host>`                | `Yes, and don't ask again for <host>`                                                                                                                                                                  |
| `addRules` for `Read` (session) with a path rule              | `Yes, allow reading from <dir> during this session` (`<dir>` = the rule's directory: `//` prefix → `/`, `/**` suffix stripped)                                                                         |
| only `setMode acceptEdits`                                    | `Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)` (key name hard-coded until docs/follow-ups/config-compilation.md passes bindings in) |
| `addRules` for any other tool (Bash command prefix, MCP tool) | `Yes, and don't ask again for <ruleContent ?? toolName> in <cwd>`                                                                                                                                      |
| anything else                                                 | `Yes, and don't ask again`                                                                                                                                                                             |

Rows 1–4 of that table are verified against captures; the last two are the
claude labels known from earlier versions and are **verification items**
for the capture harness (scenarios `bash-plain`, `mcp`). Also unverified:
how claude numbers the rows when there is no row 2 (`1./2.` vs `1./3.`).
Every captured permission ask so far carried suggestions, so no scenario
settles it yet; rows are numbered consecutively until a suggestion-less
ask is found (candidate: a `permissions.ask` rule in the harness settings,
which forces a prompt without suggestions — to be tried during
implementation and added as scenario `ask-rule` if it works).

Plain-deny message (claude's own text, sent verbatim):

> The user doesn't want to proceed with this tool use. The tool use was
> rejected (eg. if it was a file edit, the new_string was NOT written to the
> file). STOP what you are doing and wait for the user to tell you how to
> proceed.

## Type design

### Wire protocol — `src/core/protocol/` (`agent-event.ts`, `agent-state.ts`, `messages.ts`, `version.ts`)

```ts
import type { PermissionResult, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk";

/** One canUseTool call, serialized. Omits requestId (SDK-internal) and
 *  matchedAskRule (unobserved; add when a consumer needs it). */
export interface PermissionRequest {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  suggestions: PermissionUpdate[];
  blockedPath?: string;
  decisionReason?: string;
  /** The ask must not be approvable by one stray keystroke: the dialog
   *  opens on its decline row and takes no digit shortcut. */
  defaultToNo?: boolean;
  /** The ask must not offer a persistent "don't ask again" row: the rule
   *  it would write grants more than this ask's own action. */
  suppressAlwaysAllowRule?: boolean;
  /** The bridge's full prompt sentence; unpopulated over stdio today
   *  (FINDINGS.md) but the SDK says to prefer it when present. */
  title?: string;
  /** The CLI's user-facing tool name (`Greet` for `mcp__probe__greet`). */
  displayName?: string;
  /** The CLI's one-line subtitle (Bash description, file basename, url). */
  description?: string;
  /** The asking task's id (`task_started.task_id`) when the ask
   *  originates in a subagent; absent for the main agent. */
  agentId?: string;
}

// The answer is the SDK's own PermissionResult (allow with
// updatedPermissions/updatedInput, or deny with message/interrupt) — the
// socket exposes the SDK's full API, so no clauctl subset. The request has
// no SDK counterpart to reuse: SDKControlPermissionRequest is the raw
// control_request payload, consumed inside the SDK and never yielded on
// the Query stream (and not exported); what the SDK hands a host is the
// canUseTool argument list, which PermissionRequest serializes.

/** How a pending ask ended; carries the decision so every observer (a
 *  second TUI, `tail`) sees what was answered, not just that it was. */
export type PermissionResolution = PermissionResult | { behavior: "cancelled" };

// Both are daemon bookkeeping on the `query` stream (protocol.md): the
// ask sits at a definite point among the SDK frames (after the tool_use
// that raised it, before its tool_result). Neither payload carries a
// uuid, so the hub stamps `uuid` at emission; `eventStream` returns
// "query", `eventNodes` the stamped uuid, and the classification table
// excludes them from the session stream unconditionally — an id is shared
// across streams only when both observations are the same underlying
// event, and the session file never records a permission ask.
export type AgentEvent =
  | …existing…
  | { kind: "permissionRequested"; uuid: UUID; request: PermissionRequest }
  | { kind: "permissionResolved"; uuid: UUID; toolUseId: string; resolution: PermissionResolution };

export type ProtocolRequest =
  | …existing…
  // Response data: none. The socket client is trusted (it has whatever a
  // TUI or SDK user has, including persisting arbitrary rules), so the
  // decision is the raw SDK shape; the handler validates it structurally
  // (each PermissionUpdate variant's discriminant and required fields)
  // before it reaches the SDK. Fails with error text NOT_PENDING_ERROR
  // when the ask is not pending (resolved, cancelled, or unknown).
  | { type: "permission-response"; toolUseId: string; decision: PermissionResult };

export const NOT_PENDING_ERROR = "permission not pending";
/** The protocol client's request() wraps daemon errors as `daemon rejected
 *  <type>: <error>`; this is the one predicate clients use to recognize
 *  a lost permission race through that wrapping. */
export function isNotPendingError(error: unknown): boolean;
// version.ts — bumped from 2: new required snapshot field, new events,
// new request. A hello with another version now rejects connect()
// instead of warning: an old fold cannot represent a pending ask.
export const PROTOCOL_VERSION = 3;
```

`permissionResolved` is transient: a subscriber attaching after the
resolution sees only the ask's absence from the snapshot.

### State fold — `src/core/protocol/agent-state.ts` (types), `src/core/agent-state/` (fold)

```ts
/** One live entry of the CLI's task map (sdk.d.ts: "clients merge into
 *  their local task map"). A subagent is a task of type `local_agent`.
 *  Its transcript is `<session>/subagents/agent-<taskId>.jsonl` (entries
 *  carry the main session's id; `taskId` is the identity) — a per-task
 *  `session: SessionState` merged over that file is the planned
 *  extension (docs/follow-ups/subagent-activity.md), not part of this
 *  spec. */
export interface TaskState {
  readonly taskId: string;
  /** The tool use that spawned it; subagent frames carry it as
   *  `parent_tool_use_id`. Absent for CLI-started tasks. */
  readonly toolUseId?: string;
  readonly description: string;
  readonly taskType?: string;
  readonly subagentType?: string;
  readonly background: boolean;
  readonly status: "running" | "paused";
  /** The task's own asks, arrival order. */
  readonly pendingPermissions: readonly PermissionRequest[];
}

export interface AgentState {
  …existing…
  /** Live, non-ambient tasks in `task_started` order; a task leaves on a
   *  terminal `task_updated` status or its `task_notification`. */
  readonly tasks: readonly TaskState[];
  /** The main agent's own asks, arrival order. */
  readonly pendingPermissions: readonly PermissionRequest[];
}
// initialAgentState(): tasks: [], pendingPermissions: []
// fold-sdk-message.ts (top-level system frames, folded like init/status):
//   task_started (ambient !== true) → insert
//   task_updated → merge patch.status/description/is_backgrounded;
//                  completed | failed | killed → remove
//   task_notification → remove
// next-agent-state.ts (both stamped query nodes, observed like any other):
//   permissionRequested → append to tasks[agentId].pendingPermissions,
//     else to state.pendingPermissions; an agentId naming no live task is
//     a `classification`-style anomaly (the CLI announced no such task)
//     and the ask lands on the main list so it can still be answered
//   permissionResolved  → remove by toolUseId wherever it is
```

```ts
// agent-state/selectors.ts
export const isIdle = …unchanged (activity-based: "the CLI would run a prompt now")…
/** Nothing running anywhere: the main loop idle and no live task. What a
 *  Query restart (set-context) requires. */
export const isQuiescent = (state: AgentState): boolean =>
  isIdle(state) && state.tasks.length === 0;
/** Every pending ask, main agent first then tasks in order — what the
 *  TUI dialog and the snapshot line iterate. */
export const pendingPermissions = (state: AgentState): readonly { task?: TaskState; request: PermissionRequest }[];
```

`activity` and the queue model are untouched: a task's pending ask does
not stop the CLI from running a pushed prompt (verified), so
`isIdle` must keep meaning that. `wait --until quiescent` joins the
`--until` grammar as a named state condition: `until.ts` adds
`quiescent: isQuiescent` to `stateConditions` (the engine's vocabulary
is per-repo since pictl c3bf665, synced 2026-09-29); usage text and
completions follow automatically.

### Daemon — `src/core/protocol-server/permission-broker.ts` (new)

```ts
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

/** The canUseTool options → wire shape (drops signal/requestId/matchedAskRule). */
export function permissionRequestOf(
  toolName: string,
  input: Record<string, unknown>,
  options: Parameters<CanUseTool>[2],
): PermissionRequest;

/**
 * Owns the pending-ask resolvers. Invariant: after every synchronous
 * transition the broker's pending ids equal the hub state's
 * pendingPermissions ids — the fold is the observable projection of this
 * map, and only the transition that removes a resolver emits its
 * permissionResolved (exactly one per ask).
 */
export class PermissionBroker {
  constructor(events: EventHub);
  /** Transition order: throw if toolUseId is pending (clauctl invariant:
   *  one ask per tool use); if `signal.aborted` already, return the
   *  cancellation result at once — the ask is never observable, so
   *  neither event is emitted; else register resolver + abort listener
   *  and emit permissionRequested. Settles on respond(), abort, or
   *  cancelAll(); the abort/cancel result is `{behavior: "deny",
   *  message: "cancelled"}` — a value to settle the promise with, which
   *  the SDK has already stopped waiting for. */
  request(request: PermissionRequest, signal: AbortSignal): Promise<PermissionResult>;
  /** Removes the resolver, emits permissionResolved, settles — in that
   *  order; throws NOT_PENDING_ERROR when the toolUseId is not pending. */
  respond(toolUseId: string, decision: PermissionResult): void;
  /** Cancels every pending ask; idempotent, and a later abort signal for
   *  an already-cancelled ask is a no-op. */
  cancelAll(): void;
}
```

`EventHub.emit`'s accepted-kind subset gains `permissionRequested` and
`permissionResolved`.

`protocol-server/daemon.ts`: the `EventHub` (and the broker built on it) must exist before
the first `query()` — today the Query is constructed first, so the
construction order becomes hub → broker → `buildOptions`/`query()`.
`buildOptions` adds
`canUseTool: (toolName, input, options) => broker.request(permissionRequestOf(toolName, input, options), options.signal)`.
`cleanupAndExit` calls `broker.cancelAll()` before the shutdown drain
that precedes `events.emit({kind: "shutdown"})`, so every cancellation
precedes the farewell and the Query
close that follows finds nothing pending (a signal abort for an
already-cancelled ask is a no-op). `teardownQuery` also calls
`cancelAll()` before awaiting `readerDone` — unreachable while an ask is
pending (set-context requires quiescence, and a main-agent ask implies
`working`), kept so a stream waiting on an ask can never deadlock
teardown. `RequestHandlerDeps` gains `broker: PermissionBroker`;
`createRequestHandler` gains `case "permission-response"` → validate the
decision (`validatePermissionResult(value: unknown): PermissionResult`
in `permission-broker.ts`, checking `behavior`, `message`, and every
`updatedPermissions` entry against the `PermissionUpdate` union) →
`deps.broker.respond(...)`.

### Text formatting — `src/format/events.ts`

- `agentStateChunk`: after the queued/delivered lines, one
  `[task <taskId>: <description>]` line per live task, then one
  `[pending permission <toolUseId>: <tool summary>]` line per pending ask
  (`pendingPermissions(state)` order), a task's suffixed
  `(task <taskId>)`.
- `permissionRequested` → `[permission requested <toolUseId>: <tool summary>]`
  (same task suffix);
  `permissionResolved` → `[permission resolved <toolUseId>: <resolution>]`
  where `<resolution>` is `allow`, `allow + <n> permission updates`,
  `deny: <message>`, or `cancelled`.
- `<tool summary>` is the one-line `Name(arg)` form `messages.ts` already
  produces for `tool_use` blocks.

### TUI — dialog content

```ts
// src/tui/permission-views.ts — TUI-specific (a dialog, not transcript
// formatting), so it lives beside the dialog rather than on
// src/format/entry-view/tool-view/ToolView. Keyed by the generated input
// types (src/format/entry-view/tool-view/generated.ts) like toolViews.
export interface PermissionView<A> {
  title(args: A): string;
  question(args: A): string;
  /** Body lines, styled; the component indents and rules them. */
  body(args: A, cwd: string | undefined): string[];
}
export const permissionViews: { [K in ToolName]?: PermissionView<ToolInputMap[K]> };
// Bash, Edit, Write, Read, WebFetch, ExitPlanMode; absent → generic dialog
```

The generic body's `Name(headerArg)` line reuses `toolViewFor(name)`'s
`headerArg` from the format layer.

`permissionViews.Edit.body` styles `-` lines red and `+` lines green with
the same `claudeStyle` calls `formatStructuredPatch` uses; no file access.

```ts
// src/tui/permission-dialog.ts (pure; unit-tested against the captured payloads)
export interface PermissionRow {
  label: string;
  action: { kind: "decide"; decision: PermissionResult } | { kind: "amend" };
}
/** Everything the component renders; the component itself knows nothing
 *  about tools or permissions, so a follow-up (AskUserQuestion's answer
 *  picker) only supplies a different value of this type. */
export interface PermissionDialog {
  title: string;
  body: PermissionBodyLine[]; // string | { markdown: string }
  question: string;
  rows: PermissionRow[];
  /** What Esc sends. */
  cancelDecision: PermissionResult;
  /** Open on the last row (the decline) and take no digit shortcut. */
  defaultToNo: boolean;
  /** Whether Tab opens the amend input (false for ExitPlanMode, whose
   *  row 3 is the amend action). */
  tabAmends: boolean;
  /** ExitPlanMode only: the file ctrl+g opens in the external editor. */
  planFilePath?: string;
}
export const PLAIN_DENY_MESSAGE: string;
/** Title/body/question from the tool's PermissionView (generic fallback
 *  otherwise); rows Yes / Yes-and… / No, or ExitPlanMode's three.
 *  `editedPlan` (ExitPlanMode, after ctrl+g) replaces the plan shown and
 *  is sent as `updatedInput` on approval. */
export function permissionDialog(request: PermissionRequest, context: ToolViewContext, editedPlan?: string): PermissionDialog;
/** Row-2 label per the derivation table. */
export function suggestionsLabel(suggestions: PermissionUpdate[], toolName: string, cwd: string | undefined): string;
```

### TUI — component and mounting

```ts
// src/tui/components/permission-prompt.ts (Container + Focusable)
export class PermissionPromptComponent extends Container implements Focusable {
  constructor(
    dialog: PermissionDialog,
    pendingCount: number,               // renders "(+N more)" when > 1
    onDecide: (decision: PermissionResult) => void,
  );
  handleInput(data: string): void;      // rows mode: digits/↑↓/Enter/Esc/Tab;
                                        // amend mode: pi-tui Input, Esc back to rows
}
```

`TuiParts.editor` becomes `inputSlot: Container` (dock entry unchanged,
`minSize: 3`): it holds the `Editor` normally and the
`PermissionPromptComponent` while an ask is pending — the dialog replaces
the input area exactly as in claude. `InteractiveMode` keeps
`permissionPrompt?: PermissionPromptComponent` and syncs it via
`syncPermissionPrompt(state)` — called on the subscribe snapshot (before
history replay starts, so an agent already blocked at attach shows its
dialog immediately) and after every folded event: head of
`pendingPermissions(state)` changed → replace the component; empty →
restore the editor and its focus. A task's ask renders its title as
`<title> — task: <description>` so the human knows the main agent is not
the one waiting. The status line shows `N subagents` while `tasks` is
non-empty (existence only; per-task stop and switching stay with
docs/follow-ups/subagent-activity.md). The `Editor`
instance is never recreated, so text typed before the ask appeared is
intact after it resolves. `onDecide` sends `permission-response`; a
rejection matching `isNotPendingError` is a lost race and is dropped
silently; any other error banners.

The dialog is modal: opening it closes any open selector
(model/effort/tree) and a selector fetch that completes while a dialog is
up does not mount. Of the global keys only `app.interrupt` (ctrl+c → the
agent is interrupted; the prompt is **not** in the `selectorOpen` guard),
`app.detach` (a blocked agent must remain detachable), and
`app.tools.expand` keep working; mode cycling and clear are suppressed
while the dialog has focus, and the external editor (`app.editor.external`)
edits the plan file on the ExitPlanMode dialog and is suppressed on every
other dialog.

Every `permissionResolved` renders a transcript banner (the existing
`addBanner`, as for `interrupted`): `permission allowed`, `permission
allowed (+N updates)`, `permission denied` (plain), `permission denied:
<message>` (amended), `permission cancelled` — so a TUI that did not
answer still sees what happened. Decided divergence: claude shows nothing
beyond the tool result.

### Parity harness — `scripts/tui-parity/`

```ts
// dialog-scenarios.ts
export interface DialogScenario {
  name: string;
  description: string;
  /** Sent as the initial prompt; may depend on the per-scenario workdir. */
  prompt: string | ((cwd: string) => string);
  setup?(cwd: string): void;
  /** Native-side flags (e.g. --permission-mode plan) and the clauctl spawn
   *  options that mean the same thing. */
  claudeArgs?: string[];
  spawnOptions?: Partial<Options>;
  /** Claude side only (no clauctl counterpart yet). */
  claudeOnly?: boolean;
}
export const dialogScenarios: DialogScenario[];
// bash-outside, bash-incwd, bash-plain (a command ask without a directory
// suggestion, e.g. `git push` style), edit, write, read-outside, webfetch,
// mcp (the probe's stdio MCP server), plan, askuser (claudeOnly)

// capture-dialogs.ts — entry: node scripts/tui-parity/capture-dialogs.ts [scenario…] [--recapture-claude]
/** Like captureInTmux, but settles on a marker: polls until any of
 *  `markers` is on screen and the normalized capture is stable, captures,
 *  then sends Escape (nothing is ever approved). */
export async function captureDialogInTmux(
  target: CaptureTarget, cols: number, markers: string[],
): Promise<{ plain: string; ansi: string }>;
```

Outputs `out/<name>.dialog.{claude,clauctl}.{txt,ansi}`; claude-side
captures are cached by scenario definition hash like transcript captures.
The clauctl side spawns an agent in the isolated config dir with the
scenario prompt, attaches in tmux, waits for the marker, captures, sends
Escape (plain deny), then archives the agent. Config seeding, credential
copying, and workdir trust reuse `capture.ts`'s helpers (exported where
they are currently private).

## Data flow

```
CLI can_use_tool ─► SDK canUseTool ─► broker.request
   ├─ emit permissionRequested ─► hub fold: pendingPermissions += request
   │                               ─► every subscriber: tail prints a line;
   │                                  TUI mounts the dialog in inputSlot
   ├─ user picks a row ─► permission-response ─► broker.respond
   │     ├─ removes the resolver, emits permissionResolved ─► fold removes
   │     │  ─► dialogs close (banner)
   │     └─ then settles the SDK promise (allow+updates | deny+message);
   │        the CLI applies updatedPermissions itself (session mode changes
   │        arrive later as system/status and fold into permissionMode)
   └─ interrupt / teardown ─► signal abort | cancelAll ─► same resolved path
                                                          with resolution cancelled
```

A late subscriber's snapshot already contains `pendingPermissions`, so the
TUI mounts the dialog from the snapshot with no replay.

## Cost

- **State/snapshot size**: each pending ask carries its full tool input
  (a Write's `content`, a plan's markdown) in `AgentState` and every
  subscribe snapshot. Bounded by what the model already produced per tool
  call; not on every stream line.
- **Harness**: `capture-dialogs.ts` makes one haiku API call per scenario
  per run (native side cached; clauctl side always live).

## Edge cases and non-goals

- **`wait --until idle` on a blocked agent**: a main-agent ask keeps it
  waiting (mid-turn); a task's ask does not (the main loop is idle, and
  the CLI would run a prompt). `--until quiescent` waits for the task
  too. There is no CLI way to answer an ask; `clauctl approve`/`deny`
  are a **follow-up spec**.
- **`status` is record-only** today and does not show pending asks;
  `tail`'s snapshot line does. Extending `status` is out of scope.
- **AskUserQuestion**, MCP elicitation (`onElicitation`), and
  `onUserDialog` are follow-up specs. Until then an AskUserQuestion ask
  renders through the generic `PermissionDialog` (the follow-up replaces
  only the `permissionDialog` output for it); what the CLI does with a bare
  allow is a **verification item** for the smoke.
- **Amend input is single-line** (pi-tui `Input`); claude's multi-line
  amend editor, `shift+tab` "approve with feedback", and `ctrl+g` Vim
  editing are non-goals.
- **`updatedInput`** (host-side input rewriting) is sent only by the
  ExitPlanMode dialog after a ctrl+g plan edit; no other dialog rewrites
  input.
- **Duplicate `toolUseId`** is treated as a bug (broker throws); the CLI
  asks once per tool use.
- **No subscriber, no deadline**: the SDK doc is explicit that asks have no
  park deadline; we add none.
- **Mixed daemon/client versions** are rejected at connect (protocol
  version 3); revive or re-spawn the agent after upgrading.
- **Permission events during history replay**: `permissionRequested`/
  `permissionResolved` buffered during `reloadHistory` are applied when
  the replay finishes, like every other live event; the dialog reflects
  the post-replay state.
- **Typing while blocked**: the editor is hidden, so a queued prompt cannot
  be typed until the ask is resolved (claude behaves the same).

# IMPLEMENTATION IDEAS

- Broker before UI: land `permission-broker.ts` + fold + `tail` formatting
  first and verify with `tests/sdk`-style probes (`docs/derisk/permission-prompt/probe.mjs`
  already drives every ask shape) that a blocked agent resolves through
  `permission-response` and that interrupt yields `cancelled`.
- Whether the SDK fires `options.signal` when the Query is closed is
  unverified; `cancelAll()` in `teardownQuery` makes the answer irrelevant
  (idempotent with the signal path).
- Reviewer rounds 1–2 (agent 8483e37e) drove the broker transition order,
  the guard switch (later refined to `isQuiescent`), the construction-order note,
  `title` as the question line, the modal policy (detach kept),
  shutdown-before-farewell cancellation, `isNotPendingError`, fatal
  version mismatch, and recursive decision validation.
- `permission-dialog.test.ts` fixtures are the probe payloads verbatim
  (`out/*.json` asks), asserting the labels in the captures.
- The dialog's `╌` rules and body indentation mirror claude's captures; the
  `─` rule is the same full-width rule the transcript already uses for
  boundaries, if one exists, else a `Text` of `─` × width.
- The `(+N more)` note: claude's exact wording for stacked asks was not
  captured (parallel asks are rare with haiku); pick `(+N more)` and add a
  scenario if a natural multi-ask prompt turns up.
- pi-coding-agent has no permission dialog counterpart (pi's tools do not
  ask); this is custom code per `src/tui/AGENTS.md` tier 4, built from
  pi-tui `Container`/`Text`/`Input` and the `SelectList` theme.

# WORK LOG

**Instructions**: Update this section during each work session. Add new tasks, mark completed ones with [x], document decisions and problems encountered.

- [x] Wire types (`protocol/`: PermissionRequest, PermissionResolution, TaskState, the two events, the request), `eventStream`/`eventNodes`/classification, fold (`next-agent-state.ts` routing; `fold-sdk-message.ts` task lifecycle), `isQuiescent`/`allPendingAsks` selectors, `EventHub.emit` subset, `PROTOCOL_VERSION = 3` (2026-09-29; stubs compiled first, then filled)
- [x] pictl: `--until quiescent` in until-engine; sync; `until.ts` passes `isQuiescent` (pictl c3bf665, synced in its own commit; `quiescent: isQuiescent` added)
- [x] `permission-broker.ts` (+ `validatePermissionResult`); unit tests pending (item below)
- [x] `protocol-server/daemon.ts` canUseTool + cancelAll before the shutdown drain and in teardownQuery; `request-handlers.ts` permission-response; `/compact` guard → `isIdle`, set-context guard → `isQuiescent`
- [x] `format/events.ts` lines; tests pending (fold + formatter, item below)
- [x] Client-side: `PROTOCOL_VERSION` mismatch rejects connect (`validateHello` returns the error; `versionWarning` getter and its stderr/banner consumers removed)
- [x] Tests: fold (task lifecycle, ask routing incl. unknown-agentId anomaly, resolve), `format/events` lines, handler `permission-response` (ok / not pending / malformed) — `agent-state.test.ts`, `events.test.ts`, `request-handlers.test.ts` (fixture exposes `broker`)
- [x] `permission-dialog.ts` + tests against probe payloads (`permission-dialog.test.ts` reads `docs/derisk/permission-prompt/out/*.json` asks through `permissionRequestOf`)
- [x] `permission-views.ts` (Bash, Edit, Write, Read, WebFetch, ExitPlanMode)
- [x] `PermissionPromptComponent` + `inputSlot` mounting + interactive-mode sync (spec's mounting section matched the current `interactive-mode.ts`; no re-plan needed). Footer count and fold/TUI tests: items below.
- [x] Live TUI smoke (`/tmp/perm-tui-smoke.mjs`, tmux, isolated config): dialog replaces the editor with claude's row labels (bash-outside capture), `3` → plain deny → `permission denied` banner → editor restored. Two attached TUIs, interrupt while blocked, set-context while blocked, AskUserQuestion: still open (item below).
- [x] `scripts/tui-parity/dialog-scenarios.ts` + `capture-dialogs.ts` (+ `mcp-greet-server.ts`); 11 scenarios captured against claude 2.1.280, triaged as Group F in `docs/derisk/tui-parity/diff-catalog.md`. Found and fixed: the prompt component did not wrap (pi-tui width crash on a long row-2 label).
- [x] Group F decisions, round 1 (2026-09-30): blank lines + body indent match; Bash description and WebFetch url move into the title; spinner hidden while blocked; `decisionReason` never shown; `bash-plain` `for:` prefix deferred (claude's heuristic, not on the wire)
- [x] Group F, round 2 (2026-09-30): plan body rendered as markdown, never collapsed; ctrl+g edits `planFilePath` in `$EDITOR` and approval sends the edited plan as `updatedInput`; `shift+tab` feedback hint not replicated; row-wrap / mcp body / `(+N more)` confirmed
- [x] `FitWidth` clamp around every regular-mode top-level component (+ `tree-selector.ts`'s three unwrapped lines truncated) — pi-tui's width crash cannot reach the screen
- [x] Footer `N subagents` (was spec'd as `N tasks`)
- [x] `archive` hangs on an agent blocked on an ask (polite stop waits for idle; a blocked agent never idles). Harness denies over the socket before archiving; the product change (archive/prompt/tail/wait on a blocked agent, a CLI responder, AskUserQuestion dialog) is `docs/follow-ups/permission-cli.md`
- [x] Row-2 labels verified: `mcp` matches the table (`… for <toolName> in <cwd>`; claude shows `probe — Greet commands`, a display name not on the wire); `bash-plain` differs — claude 2.1.280 says `Yes, and don’t ask again for: curl *` from its own prefix heuristic while the suggestion's `ruleContent` is the full command (catalog `dialog-bash-plain`, decision open)
- [x] Broker unit tests (`permission-broker.test.ts`): abort already signaled at entry; respond vs abort; cancelAll twice; duplicate id throws; `validatePermissionResult` accept/reject table; malformed decision rejected by the handler (in `request-handlers.test.ts`)
- [x] TUI tests (`interactive-mode.permission.test.ts`, a scripted ProtocolClient + `TuiMainScreen` on a scripted `Terminal`: keys typed through `terminal.start`'s callback, assertions on `ui.render()` text — the first slice of docs/follow-ups/old/interactive-mode-test-harness.md): seed ask shows before replay and the editor takes input again after `permissionResolved`; an ask during replay shows when the replay ends; `/model` + Enter settling under the dialog opens no selector. `InteractiveMode` is exported for it.
- [x] BLOCKING pre-implementation probe: background-subagent ask after top-level result → no queue-release transition needed; led to `tasks`/`isQuiescent` (log below)
- [x] `tests/sdk/permission-suggestions.test.ts`: the SDK's suggestion payload per tool (bash-outside: rule + directory + `setMode acceptEdits`; bash-plain: full-command rule; ask-rule/plan: `suggestions` undefined; read-outside: `//dir/**` at `session`; webfetch: `domain:`; mcp: `{toolName}` only + `mcpServer.name`). Deferred tools (WebFetch, MCP, ExitPlanMode) need `maxTurns` ≥ 4: a ToolSearch turn precedes the ask.
- [x] 2026-09-30 TDC round (9453ce3): `wrapIndented` wraps the first line at `width - firstPrefix.length` and the rest at `width - restPrefix.length`; `(shift+tab)` kept in the accept-edits label (config-compilation.md will substitute the bound key); Group F panes appended to `diff-catalog.html` (hand-maintained file; panes cropped to the dialog)
- [x] `ask-rule` (a `permissions.ask` rule pinned in the isolated settings) works: claude numbers `1. Yes` / `2. No` consecutively, as implemented
- [x] Review round (2026-09-30, fresh reviewer agent): fixed — `wrapIndented` collapsed a body line's own newlines (multi-line Bash commands) into one paragraph; Esc on the ExitPlanMode dialog was a no-op (no deny row to find) → `PermissionDialog.cancelDecision`; `(+N more)` was frozen at mount (`pendingCount` now updated on every sync); spec text stale on the plan hint, `updatedInput`, the external editor, the `PermissionDialog` sketch and the Read-rule `//` prefix. Decided with Anton: SDK 0.3.280's `defaultToNo`/`suppressAlwaysAllowRule` honored (ITD below); task-stop-under-ask pinned by an sdk test (ITD below) — no fold change, ctrl+c allowed whenever an ask pends; the TUI test drives a scripted `Terminal` and asserts on `ui.render()` text (no private access).
- [x] Live smoke (Anton, 2026-09-30): attach while blocked; asks routed to subagents; `N subagents`; set-context rejected while blocked; ctrl+g end-to-end (agent executes the edited plan); interrupt while blocked rejects the tool call. Not smoked: AskUserQuestion allow behavior (follow-up permission-cli.md covers its dialog)

## Implementation-Time Decisions

- **Plan editing (ctrl+g).** `app.editor.external` on the ExitPlanMode dialog opens `planFilePath` (claude's own plan file, edited in place as claude does) in `$VISUAL/$EDITOR` with the TUI suspended; on exit 0 the interactive mode keeps the file's text in `planEdits` (by toolUseId) and remounts the dialog through `permissionDialog(request, context, editedPlan)`, whose allow rows then carry `updatedInput = {...input, plan}`. Edits are dropped once no ask is pending. The dialog's hint says `ctrl+g` literally, like `(shift+tab)`.
- **Body lines are `string | { markdown }`.** ExitPlanMode's plan is a markdown block rendered by pi-tui `Markdown` at `width − 3` under the body indent; claude's collapse is not replicated (the plan is what is being approved).
- **`FitWidth`** wraps each regular-mode top-level child in `mountParts`: truncates (never wraps, so line counts are preserved) any line wider than the render width. Backstop only; components still wrap at the source.
- **Footer says `N subagents`** for `tasks.length` (the spec's `N tasks`): the human-facing word. `tasks` can also hold non-subagent task types (`taskType`), which the label glosses over.
- **SDK 0.3.280 `canUseTool` options `defaultToNo` and `suppressAlwaysAllowRule`** (added after the derisk) ride the wire and are honored as the SDK doc prescribes: no row 2; open on the last row, no digit shortcut. No captured ask sets either yet (the derisk payloads predate 0.3.280), so the sdk live test does not cover them.
- **Stopping a task under a pending ask** (`tests/sdk/task-stop-under-ask.test.ts`, FINDINGS.md): both `interrupt()` with the main loop idle and `TaskStop` abort the ask's `signal` _before_ the `task_updated (killed)` / `task_notification` events, so the broker's cancellation reaches the fold first and a removed task never leaves a resolver behind. Consequently ctrl+c is allowed whenever an ask pends, not only while `!isIdle`: on a background task's ask it kills the task (the CLI's semantics).
- **`protocol/permission.ts`** holds `PermissionRequest`,
  `PermissionResolution`, `NOT_PENDING_ERROR`, `isNotPendingError`: both
  `agent-event.ts` and `agent-state.ts` need the request type and neither
  imports the other; a third sibling keeps it that way.
- **Selector named `allPendingAsks`** (spec: `pendingPermissions(state)`):
  the spec's name collides with the `AgentState.pendingPermissions` field
  (main agent only). Its element type is exported as `PendingAsk`.
- **Task fold lives in `with-permission.ts`** (`withTask`/`withoutTask`)
  next to the ask routing that reads the task list; `fold-sdk-message.ts`
  calls them for the three task frames. `task_updated` on an unknown task
  is ignored (the CLI's own map would drop it too); `pending` status is
  folded as no change (a task is announced live by `task_started`).
- **`<tool summary>` in tail lines** is `<toolName> <formatToolArguments>`
  — the tail's own `[tool:…]` argument form (the spec's "Name(arg) form
  from messages.ts" does not exist there; the transcript's `Name(arg)`
  header is TUI/entry-view territory). `permissionRequested` prints no
  `(task …)` suffix: the event carries only `agentId` and the formatter
  keeps no task map; the snapshot line has it.
- **`permission-response` takes no gate**: it settles a promise the SDK
  holds and never touches the Query; teardown cancels asks itself.
- **Daemon construction order**: `buildOptions` and the first `query()`
  moved below the hub/tracked-log construction (the broker needs the hub);
  the agent.json write + spawn-options delete moved with them, so the
  record is still written right after the Query exists.
- **`invariantOptions().permissionPrompts` → `"host"`** (was `"none"`, the
  spec did not mention it). The tracer's first run showed the CLI denying
  the Bash ask terminally (`system/permission_denied`, no `canUseTool`
  call): `"none"` is the SDK's "no approval surface" mode. `"host"` is the
  SDK default; kept explicit so the invariant stays visible next to the
  other daemon-wide options.
- **Tracer bullet (2026-09-29, `/tmp/perm-tracer.mjs`, haiku, isolated
  config)**: prompt → `permissionRequested` (Bash, 3 CLI suggestions,
  `pendingPermissions=1`, activity `working`) → `permission-response`
  deny → a second response rejected with `permission not pending` →
  `permissionResolved` → `result` listing the denial. `data flow` steps 1–7
  confirmed live before any TUI work.
- **`PermissionView.body(args, context: ToolViewContext)`** (spec:
  `body(args, cwd)`): the Edit/Write bodies style lines, and the generic
  body calls `toolViewFor(name).header(input, context)`, so the views take
  the same `{cwd, style}` the tool views take. Tests pass `PLAIN_STYLE`;
  the TUI passes `ANSI_STYLE`.
- **`DASHED_RULE` sentinel**: a body line equal to `"╌"` is widened by the
  component to the full width; views stay width-agnostic strings.
- **Import surfaces**: `entry-view/index.ts` (and `tool-view/index.ts`)
  now export `stringArg`, `ToolInputMap`, `ToolName` for the permission
  views; `protocol-server/index.ts` exports `permissionRequestOf` for the
  dialog test's probe loading.
- **Amend input**: Enter sends `deny` with the typed message verbatim
  (empty included); Esc returns to the rows. The `Input` is created per
  amend, the rows' `selected` index persists.
- **`permissionViewFor(toolName, displayName)` always returns a view**
  (as `toolViewFor`): the generic view (`Name(headerArg)` + one
  `key: value` line per input key, title = `displayName ?? toolName`)
  lives in `permission-views.ts`; `permissionDialog` no longer branches
  on a missing view. `displayName` is a parameter because builtin asks
  carry `displayName === toolName` and the per-tool title must win.
- **Broker validation reuses `generated/util.ts` `isRecord`** and adds
  `Array.isArray` at the three wire-object checks (the shared helper
  admits arrays). `DESTINATIONS`/`BEHAVIORS` are transcriptions of the
  SDK's `PermissionUpdateDestination`/`PermissionBehavior` unions, which
  exist only as types.
- **Harness: no `spawnOptions`** (spec listed it): `clauctl spawn -- …`
  forwards claude CLI flags, so `claudeArgs` (`--permission-mode plan`,
  `--mcp-config …`) configures both sides. The `mcp` scenario uses a
  stdio server (`mcp-greet-server.ts`) since neither a native CLI nor a
  daemon can host the probe's in-process SDK server. `captureInTmux` grew
  a `CaptureSettle` option (`markers` gate stability; `keysAfter`) rather
  than a second poll loop. The clauctl side denies over the socket
  instead of pressing Escape (see the `archive` item above).
- **ExitPlanMode** is not among the generated tool inputs
  (`generated.ts`), so `permissionViews` types it locally as
  `{ plan?: string }`.

## 2026-09-29 — blocking probe (background-subagent ask)

`docs/derisk/permission-prompt/probe-bg-subagent.mjs` (+ `--push`),
FINDINGS.md "Background-subagent ask". Confirmed: the ask arrives after
the top-level `result` (activity idle). After resolution the CLI emits
the subagent's frames, `task_updated`/`task_notification`, then an
unprompted `init` → turn → `result` (the notification runs as a turn).
A prompt pushed while the ask is pending runs immediately (init 16 ms
after the push) — the pending ask does not block the main loop.
Consequence: `isIdle` keeps its activity-based meaning (the queue
model relies on it) and no `permissionResolved` release point exists.
Decision with Anton: a subagent is a task with state of its own, so
`AgentState.tasks: TaskState[]` (the CLI's task map) holds a task's
asks, `isQuiescent` gates set-context, and `wait --until quiescent`
is added. A per-task `SessionState` (the subagent's own file/stream
merge) is deferred to docs/follow-ups/subagent-activity.md, where the
identity facts and the tricky bits are recorded.
