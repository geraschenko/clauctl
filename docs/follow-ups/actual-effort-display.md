# Show the actual effort level, not the last-requested one

The footer's `effortLevel` is folded from the `controlApplied` echo, so it
shows what was requested, not what the CLI resolved: cascade fallbacks and
silent model downgrades (e.g. xhigh on a high-capped model) are invisible.

Findings (2026-07-21): no SDK stream message carries effort —
`includeHookEvents` only emits execution-progress notices for configured
hooks, not hook inputs. The only truth channels are in-process hook
callbacks and statusline input, whose `effort.level` is the
post-downgrade level of the current turn (same source as `CLAUDE_EFFORT`).

Sketch: daemon registers `hooks: { Stop: [{ hooks: [cb] }] }` in
`buildOptions` (bucket "code", so respawns re-register); the callback
reads `input.effort?.level`, narrows to `EffortLevel`, and publishes a new
`{ kind: "effortResolved"; level: EffortLevel | undefined }` SdkEvent via
a late-bound EventHub emitter (undefined clears the field — model without
effort support); `agent-state.ts` folds it. Known corner: a mid-turn
effort change is clobbered by the in-flight turn's Stop report until the
following turn's Stop corrects it; suppressing that needs turn-boundary
correlation in the daemon.
