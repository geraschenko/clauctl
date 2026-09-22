import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

// Barrels: a directory is imported through its one surface file.
const barrelPatterns = [
  {
    group: ["**/agent-state/*", "!**/agent-state/agent-state.ts"],
    message:
      "Import agent-state/agent-state.ts; the siblings are implementation.",
  },
  {
    group: ["**/observe-event/*", "!**/observe-event/index.ts"],
    message: "Import observe-event/index.ts; the siblings are implementation.",
  },
];

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-restricted-imports": ["error", { patterns: barrelPatterns }],
    },
  },
  // Every event is observed by foldEvent alone.
  {
    files: ["src/core/agent-state/*.ts"],
    ignores: ["src/core/agent-state/agent-state.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...barrelPatterns,
            {
              group: ["**/observe-event/index.ts"],
              importNames: ["observeEvent"],
              message:
                "observeEvent is called by foldEvent (agent-state.ts) only.",
            },
          ],
        },
      ],
    },
  },
  // Inside a barrel, siblings import each other, never their own barrel.
  {
    files: ["src/core/agent-state/observe-event/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["./index.ts", "**/observe-event/index.ts"],
              message:
                "A barrel's implementation imports its siblings, not the barrel.",
            },
          ],
        },
      ],
    },
  },
);
