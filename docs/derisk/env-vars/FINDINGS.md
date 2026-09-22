# Derisk: environment controls for model-facing instructions

## Scope and evidence

Question: which environment variables control harness-injected instructions,
what does the assistant see, and can the injections be disabled independently?

Method: static inspection of embedded JavaScript in
`node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`:
**Claude Code 2.1.280**, SDK platform package **0.3.280**. No CLI execution,
wire probes, or behavioral experiments. This is a scoped inventory of the
controls investigated, not an exhaustive environment-variable reference.
Byte offsets below identify evidence in this particular binary; they are not
stable across releases. Minified symbols are not stable identifiers either.

Quotes reproduce decoded source text, resolving tool-name interpolations to
Read, Bash, Edit, Write, TaskCreate, and TaskUpdate. Dynamic values are shown
as named placeholders. Where only a changed fragment is quoted, it is labeled
as such; these are not complete request captures. Hypotheses about motivation
are explicitly labeled and are not statements of Anthropic's intent.

Related: [attachment inventory](../attachment-types/FINDINGS.md), including
the TODO for mitmproxy wire validation. Presence in the session chain does
not imply presentation to the model. Conversely, system-prompt sections,
tool descriptions, and ephemeral request-time injections need not have a
persisted attachment containing the instruction.

Binary identity: 233,709,640 bytes; SHA-256
`1e08503dbdf3c2cb0d706d32f3408277388d1c76ef108673e8fe42c1b322925b`.
All evidence offsets refer to this binary. This document describes current
behavior only, not the history of these internal controls.

## Summary: controls and preferences

Recommendations below are judgments for this workflow, not experimentally
validated improvements. Other settings are preference-dependent; no blanket
opt-out is recommended. All variable names in the table have the prefix
`CLAUDE_CODE_`. Companion controls within a group are detailed below.

| Variable or group (after `CLAUDE_CODE_`)               | Controls                                                                                 | Assessment                                                                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `TOTAL_TOKENS_REMINDER`, `_BUDGET`, `_AFTER_USER_TURN` | Synthetic task budget or context-capacity countdown.                                     | The default synthetic budget seems dumb: unexplained “tokens left” without real headroom semantics. Recommend `TOTAL_TOKENS_REMINDER=off`. |
| `ENABLE_TOKEN_USAGE_ATTACHMENT`                        | Compaction-window-related usage and remaining space.                                     | Seems useful; recommend `true`. Not an exact auto-compaction countdown.                                                                    |
| `THRIFTY_SONIC`                                        | Bash-first file reads, searches, and edits.                                              | Recommend `false`: the reported 2KB output limit encourages tiny `sed` reads instead of adequate file context; see qualification below.    |
| `SILENT_TURN_REMINDER`, `_TEXT`, `_TURNS`              | Progress-update nudges, wording, and frequency.                                          | Preference-dependent.                                                                                                                      |
| `TODO_REMINDER_MODE`                                   | Todo/task tracking and cleanup nudges.                                                   | Preference-dependent; `off` disables reminders, not tools.                                                                                 |
| `TOASTY_THIMBLE`                                       | Parallel tool-call batching reminder or custom text.                                     | Preference-dependent.                                                                                                                      |
| `GENTLE_PARASOL`                                       | Remotely supplied secondary reminder or custom text.                                     | Depends on the assigned text and user preference.                                                                                          |
| `GORSE_PLOVER`                                         | Run straightforward Bash commands rather than deliberate first.                          | Preference-dependent; `false` is not a reliable opt-out.                                                                                   |
| `AMBER_ASTROLABE`                                      | Autonomy and task-continuation instructions.                                             | No recommendation; disabling is a personal experiment to consider, but `false` may not disable it.                                         |
| `PARCHMENT_FERN`                                       | Narrows advertised read-before-edit/write requirements to outside the working directory. | Preference-dependent; `false` is not a reliable opt-out.                                                                                   |
| `LARCH_CISTERN`                                        | Discourages excessive self-correction.                                                   | Preference-dependent; `false` is not a reliable opt-out.                                                                                   |
| `WILLOW_TERN`                                          | Self-contained final answers with restrictive writing rules.                             | Preference-dependent; `false` is not a reliable opt-out.                                                                                   |
| `SIMPLE_SYSTEM_PROMPT`                                 | Lean system prompt and tool descriptions.                                                | Preference-dependent; full variant diff not audited.                                                                                       |
| `DISABLE_ATTACHMENTS`                                  | Skips much of normal attachment collection, including useful context.                    | Depends on desired context discovery; not a universal no-injection switch.                                                                 |

Related selection and context controls (same `CLAUDE_CODE_` prefix):

