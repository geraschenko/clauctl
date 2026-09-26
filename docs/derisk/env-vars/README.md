# Static environment-variable inventory

`extract.ts` uses the TypeScript compiler API to parse JavaScript and resolve
local bindings. It never imports or executes the inspected code. No additional
dependencies are needed beyond this repository's development dependencies.

```sh
node docs/derisk/env-vars/extract.ts \
  node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude \
  > /tmp/claude-env-inventory.json

node --test docs/derisk/env-vars/extract.test.ts
```

The argument can also be a `.js`, `.mjs`, or `.cjs` source file. Binary input
is scanned for `// @bun @bytecode\n// Claude Code` source chunks ending at NUL.
Missing chunks, unterminated chunks, and JavaScript syntax errors fail explicitly.
This requires Node's TypeScript stripping support, as used by the repository.

## Output

JSON contains:

- `names`: sorted, deduplicated union of direct references and registrations.
- `references`: literal environment property names with source byte offsets.
  This category includes reads, writes, and deletes; it does not distinguish them.
- `registrations`: schema names, byte offsets, and parser source expressions,
  such as `M.bool()`, `M.int({min:1})`, or `M.enum(["strict","relaxed"])`.
  Minified parser identifiers are local to the source chunk.
- `uppercaseCandidates`: sorted, unique identifiers and whole string literals
  matching `[A-Z][A-Z0-9_]*`, at least 12 characters long, excluding names already
  in the inventory. These are **unclassified candidates**, not environment
  dependencies. Constants and protocol strings produce many false positives.

Offsets are UTF-8 byte offsets in the original input, not JavaScript character
positions. Multiple references or registrations for one name are retained.

For a plain list:

```sh
jq -r '.names[]' /tmp/claude-env-inventory.json
```

## Supported analysis

General JavaScript analysis recognizes an unshadowed global `process.env`,
literal dot/bracket property accesses, local `const` alias chains, and object
destructuring from the environment object. TypeScript symbols distinguish
bindings with the same spelling in different scopes. Aliases are cycle-checked.
There is no environment-name prefix requirement: `PATH`, `ANTHROPIC_BASE_URL`,
and mixed-case names are included when referenced through supported patterns.

The Claude-specific schema adapter recognizes a function declaration that
both enumerates its first parameter with `Object.entries` and indexes the
environment object. At calls to that factory, it follows the first argument's
local initializers, object spreads, and compiled getter-map registrations
of the form `helper(schema, { NAME: () => parser })`. Parser identifiers are
resolved to local initializers, including the `var` declarations used by the
bundle. Empty schemas contribute no names.

Registration proves that a name occurs in a recognized schema, **not** that
an active consumer uses it. Likewise, a reference may be in unreachable code.
The parser expression is evidence, not an interpreted type/default contract:
arguments may contain unresolved identifiers, and consumers can supply their
own defaults independently of the parser.

## Deliberate limits

- No dynamic key resolution, including `env[key]` when `key` is a constant.
- No general value-flow analysis: reassignment, control flow, function returns,
  parameter propagation, object mutation, and execution order are not modeled.
- No import resolution, `process` aliases/imports, `Bun.env`, or destructuring
  an environment object out of `process` itself.
- No consumer tracing through schema-backed accessors. Their names come from
  registrations, not from guessing that an arbitrary `object.NAME` reads env.
- The schema adapter targets the observed compiled shape, not arbitrary schema
  libraries. It does not follow inherited accessor prototypes or imported schemas.
- Only embedded JavaScript is analyzed, not native code, bytecode string tables,
  the SDK wrapper, or subprocess dependencies.

Keep the adapter's structural assumptions covered by fixtures when the bundle
changes. Candidate names provide a separate cross-check, not a completeness
claim. In particular, a missing registration should prompt inspection rather
than automatically promote an all-caps name to a functional environment flag.
