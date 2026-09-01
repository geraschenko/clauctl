# Development Rules

## Conversational Style

- Keep answers short and concise
- Technical prose only, be direct
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Do not delete explanatory comments unless they are obsolete; preserve or update them when refactoring.
- Iterating over the same collection several times in one function is a design smell; combine passes unless a pass genuinely needs lookahead over the whole collection.

## Naming and References

- Name things by their semantic role, so the name is comprehensible without external context. Never name after an arbitrary ordering (`rule4Parent` bad, `linearizedGroupParent` good).
- Use the repo's established terminology; do not coin synonyms for concepts that already have names (a boundary's list of kept uuids is its "preserved uuids").
- Shorthand references in comments and test names (probe ids like `p20`, pipeline stage numbers) must be locally resolvable: define the pointer once in the file's header comment and write "…; see file comment" at each use site.
- Minified identifiers from decompiled code belong only in the derisk findings docs, never in product code or comments.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