| Variable              | Controls                                                              | Assessment                                                 |
| --------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------- |
| `COZY_TEAPOT`         | Strict versus relaxed Bash-first wording.                             | Preference-dependent; does not itself enable Bash-first.   |
| `MODEL_CAPABILITIES`  | Model-scoped capability overrides, including some prompt gates.       | Useful for targeted experiments; interactions matter.      |
| `PARSED_WILLOW`       | Whether queued human prompts are separated from system announcements. | Placement control, not a reminder opt-out.                 |
| `WISE_COMET`          | Stripping retained thinking blocks at compaction.                     | Context-retention preference, not injected guidance.       |
| `RUSTLING_PIXEL`      | Keeping thinking across model changes.                                | Context-retention preference; provider/server gates apply. |
| `POLISHED_DEWDROP`    | Drop/block behavior for invalid thinking blocks.                      | Request-validation policy, not injected guidance.          |
| `OCHRE_KITE`          | One same-model continuation after a classifier-stopped response.      | No recommendation; adds explicit refusal context.          |
| `MAX_EFFORT_REMINDER` | Human-facing max-effort cost/latency warning.                         | Not an assistant attachment despite the name.              |

The Thrifty Sonic recommendation reflects the user's reported experience:
Bash-based file reads hit a 2KB output limit, encouraging the model to read
tiny snippets, which this workflow considers harmful. The limit and causal
behavior were not verified in this static inspection; the Bash-first
instruction itself was verified.

These controls affect generation/selection, not a general transcript scrubber.
Existing attachments in a resumed conversation can still render. Several
assignments are cached for a session or process. Runtime behavior and resumed
sessions have not been wire-tested.

Do not generalize from one variable's parser to another:

- Total-token mode requires `off`, not `false`.
- Thrifty Sonic and the silent-turn toggle explicitly honor false.
- Toasty Thimble and Gentle Parasol are **text overrides** whose parser treats
  boolean-looking strings as suppression, not enablement.
- Several other experiment flags use `env || model/client/experiment`; false
  does **not** override an enabled experiment.

## Capability overrides

### `CLAUDE_CODE_MODEL_CAPABILITIES`

This is a capability-lookup override, not a text injection or a universal
experiment switch. It is a string, **not JSON**:

```sh
CLAUDE_CODE_MODEL_CAPABILITIES='-larch_cistern,-amber_astrolabe'
CLAUDE_CODE_MODEL_CAPABILITIES='claude-opus-5*=-larch_cistern;claude-sonnet-5=thrifty_sonic'
```

Semicolon-separated clauses contain comma-separated capability names. A bare
name enables the capability; a leading `-` disables it. An optional
`model-pattern=` restricts a clause to an exact model name or a trailing-`*`
prefix match. Without `model-pattern=`, the clause applies to all models.
Matching uses the model identifier supplied by the caller, with `[1m]` removed;
model-pattern matching is otherwise case-sensitive. Whitespace around tokens
and patterns is trimmed. The last matching assignment for a capability wins.
A leading `+` has no special meaning; use the bare name to enable.

The override precedes normal capability lookup. The prompt-capability resolver
then applies this precedence: explicit dedicated boolean, capability value,
applicable model bundle, per-model client data, otherwise false. Individual
callers can discard dedicated false or have independent enabling branches.
Consequently:

- `-larch_cistern` disables its section unless its dedicated flag is true.
- `-amber_astrolabe` does not disable the independent mitigation predicate.
- `-thrifty_sonic` blocks automatic selection, but dedicated true wins.
- `-lean_prompt` does not bypass later lean-prompt experiment fallbacks.

These are targeted static-source examples, not runtime-verified recipes.
Unknown names do nothing unless a consumer asks for that capability. Broader
capability changes can affect behavior beyond the prompt experiments here.

Evidence: lookup/parser at 191996920–191997780; prompt-capability resolver at
193877602; individual consumers cited in their sections.

## Attachment-based reminders

The ordinary reminder renderers create intermediate user-role messages,
marked internally `isMeta`, with their text wrapped as follows:

```xml
<system-reminder>
REMINDER_TEXT
</system-reminder>
```

The tag itself does not change the API role. **Final placement is
model-dependent:** the request converter folds eligible attachment text
(including token, task, silent-turn, and auto-mode reminders) into
mid-conversation `api_system` messages when that capability is active.
Otherwise it retains/merges user messages and can append reminder text
inside a tool result. The system path normally removes the wrapper; a
model-specific branch preserves it. Neither the persisted attachment nor
its intermediate renderer alone establishes the exact wire representation.

Evidence: wrapper at 201313645; user-message constructor at 201264894;
system-message constructor at 197643156; model gate at 193055286;
request conversion at 201285723–201296900; tool-result merging at
201301615–201303300. These paths were read, not wire-tested.

### Total-token reminder

Controls:

- `CLAUDE_CODE_TOTAL_TOKENS_REMINDER`
- `CLAUDE_CODE_TOTAL_TOKENS_REMINDER_BUDGET`
- `CLAUDE_CODE_TOTAL_TOKENS_REMINDER_AFTER_USER_TURN`

**Insertion:** `total_tokens_reminder` attachment through the conversion
paths above. Generated between tool rounds and, by default, on regular
user prompts. The producer also supports per-agent accounting.

The same body is also appended directly to the main/subagent system prompt,
without an enclosing `<system-reminder>` tag. That initial text uses the full
configured budget for padded mode or model capacity for countdown mode,
not the attachment's usage-subtracted value. `off` suppresses both sources;
`CLAUDE_CODE_DISABLE_ATTACHMENTS` and `CLAUDE_CODE_SIMPLE` also suppress the
initial system-prompt addition.

Exact body template:

