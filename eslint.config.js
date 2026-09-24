import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

// Barrels: a directory is imported through its one surface file.
const barrelPatterns = [
  {
    group: ["**/agent-state/*", "!**/agent-state/index.ts"],
    message: "Import agent-state/index.ts; the siblings are implementation.",
  },
  {
    group: ["**/observe-event/*", "!**/observe-event/index.ts"],
    message: "Import observe-event/index.ts; the siblings are implementation.",
  },
  {
    group: ["**/protocol/*", "!**/protocol/index.ts"],
    message: "Import protocol/index.ts; the siblings are implementation.",
  },
  {
    group: ["**/protocol-client/*", "!**/protocol-client/index.ts"],
    message:
      "Import protocol-client/index.ts; the siblings are implementation.",
  },
  {
    group: ["**/protocol-server/*", "!**/protocol-server/index.ts"],
    message:
      "Import protocol-server/index.ts; the siblings are implementation.",
  },
  {
    group: ["**/entry-view/*", "!**/entry-view/index.ts"],
    message: "Import entry-view/index.ts; the siblings are implementation.",
  },
  {
    group: ["**/attachment-view/*", "!**/attachment-view/index.ts"],
    message:
      "Import attachment-view/index.ts; the siblings are implementation.",
  },
  {
    group: ["**/tool-view/*", "!**/tool-view/index.ts"],
    message: "Import tool-view/index.ts; the siblings are implementation.",
  },
];

/** Inside a barrel, siblings import each other, never their own barrel. */
const barrelImplementation = (dir) => ({
  files: [`src/${dir}/**`],
  ignores: [`src/${dir}/index.ts`],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          ...barrelPatterns,
          {
            group: [
              "./index.ts",
              "../index.ts",
              `**/${dir.split("/").at(-1)}/index.ts`,
            ],
            message:
              "A barrel's implementation imports its siblings, not the barrel.",
          },
        ],
      },
    ],
  },
});

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
    ignores: ["src/core/agent-state/next-agent-state.ts"],
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
                "observeEvent is called by foldEvent (next-agent-state.ts) only.",
            },
          ],
        },
      ],
    },
  },
  barrelImplementation("core/agent-state"),
  barrelImplementation("core/protocol"),
  barrelImplementation("core/protocol-client"),
  barrelImplementation("core/protocol-server"),
  barrelImplementation("format/entry-view"),
  barrelImplementation("format/entry-view/attachment-view"),
  barrelImplementation("format/entry-view/tool-view"),
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
