/** The tool-view registry: the only module that imports the views. */

import { agentView } from "./agent.ts";
import { bashView } from "./bash.ts";
import { defaultToolView } from "./default-tool-view.ts";
import { editView } from "./edit.ts";
import type { ToolInputMap, ToolName } from "./generated.ts";
import { readView } from "./read.ts";
import type { ToolView } from "./tool-view.ts";
import { webSearchView } from "./websearch.ts";
import { writeView } from "./write.ts";

export const toolViews: { [K in ToolName]?: ToolView<ToolInputMap[K]> } = {
  Agent: agentView,
  Bash: bashView,
  Edit: editView,
  Read: readView,
  WebSearch: webSearchView,
  Write: writeView,
};

/** The single type-erasure point: views are written against their generated
 *  input types, callers hold runtime args as unknown. Views treat args
 *  defensively (args.ts stringArg) — the wire payload is untrusted, so the
 *  lookup is by own property (a tool named `constructor` is unknown, not
 *  a function). */
export function toolViewFor(name: string): ToolView<unknown> {
  const view = Object.hasOwn(toolViews, name)
    ? (toolViews as Record<string, ToolView<unknown> | undefined>)[name]
    : undefined;
  return view ?? defaultToolView;
}