```xml
<total_tokens>VALUE tokens left</total_tokens>
```

No explanation of the budget's meaning accompanies this text.

| Mode               | `VALUE`                                                                           |
| ------------------ | --------------------------------------------------------------------------------- |
| `off`              | No attachment generated.                                                          |
| `infinite`         | Literal `Infinite`.                                                               |
| `fixed`            | Literal `5000000`.                                                                |
| `countdown`        | Model context capacity minus latest recorded context usage, clamped at zero.      |
| `padded-countdown` | Artificial budget minus accumulated usage since the task anchor, clamped at zero. |

Mode selection precedence: valid environment value, valid
`totalTokensReminder` setting, client-data assignment, GrowthBook assignment.
The fallback is `padded-countdown`. Its feature key is `tengu_lapis_anchor`.
Invalid mode strings do not disable it; they fall through.

For `padded-countdown`:

- Budget fallback is **15,000,000**. A positive
  `CLAUDE_CODE_TOTAL_TOKENS_REMINDER_BUDGET` takes precedence over
  `totalTokensReminderBudget`, client data, and GrowthBook.
- `CLAUDE_CODE_TOTAL_TOKENS_REMINDER_AFTER_USER_TURN` is an explicit boolean
  override, ahead of the corresponding setting and remote assignments;
  fallback is true. When enabled, regular user prompts reanchor the task
  budget at current usage and emit a reminder.
- The accumulator is keyed by agent (or `main`). Compaction rolls the old
  context usage into it. Within an anchor period, accumulated usage cannot
  decrease: the implementation retains a high-water mark.
- Accounting uses the latest assistant usage record: input, cache creation,
  cache read, and output tokens. When valid server-side iterations are
  available, the usage normalizer takes the last non-advisor/non-compaction
  message iteration rather than the aggregate. It is not the sum of billed
  tokens across requests and is not the account's five-hour allowance.
- This producer does not enforce stopping when the displayed number reaches
  zero. `fixed` and `infinite` are literal presentation modes.

**Not a compaction-headroom meter:** setting the artificial budget equal to
an auto-compaction threshold does not fix its semantics. A new user prompt
replenishes the task budget even if the current context is nearly full;
compaction carries accumulated usage forward instead of replenishing it.
`countdown` is closer to occupancy headroom, but uses model context capacity,
not the auto-compaction threshold.

**Hypothesis:** the fixed, infinite, and padded modes manipulate perceived
budget scarcity, potentially discouraging premature wrap-up or conserving
work according to an experimental task budget. The source proves the
mechanism, not the intended behavioral effect or its effectiveness.

Evidence: configuration/accumulator at 199012040–199014780; usage
normalization/lookup at 198578070–198579900; producer at 200742898;
renderer at 201337548; initial system-prompt addition at 199054981 and
199057248; compaction rollover calls at 204987681 and 205029477.

### Context token usage: a separate mechanism

`CLAUDE_CODE_ENABLE_TOKEN_USAGE_ATTACHMENT=true`

**Insertion:** `token_usage` attachment in the main-agent attachment pipeline.
Exact body template:

```text
Token usage: USED/TOTAL; REMAINING remaining
```

`USED` is the latest reported context usage. `TOTAL` is the effective
compaction-window calculation minus an output reserve. `REMAINING` is
`TOTAL - USED`; this producer does not clamp it at zero.

This is a different producer from `total_tokens_reminder`, though both use
the same latest-response usage helper. It is closer to context headroom,
but is not an exact promise of when compaction happens: compaction has
additional thresholds and precomputation logic, and the usage record does
not account for every subsequently appended block.

Enablement is opt-in through this variable; unset or false does not generate
it. It does not replace or disable the total-token reminder.

Evidence: producer at 200742741; effective-window helper at 198622836;
renderer at 201337420. The effective window reserves up to 20,000 output
tokens; the normal auto-compaction trigger subtracts another 13,000
(198619254), reinforcing that this is not the trigger countdown.

### Silent-turn reminder

Controls:

- `CLAUDE_CODE_SILENT_TURN_REMINDER=false`: explicit opt-out, overriding
  automatic model/client enablement.
- `CLAUDE_CODE_SILENT_TURN_REMINDER_TEXT`: exact text override.
- `CLAUDE_CODE_SILENT_TURN_REMINDER_TURNS`: interval override; fallback five.

**Insertion:** `silent_turn_reminder` attachment during eligible main-agent
tool continuations, rather than regular user prompts. The generator tracks
silent stretches and caps reminders within a stretch at three.

Exact fallback body:

```text
The user hasn't heard from you in a while. As you continue, keep them updated when there's something to tell — a finding, a change of plan.
```

The default text can also come from `tengu_hushed_lark_text`; the interval
from `tengu_hushed_lark`. The text environment override is used verbatim,
including an empty string. Use the boolean toggle rather than empty text
when the goal is to suppress attachment generation.

Purpose is apparent from the text: encourage progress updates during long
stretches of tool use. Whether those messages reach a particular UI is a
separate question.

Enablement goes through the model-capability resolver with the explicit
environment boolean passed through unchanged. False wins; otherwise
`silent_turn_reminder` capability/bundle/client-data selection applies.
The fallback interval is five turns, with a three-reminder cap.

