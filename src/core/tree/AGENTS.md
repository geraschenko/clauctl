# src/core/tree

Before changing anything here, read docs/session-views.md: the session
file, the context presented to the assistant (`loader.ts` — must
mirror the CLI binary; `context-tree.ts` is the same view as one
relation over every occurrence), and the tree presented to the user
(`display-tree.ts` — chronological, human-oriented, derived from the
context tree) are three distinct views with different rules. Do not move
logic between them.
