# Derisk: environment controls for model-facing instructions

## Scope and evidence

Question: which environment variables control harness-injected instructions,
what does the assistant see, and can the injections be disabled independently?

Method: static inspection of embedded JavaScript in
`node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`:
**Claude Code 2.1.258**, SDK platform package **0.3.258**. No CLI execution,
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
| `GAULT_KESTREL`                                        | Removes a caution about unexpected target state before deletion/overwrite.               | Preference-dependent; `false` is not a reliable opt-out.                                                                                   |
| `LARCH_CISTERN`                                        | Discourages excessive self-correction.                                                   | Preference-dependent; `false` is not a reliable opt-out.                                                                                   |
| `WILLOW_TERN`                                          | Self-contained final answers with restrictive writing rules.                             | Preference-dependent; `false` is not a reliable opt-out.                                                                                   |
| `SIMPLE_SYSTEM_PROMPT`                                 | Lean system prompt and tool descriptions.                                                | Preference-dependent; full variant diff not audited.                                                                                       |
| `DISABLE_ATTACHMENTS`                                  | Skips much of normal attachment collection, including useful context.                    | Depends on desired context discovery; not a universal no-injection switch.                                                                 |

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

## Attachment-based reminders

Unless stated otherwise, the reminder renderers create user-role messages,
marked internally `isMeta`, with their text wrapped as follows:

```xml
<system-reminder>
REMINDER_TEXT
</system-reminder>
```

This tag does not change the API role to `system`. The persisted attachment
itself need not be marked `isMeta`. Wrapper evidence: byte 186339607;
user-message constructor: 186295185.

### Total-token reminder

Controls:

- `CLAUDE_CODE_TOTAL_TOKENS_REMINDER`
- `CLAUDE_CODE_TOTAL_TOKENS_REMINDER_BUDGET`
- `CLAUDE_CODE_TOTAL_TOKENS_REMINDER_AFTER_USER_TURN`

**Insertion:** `total_tokens_reminder` attachment, rendered as the user-role
reminder above. Generated between tool rounds and, by default, on regular
user prompts. The producer also supports per-agent accounting.

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
  cache read, and output tokens. It is not the sum of billed tokens across
  requests and is not the account's five-hour allowance.
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

Evidence: configuration and accumulator at 182418334–182420300; latest usage
lookup at 182872406; producer at 186130977; renderer near 186361572;
compaction rollover call sites at 185061713 and 185098313.

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

Evidence: producer at 186130600–186130977; effective-window helper at
182867888; renderer near 186361572.

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

Evidence: 186082056–186082700; main-agent gate near 186091837;
producer at 186097339.

### Todo and task reminders

`CLAUDE_CODE_TODO_REMINDER_MODE`

**Insertion:** controls generation of both `todo_reminder` and
`task_reminder`. The value `off` disables reminders without removing the
corresponding tools. The experiment
fallback is `baseline` (`tengu_soft_slate_nudge`). Producers require eligible
tools and history; the baseline checks ten assistant turns since relevant
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
Evidence: mode selection at 186088089; producers at 186125822–186127000;
renderers at 186369586 and 186370214.

## Ephemeral request-time reminders

### Batching: `CLAUDE_CODE_TOASTY_THIMBLE`

**Insertion:** ephemeral `batching_reminder` attachment inserted near the
last eligible user-role tool-result message immediately before inference.
It renders with the same user-role `<system-reminder>` wrapper. Generation
has model eligibility and tool-result/error guards; it is not unconditional
on every request.

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

Selections are latched per conversation/model. The transcript records
`batching_reminder_sent` with text/model as bookkeeping; that record's
renderer returns no messages. It is not a persisted copy that is repeatedly
rendered into subsequent requests.

Purpose is apparent: encourage independent tool calls in parallel to reduce
sequential inference rounds. It explicitly requests private planning first.

Evidence: text/configuration/selection around 184921500–184923230;
insertion at 184924119; recording at 185072331; empty renderer at 186366158.

### Secondary reminder: `CLAUDE_CODE_GENTLE_PARASOL`

**Insertion:** ephemeral `secondary_reminder` through the same request-time
mechanism, with a `secondary_reminder_sent` bookkeeping record. It has its
own selection and latch. Some batching-specific suppression guards do not
apply to this secondary reminder.

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

## Bash-first instructions

### `CLAUDE_CODE_THRIFTY_SONIC`

`false` is an explicit override ahead of automatic model/cohort selection;
`true` forces enablement. The remote experiment is `tengu_thrifty_sonic`.

