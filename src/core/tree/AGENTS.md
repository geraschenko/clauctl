# src/core/tree

Before changing anything here, read docs/session-views.md: the session
file, the context presented to the assistant (`loader.ts` — must
mirror the CLI binary), and the tree presented to the user
(`display-tree.ts` — chronological, human-oriented) are three distinct
views with different rules. Do not move logic between them.