Evidence: configuration at 200685814–200686600; capability resolver at
193877602; main-agent gate at 200697419–200697589; producer at 200703745.

### Todo and task reminders

`CLAUDE_CODE_TODO_REMINDER_MODE`

**Insertion:** controls generation of both `todo_reminder` and
`task_reminder`. The value `off` disables reminders without removing the
corresponding tools. The experiment fallback is `baseline`
(`tengu_soft_slate_nudge`). Producers require eligible tools and history; the baseline checks ten assistant turns since relevant
task management and ten since the previous reminder. Renderers also have
tool-mode availability gates.

Exact todo body, before any list is appended (including the source's typo):

```text
The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using the TodoWrite tool to track progress. Also consider cleaning up the todo list if has become stale and no longer matches what you are working on. Only use it if it's relevant to the current work. This is just a gentle reminder - ignore if not applicable.
```

For a nonempty list, it appends this template, with newline-separated items:

```text
Here are the existing contents of your todo list:

[1. [STATUS] CONTENT
2. [STATUS] CONTENT]
```

Exact task body before any list is appended:

```text
The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate to add new tasks and TaskUpdate to update task status (set to in_progress when starting, completed when done). Also consider cleaning up the task list if it has become stale. Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable.
```

For a nonempty list, it appends:

```text
Here are the existing tasks:

#ID. [STATUS] SUBJECT
```

The base bodies end with a newline; nonempty-list suffixes begin with two
more newlines. Each task occupies its own line.

Purpose is apparent: encourage progress tracking and removal of stale tasks.
Evidence: mode selection at 200692947; producers and brief-mode gate at
200737140–200738680; renderers at 201349504 and 201350132.

## Request-time reminders

### Batching: `CLAUDE_CODE_TOASTY_THIMBLE`

**Insertion:** request-time batching reminder after eligible tool results.
The transient path creates `batching_reminder`, then the request converter
folds it into model-capable system-message content. A retained path instead
writes `batching_reminder_sent` with `clearAt: "next_user_message"` and
converts that record into system content with API `clear_at`. A third
selection result suppresses delivery. Model, provider, and tool-result/error
gates apply; this is not unconditional on every request.

Exact built-in text for the model family selected by the source's model gate:

```text
First privately list what you need next; then request every item that doesn't depend on another's result in this one response.
```

This is a string override:

- `false` suppresses the reminder; boolean-looking true also suppresses it.
- Empty/whitespace-only text suppresses it.
- Other text is trimmed and used as the reminder, ahead of client data.
- Without an environment override, client data under `tengu_toasty_thimble`
  can supply model-pattern-specific text; otherwise a model-specific
  built-in fallback may apply.

Selections are latched per conversation/model. A plain
`batching_reminder_sent` record remains bookkeeping and its ordinary
renderer returns no messages. **Retained records with `clearAt` are
different:** a dedicated converter consumes their text, even though that
ordinary renderer is empty. Do not infer absence from the API from the
empty renderer alone. See Sleepy Snowflake below for the delivery gate.

Purpose is apparent: encourage independent tool calls in parallel to reduce
sequential inference rounds. It explicitly requests private planning first.

Evidence: text/configuration/selection at 204901974–204904100; transient
insertion at 204904294; retained-record calculation at 204904999;
delivery decision at 199556191; recording/branching at 205000183;
retained-record conversion at 201293780–201294130; wire `clear_at` at
199565058; ordinary empty renderer at 201343254.

### Secondary reminder: `CLAUDE_CODE_GENTLE_PARASOL`

**Insertion:** `secondary_reminder` through the same transient/retained
request-time mechanism, with `secondary_reminder_sent` records. It has its
own selection and latch. Some batching-specific suppression guards do not
apply to this secondary reminder. As with batching, a retained record with
`clearAt` can contribute model-visible system content.

There is **no built-in default text** in this configuration. Exact text comes
from the environment variable or a model-pattern map under client-data key
`tengu_gentle_parasol`. The environment parser is the same as Toasty Thimble:
`false` suppresses it; another nonempty, non-boolean-looking string replaces
it. We did not inspect a live assignment, so no remotely supplied text is
claimed here.

**Hypothesis:** a second generic channel for testing behavioral reminders
independently of the batching experiment. Its name does not identify a
particular behavior.

Evidence: same request-time configuration and insertion sites as above.

### Retained delivery: Sleepy Snowflake

The remote `tengu_sleepy_snowflake` assignment chooses `off`, `threads`, or
`all`. A per-model client-data map takes precedence over GrowthBook, whose
fallback is `all`. This is a delivery scope, not a text override. `threads`
requires the Message Threads gate; `all` does not. First-party provider/base-URL,
request-mode, endpoint-support, and session-retirement checks still apply.
The selection is cached by conversation/model. Rejection by the server can
retire the retained path for the session. Thus `all` is not evidence that every
SDK request receives retained reminders.

**The apparent environment overrides are not functional in this binary.**
Source references `CLAUDE_CODE_SLEEPY_SNOWFLAKE` and
`CLAUDE_CODE_TETHER_LIVE`, but both are read from an accessor constructed
from an empty schema with a null prototype. Its factory defines environment
getters only for schema entries, not a generic `process.env` proxy. These
references therefore read undefined; merely setting those variables does
not override the remote gates. A name found in embedded source is not proof
of a usable environment control.

Use Toasty Thimble/Gentle Parasol text suppression for targeted opt-outs,
subject to the caveat about existing retained records. Retained delivery
changes placement/lifetime, not the quoted reminder text.

Evidence: accessor factory/empty schema at 190819257–190819689;
selection/gates at 199545550–199547300; delivery decision at 199556191;
server-rejection fallback at 199622000–199624500.

## Bash-first instructions

### `CLAUDE_CODE_THRIFTY_SONIC`

`false` is an explicit override ahead of automatic model/cohort selection;
`true` forces enablement. The remote experiment is `tengu_thrifty_sonic`.

**Verified insertion:** the `auto_mode` attachment, routed through the
user/system conversion described above. It can be generated in **auto or
bypass-permissions mode**, requires appropriate tools, and is not injected
afresh every turn once the mode attachment is present. False disables this Bash-first branch; it does
not necessarily suppress other auto-mode guidance.

Exact **strict** Bash-first paragraph:

```text
Do your work through the Bash tool wherever it can accomplish the job: read files with cat, head, or sed -n, search with grep and find, and make file changes with sed, heredocs, or short scripts, rather than using the dedicated Read, Edit, or Write tools. Fall back to a dedicated tool only when Bash genuinely cannot do the job.
```

In bypass mode the complete body for the strict branch is:

```text
While bypass permissions mode is active:

Do your work through the Bash tool wherever it can accomplish the job: read files with cat, head, or sed -n, search with grep and find, and make file changes with sed, heredocs, or short scripts, rather than using the dedicated Read, Edit, or Write tools. Fall back to a dedicated tool only when Bash genuinely cannot do the job.
```

The steer-only auto-mode branch uses `While auto mode is active:` instead.
The other auto-mode branch appends the paragraph to broader auto-mode
instructions. Those broader instructions are not uniquely enabled by this
variable and are not reproduced here.

The instruction does not explicitly require small reads, but it demotes
Read/Edit/Write to fallbacks. A tendency to read insufficient snippets is a
reported behavioral concern, not something established by static inspection.

**Hypothesis:** experiment in tool efficiency/cost or model performance with
a Bash-first workflow. The codename alone does not establish the metric or
rationale.

Automatic assignment honors `thrifty_sonic: false` through model
capabilities before cohort selection, and recognizes the `opus_5_5_prompt_bundle`
capability. Explicit `CLAUDE_CODE_THRIFTY_SONIC=false` wins over all
automatic assignments. The `bashFirstSteer` attachment field selects the
wording variant; see Cozy Teapot below.

Evidence: precedence at 193879728–193880076; attachment producer at
200706206; strict/relaxed text at 201357060–201358300.

### `CLAUDE_CODE_COZY_TEAPOT`

Selects `strict` or `relaxed` wording **when Bash-first is enabled**. It does
not itself enable Thrifty Sonic. A valid environment value wins; otherwise
selection uses a valid client-data value under `tengu_cozy_teapot`, then the
`opus_5_5_prompt_bundle` capability (selecting relaxed), then a valid remote
experiment value, then strict. Invalid values do not disable Bash-first.

The strict paragraph is quoted above. Exact relaxed paragraph:

```text
You can do much of your work through the Bash tool when it is the simpler route: read files with cat, head, or sed -n, search with grep and find, and make small, mechanical file changes with sed, heredocs, or short scripts instead of the dedicated Read, Edit, or Write tools. The choice is yours: prefer Edit or Write when a shell edit would be fragile, such as exact or multi-line replacements, or sed/awk flags that differ between GNU and BSD/macOS.
```

Insertion uses the same `auto_mode` attachment and surrounding mode text as
strict. An existing attachment's `bashFirstSteer` is reused; a missing field
selects strict. Changing the environment is not a rewrite of persisted mode
attachments.

**Hypothesis:** preserve Bash-first efficiency while avoiding fragile shell
edits. The relaxed wording explicitly permits choosing Edit/Write; it does
not address the reported output-limit concern.

Evidence: selector at 193880076–193880420; producer at 200706206;
text/variant renderer at 201357060–201358150.

### `CLAUDE_CODE_GORSE_PLOVER`

**Insertion:** an additional line in the lean Bash tool description, not an
attachment. Exact added line:

```text
- Commands are cheap to run and their errors are informative: run the straightforward command rather than perfecting it mentally first, and adjust from what it prints.
```

The helper is named `bashActFirstEnabled` in the session state. Its result
is cached. Enablement is OR-style: the environment flag or client-data/
GrowthBook assignment under `tengu_gorse_plover`. Consequently, setting
`false` is **not** a reliable opt-out. Selecting a non-lean description may
avoid this particular insertion, but that is broader than a targeted toggle.

**Hypothesis:** reduce deliberation latency by treating command execution and
errors as cheap feedback. The text asserts commands are cheap without
qualifying their side effects; this is prompt guidance, not a permissions
change or exemption from other instructions.

Evidence: helper at 193880416–193880563; insertion at 198552181.

## Other prompt experiments traced

### `CLAUDE_CODE_AMBER_ASTROLABE`

**Insertion:** `autonomy_append` system-prompt section. The section has an
additional `tengu_amber_sextant` gate, defaulting on. Either the separate
`fable_5_mitigations` model predicate or the Astrolabe helper can enable it.
The helper passes `CLAUDE_CODE_AMBER_ASTROLABE || undefined` to the
capability resolver: true forces it on, while false is discarded. Selection
then uses the `amber_astrolabe` model capability or per-model client data.

`CLAUDE_CODE_MODEL_CAPABILITIES=-amber_astrolabe` disables that capability
branch, but **not** the independent mitigation predicate. It is therefore
not a universal opt-out from the whole section.

Exact section:

```text
You are operating autonomously. The user is not watching in real time and cannot answer questions mid-task, so asking 'Want me to…?' or 'Shall I…?' will block the work. For reversible actions that follow from the original request, proceed without asking. Stop only for destructive actions or genuine scope changes the user must decide. Offering follow-ups after the task is done is fine; asking permission before doing the work is not.

Exception: when the user is describing a problem, asking a question, or thinking out loud rather than requesting a change, the deliverable is your assessment. Report your findings and stop. Don't apply a fix until they ask for one.

Before ending your turn, check your last paragraph. If it is a plan, an analysis, a question, a list of next steps, or a promise about work you have not done ('I'll…', 'let me know when…'), do that work now with tool calls. That includes retrying after errors and gathering missing information yourself. Do not stop because the context or session is long. End your turn only when the task is complete or you are blocked on input only the user can provide.

Before running a command that changes system state (such as restarts, deletes, or config edits), check that the evidence actually supports that specific action. A signal that pattern-matches to a known failure may have a different cause.
```

**Hypothesis:** prevent premature handoffs or permission-seeking loops in
unattended execution. The section asserts the user is not watching; this
inspection did not establish that every environment receiving the section
actually has that property. Its assessment-only exception also needs to be
read alongside its broad instruction not to end with analysis.

Evidence: helper at 193880563; capability resolver at 193877602;
independent mitigation predicate at 193853722; section text/gate at
199031665–199033300; prompt-section selection near 199054490.

### `CLAUDE_CODE_PARCHMENT_FERN`

**Insertion:** changes read-before-write/edit wording in Write and Edit tool
descriptions. Model eligibility applies, and `CLAUDE_CODE_SIMPLE` suppresses
this particular wording branch. OR-style experiment enablement means false
is not a reliable opt-out. Assignment is cached by model.

Exact replacement fragment in the full Write description:

```text
- If this is an existing file outside the working directory, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not.
```

It replaces:

```text
- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.
```

Exact replacement fragment in the full Edit description:

```text
- If the file is outside the working directory, you must use your `Read` tool to read it before editing. This tool will error if you edit such a file without reading it first.
```

It replaces:

```text
- You must use your `Read` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
```

Lean descriptions make the same distinction. Write uses:

```text
Overwriting an existing file outside the working directory that you haven't Read will fail.
```

instead of:

```text
Overwriting an existing file you haven't Read will fail.
```

Lean Edit uses:

```text
- If the file is outside the working directory, you must Read it in this conversation before editing, or the call will fail.
```

instead of:

```text
- You must Read the file in this conversation before editing, or the call will fail.
```

**Hypothesis:** remove redundant reads for files within the active workspace.
Only the prompt wording was traced here; these quotes are not independent
verification of runtime enforcement.

Evidence: selection at 193881464; Write at 195705621–195706970;
Edit at 201058254–201060500.

### `CLAUDE_CODE_LARCH_CISTERN`

**Insertion:** `overcorrection` system-prompt section. The helper passes
`CLAUDE_CODE_LARCH_CISTERN || undefined` to the capability resolver. True
forces it on; false is discarded. The `larch_cistern` capability, applicable
model bundle, or per-model client data then determines enablement.
`CLAUDE_CODE_MODEL_CAPABILITIES=-larch_cistern` can explicitly disable this
capability branch when the dedicated flag is not forcing it on.

Exact section:

```text
# Corrections
Avoid unnecessary or excessive self-correction. Only correct an earlier statement in your user-facing text when the error would change the user's code, conclusions, or decisions. State corrections plainly and concisely, and continue the task; combine multiple corrections rather than enumerating them all. For slips that change nothing for the user, simply make the correction and move on - no need to note it explicitly. Don't add apologies or preambles, don't be overly self-critical, and don't ruminate or give a detailed account of the mistake or tally past errors. Sometimes, other agents will report incorrect or misleading results - don't always take them at face value immediately. If other agents correct your statements and they are right, then simply update your approach without narrating too much about the correction to the user. This instruction does not apply to thinking blocks.

A follow-up question about your earlier work is not, by itself, a signal that you got something wrong — answer what was asked. A statement that was accurate needs no correction: don't re-audit how you phrased it, how you verified it, or limits you already stated. When the user does point to a real error, correct it plainly as above.
```

Purpose is apparent: suppress unnecessary self-correction and repeated
re-auditing without suppressing consequential corrections.

Evidence: helper at 193880729; capability resolver at 193877602;
text at 199051771; section selection at 199054037.

### `CLAUDE_CODE_WILLOW_TERN`

**Insertion:** `willow_tern` system-prompt section. Environment true forces
enablement; environment false does not force disablement. Client data can
explicitly select a boolean; otherwise model/model-bundle gates and an
experiment assignment determine enablement.

Exact section:

```text
# Writing for the user
The user may not see your tool calls, tool results, or the text you write between them. Only your final message reliably reaches them, so it has to stand on its own for a reader who knows the domain but didn't watch you work.

Rules for that message:
- Lead with the answer or outcome. If something could not be verified, say so first. Keep it short by leaving things out, not by packing them in.
- One idea per sentence, about 20 words, with a verb. Short does not mean clipped: a sentence beats a label with a colon. Start a new sentence instead of joining clauses with a semicolon.
- No em-dashes, no parentheticals, no arrows.
- State facts and conclusions. Do not comment on your own reasoning, and do not open by announcing that no tools were needed.
- Do not refer to anything by a name you made up during the session. Expand uncommon acronyms the first time you use them. Say who wrote a message and what it said, not by number or label.
- Keep code out of prose. Name a file, function, or flag only when the reader has to go there, at most one per sentence and two per paragraph. Describe the rest in words. Commands, snippets, and error text go in a fenced code block.
- Keep numbers out of prose. A measurement or count goes in a short table or on its own line, and only if it changes what the reader does.
- Use a bulleted or numbered list for parallel items: findings, steps, options, files to look at. One or two sentences per bullet, never a paragraph. Bold the first few words of a bullet or paragraph, never a whole sentence. A single point or a line of argument stays in prose.
- No headers in a message under about 500 words. Above that, at most three. If the user asks for no formatting, use none.
- Stop when the content stops. No closing offer, no restating what you did.
```

Purpose is apparent: make final answers self-contained in clients that do
not reliably display intermediate activity, with unusually specific style
constraints. Whether those constraints improve technical communication is
not established by this inspection.

Evidence: selection at 193880816–193881291;
text at 199029412; section selection near 199054467.

### `CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT`

**Insertion:** selects a lean system-prompt/tool-description variant rather
than adding one fixed text block. Explicit truthy/falsey values override
automatic selection; model and experiment gates otherwise choose it.
Selection is cached by model. This is distinct from `CLAUDE_CODE_SIMPLE`.

There is no single exact added instruction to quote: many description and
prompt branches consult the lean selection. Exact affected examples include
the lean Write/Edit fragments above and the Gorse Plover Bash line. The full
variant diff has **not** been audited. Do not treat false as a universal
opt-out from all prompt experiments.

**Hypothesis:** reduce prompt overhead and tailor instructions to different
model generations. It changes more than the attachment reminders.

The automatic selection recognizes explicit `lean_prompt` capability
values, including false, before its model-family heuristics. The
dedicated environment setting remains the first override. A negative
capability does not bypass later GrowthBook/client-data fallback branches.

Evidence: selector at 193881564–193882233; consumers cited above.

## Other context controls

### `CLAUDE_CODE_PARSED_WILLOW`

Explicit boolean override of `tengu_parsed_willow`, whose fallback is true.
For eligible queued human prompts on the system-message conversion path,
true separates non-meta human content from attachment announcements and
removes its reminder wrapper. Meta content can still enter the announcement
path. Human-turn provenance, prompt mode, and other eligibility checks apply.

This adds no fixed instruction and is not a universal system-reminder opt-out.
False selects the ordinary conversion path; it does not discard the prompt.

Evidence: selector at 201277097; queued-human conversion at
201294780–201295600.

### `CLAUDE_CODE_WISE_COMET`

Controls stripping thinking retained across compaction. An explicit boolean
wins; otherwise only adaptive thinking consults `tengu_wise_comet`, with a
false fallback. If a compaction's kept tail contains thinking blocks and the
selection is true, it emits a `thinking_stripped` marker with scope `all`.
Request normalization consumes the marker to strip preceding thinking.

This changes retained context, not whether the model may reason on its next
turn. It injects no fixed instruction. False suppresses this particular
compaction marker, not every other reason thinking can be removed.

Evidence: selector at 198618012; compaction producer at
199467150–199467800; marker consumption at 201382015–201382541.

### `CLAUDE_CODE_RUSTLING_PIXEL`

Controls retention of foreign-model thinking during request normalization:

| Value     | Selection                                                                |
| --------- | ------------------------------------------------------------------------ |
| `all`     | Retain eligible foreign thinking with a recorded source model.           |
| `upgrade` | Retain it only when the model-compatibility upgrade predicate allows it. |
| `none`    | Strip foreign-model thinking.                                            |

First-party/endpoint eligibility applies before the override. Precedence is
environment, client-data string under `tengu_rustling_pixel`, then GrowthBook
with fallback `all`. Invalid strings select `upgrade`; invalid environment
values also log a warning. Assignment is cached in session state and can be
retired on failure. Other thinking-validity/stripping rules still apply.
The complete model-upgrade compatibility map was not audited here.

No fixed instruction is added. This is a context-retention policy, not a
request to expose thinking or a guarantee the server accepts it.

Evidence: selector/cache at 199537575–199538800; request-normalization input
at 199615489; foreign-model filtering at 201381341–201381729.

### `CLAUDE_CODE_POLISHED_DEWDROP`

Controls a thinking-block binding-validation request policy on the eligible
first-party path. A valid environment enum overrides `tengu_polished_dewdrop`:

| Value   | Request policy                           |
| ------- | ---------------------------------------- |
| `drop`  | `prefix_mismatch_behavior: "drop_block"` |
| `block` | `prefix_mismatch_behavior: "error"`      |
| `off`   | No policy from this selector.            |

The policy is inserted under `thinking.block_binding` for eligible enabled
or adaptive thinking requests. Provider, request, and beta gates apply.
`off` does not disable all validation. No model-facing instruction is added;
server enforcement was not tested.

Evidence: selector at 199535720–199536050; request gating at
199619250–199619900; request field construction at 199629800–199630200.

### `CLAUDE_CODE_OCHRE_KITE`

Enables one same-model continuation after an eligible response is stopped
by a safety classifier. Enablement is environment true **or**
`tengu_ochre_kite` (false fallback); dedicated false is not a reliable opt-out.
Auxiliary queries and an already-attempted retry are excluded. Tool deferral,
continuation-prevention, and end-turn signals can prevent the retry.

**Insertion:** a meta user message marked as a turn companion, not a
`<system-reminder>`-wrapped attachment. Exact text:

```text
Your response above was stopped by a safety classifier — this is not a tool or API error. The rest of it was withheld, and tool calls in it that had not finished did not run. Do not produce that content again, even reworded.
```

If a tool call was already running, append a space and:

```text
Exception: a tool call whose result reads "Interrupted" was already running when the response was stopped; it may have partially or fully completed.
```

Unanswered tool calls receive synthetic error results. Exact bodies, depending
on whether the tool had started:

```text
Not run: the response that made this tool call was stopped by a safety classifier.
```

```text
Interrupted: the response that made this tool call was stopped by a safety classifier while the call was running; it may have partially or fully completed.
```

Purpose is apparent: continue with explicit refusal and partial-execution
context, rather than treating the stop as a tool/API error. It does not
instruct the model to reproduce withheld content. Actual retry behavior and
final wire messages have not been tested.

Evidence: instruction constants at 191939403–191939792; gate/message builder
at 204949350–204951060; continuation branch at 205025900–205027050.

### `CLAUDE_CODE_MAX_EFFORT_REMINDER`: human-facing only

Explicit boolean override of `tengu_proud_clover`, with a false fallback.
It enables max-effort warnings in UI surfaces, not an assistant attachment.
Exact shared warning body:

```text
May use excessive tokens resulting in long response times or overthinking. Use sparingly for the hardest tasks.
```

UI wrappers vary by surface. The name is not evidence that this text is
injected into model context.

Evidence: warning body at 191014591; selector at 193854118; UI consumers at
212945501, 217547219, 217632758, and 226985240.

## Broad attachment suppression

`CLAUDE_CODE_DISABLE_ATTACHMENTS=true`

**Insertion effect:** takes an early-return branch in the normal attachment
collector. It adds no fixed instruction text. `CLAUDE_CODE_SIMPLE` and the
internal bare-fork option also enter this branch, but have broader semantics
that are not exhaustively audited here.

This skips most normal collection, including mentioned-file expansion,
nested memory, skill listings, edited-file notices, plan reminders,
hook-response collection in this pipeline, and token/task reminders.
It retains queued prompts, agent-listing changes, sandbox instructions,
and environment/model/session-setting updates, subject to their own gates.

It is **not** a universal no-injection flag:

- The request-time batching/secondary mechanism is separate.
- System-prompt sections and tool descriptions remain separate.
- Existing persisted attachments are not necessarily filtered from rendering.
- Other code paths can create attachments outside the collector.

**Hypothesis:** useful for stripped-down execution or evaluation, not a
surgical preference for fewer behavioral nudges. Targeted opt-outs avoid
losing useful context discovery along with reminders.

Environment/model/session settings are collected by one retained helper.
This flag also suppresses the initial total-token system-prompt text and
disables the kept-deferred-tool feature; its effects extend beyond reminders.

Evidence: collector branch at 200694127; retained helper at 200709966;
initial total-token gate at 199054981; kept-tools gate at 196325793.

## Open questions and validation

- Wire-test the targeted opt-outs on fresh and resumed sessions. Determine
  which persisted reminders remain visible after their producers are off.
- Capture actual client/model assignments separately from fallback values;
  source defaults do not establish a particular user's active experiments.
- Audit `CLAUDE_CODE_FORWARD_USER_INTENT` end to end: its source references
  provenance-labeled parent context forwarded to subagents, but its complete
  selection/insertion behavior is outside this report's verified inventory.
  Artifact-related controls are also outside this scoped audit.
- Audit the complete lean/non-lean prompt diff before recommending
  `CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT` as a workaround.
- Verify the practical relation between the `token_usage` total and each
  compaction trigger; do not present it as an exact auto-compaction countdown.
- No universal experiment opt-out or supported contract for these internal
  variables was established. Recheck after CLI upgrades.

Any probes require explicit user approval and must follow [the derisk probe rules](../AGENTS.md).