**Verified insertion:** the `auto_mode` attachment, rendered as a user-role
system reminder. It can be generated in **auto or bypass-permissions mode**,
requires appropriate tools, and is not injected afresh every turn once the
mode attachment is present. False disables this Bash-first branch; it does
not necessarily suppress other auto-mode guidance.

Exact Bash-first paragraph:

```text
Do your work through the Bash tool wherever it can accomplish the job: read files with cat, head, or sed -n, search with grep and find, and make file changes with sed, heredocs, or short scripts, rather than using the dedicated Read, Edit, or Write tools. Fall back to a dedicated tool only when Bash genuinely cannot do the job.
```

In bypass mode the complete body for this branch is:

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

Evidence: precedence at 179492653; attachment producer at 186100055;
text near 186377172.

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

Evidence: helper at 179493285; insertion at 185363299.

## Other prompt experiments traced

### `CLAUDE_CODE_AMBER_ASTROLABE`

**Insertion:** `autonomy_append` system-prompt section. The section has an
additional `tengu_amber_sextant` gate, defaulting on. Either a model predicate
or the Astrolabe helper can enable it. The helper combines the environment
flag with remote assignment using OR, so false does not reliably suppress it.

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

Evidence: helper at 179493368; text at 185691900–185693500;
section selection near 185714417.

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

Evidence: selection at 179494241; Write at 180396500–180398000;
Edit at 182757300–182759500.

### `CLAUDE_CODE_GAULT_KESTREL`

**Insertion:** removes a cautionary clause from the `action_caution` system
prompt section. The affected fragment when enabled is:

```text
Before deleting or overwriting, look at the target.
```

When disabled, the fragment is:

```text
Before deleting or overwriting, look at the target. If what you find contradicts how it was described, or you didn't create it, surface that instead of proceeding.
```

This is a wording subtraction, not a new attachment or permissions change.
Enablement includes environment, model-bundle, client-data, and GrowthBook
paths combined with OR; false is not a reliable opt-out.

**Hypothesis:** reduce unnecessary hesitation or clarification before edits.
The removed clause also supplied a specific caution about unexpected target
state, so it is not merely a stylistic shortening.

Evidence: helper at 179493193; affected template at 185686144.

### `CLAUDE_CODE_LARCH_CISTERN`

**Insertion:** `overcorrection` system-prompt section. OR-style enablement
includes the environment flag, model bundle, and remote assignments; false
is not a reliable opt-out.

Exact section:

```text
# Corrections
Avoid unnecessary or excessive self-correction. Only correct an earlier statement in your user-facing text when the error would change the user's code, conclusions, or decisions. State corrections plainly and concisely, and continue the task; combine multiple corrections rather than enumerating them all. For slips that change nothing for the user, simply make the correction and move on - no need to note it explicitly. Don't add apologies or preambles, don't be overly self-critical, and don't ruminate or give a detailed account of the mistake or tally past errors. Sometimes, other agents will report incorrect or misleading results - don't always take them at face value immediately. If other agents correct your statements and they are right, then simply update your approach without narrating too much about the correction to the user. This instruction does not apply to thinking blocks.

A follow-up question about your earlier work is not, by itself, a signal that you got something wrong — answer what was asked. A statement that was accurate needs no correction: don't re-audit how you phrased it, how you verified it, or limits you already stated. When the user does point to a real error, correct it plainly as above.
```

Purpose is apparent: suppress unnecessary self-correction and repeated
re-auditing without suppressing consequential corrections.

Evidence: helper at 179493494; text at 185711834;
section selection near 185714417.

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

Evidence: selection at 179493600–179494000;
text at 185689400–185691471; section selection near 185714417.

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

Evidence: selector at 179494241–179495000; consumers cited above.

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

- The ephemeral batching/secondary mechanism is separate.
- System-prompt sections and tool descriptions remain separate.
- Existing persisted attachments are not necessarily filtered from rendering.
- Other code paths can create attachments outside the collector.

**Hypothesis:** useful for stripped-down execution or evaluation, not a
surgical preference for fewer behavioral nudges. Targeted opt-outs avoid
losing useful context discovery along with reminders.

Evidence: collector branch at 186088101.

## Open questions and validation

- Wire-test the targeted opt-outs on fresh and resumed sessions. Determine
  which historical reminders remain visible after their producers are off.
- Capture actual client/model assignments separately from fallback values;
  source defaults do not establish a particular user's active experiments.
- Audit the complete lean/non-lean prompt diff before recommending
  `CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT` as a workaround.
- Verify the practical relation between the `token_usage` total and each
  compaction trigger; do not present it as an exact auto-compaction countdown.
- No universal experiment opt-out or supported contract for these internal
  variables was established. Recheck after CLI upgrades.

Any probes require explicit user approval and must follow [the derisk probe rules](../AGENTS.md).
