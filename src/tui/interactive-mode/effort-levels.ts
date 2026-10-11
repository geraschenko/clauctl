import type { EffortLevel, ModelInfo } from "@anthropic-ai/claude-agent-sdk";

/** What `/effort` can offer for the current model. */
export type EffortLevelsLookup =
  | { kind: "unknownModel" }
  | { kind: "noEffortLevels" }
  | { kind: "levels"; model: ModelInfo; levels: EffortLevel[] };

/** The effort levels `models` lists for `currentModel`. */
export function effortLevelsOf(
  models: readonly ModelInfo[],
  currentModel: string | undefined,
): EffortLevelsLookup {
  // agentState.model holds a set-model request value or the SDK init
  // message's resolved id, depending on history — so match both.
  const model = models.find(
    (candidate) =>
      currentModel !== undefined &&
      (candidate.value === currentModel ||
        candidate.resolvedModel === currentModel),
  );
  if (model === undefined) return { kind: "unknownModel" };
  const levels = model.supportedEffortLevels ?? [];
  return levels.length === 0
    ? { kind: "noEffortLevels" }
    : { kind: "levels", model, levels };
}
