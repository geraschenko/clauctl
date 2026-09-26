# Follow-up: the dependency DAG as a `.dot` file

Origin: Anton's review of `.dependency-cruiser.cjs` (54478c7, `// TDC:`
at the `DEPENDENCY_DAG` declaration).

## Problem

`DEPENDENCY_DAG` in `.dependency-cruiser.cjs` is a JS object literal:
readable only in the source, not viewable as a graph, and silently
incomplete — a new file or directory under `src/` is unconstrained
until somebody remembers to add it as a key.

## Proposal

1. `.allowed_dependencies.dot` (graphviz `digraph`) is the single source
   of truth; `.dependency-cruiser.cjs` parses it and derives the rules
   as it does today from the object. `dot -Tsvg` renders the allowed
   graph for review. Draft of the current DAG in that format:

   ```dot
   digraph allowed_dependencies {
     "main.ts" -> {"app.ts", "core"};
     "app.ts" -> {"commands", "core"};
     "commands" -> {"tui", "format", "core"};
     "tui" -> {"format", "core"};
     "format" -> "core";
     "format/api-messages" -> {"core/session", "core/uuid.ts"};
     "core/protocol" -> {"core/session", "core/tree", "core/uuid.ts", "core/stream-merge.ts"};
     "core/agent-state" -> {"core/protocol", "core/session", "core/tree", "core/stream-merge.ts", "core/to-non-nullable-usage.ts"};
     "core/protocol-client" -> {"core/protocol", "core/agent-state"};
     "core/protocol-server" -> {"core/protocol", "core/agent-state", "core/session", "core/tree", "core/stream-merge.ts", "core/uuid.ts", "core/options.ts", "core/registry.ts"};
     "core/tree" -> {"core/session", "core/uuid.ts", "core/to-non-nullable-usage.ts"};
     "core/registry.ts" -> "core/options.ts";
   }
   ```

2. A script that lists the candidate nodes (top-level files and
   directories under `src/`, recursively where a directory is itself a
   node) and fails when one is neither a node in the `.dot` nor in an
   explicit exclusion list kept next to it. Adding a file then forces
   the decision: constrain it or exclude it.

## Open questions

- Node granularity: which directories are one node and which expand to
  their files (`core/*.ts` today are "loose", unconstrained).
- Whether the exclusion list lives in the `.dot` (as a comment/attribute)
  or in a sibling file the script reads.
- The edge semantics stay as documented in `.dependency-cruiser.cjs`
  (an edge grants the target and its descendants; no ancestor grant —
  the 54478c7 ancestor grant was reverted).
