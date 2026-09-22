// DECISION-4 coverage invariant (docs/specs/lifecycle-and-sdk-commands.md):
// every method of the SDK's `Query` interface is a passthrough subcommand,
// or is named in the daemon mapping site's exclusion comment
// (sdk-passthrough.ts). Parsed from sdk.d.ts because Query is an interface:
// there is no runtime object to reflect on.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { sdkRoutes } from "./sdk-commands.ts";

const SDK_DTS = fileURLToPath(
  new URL(
    "../../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts",
    import.meta.url,
  ),
);
const PASSTHROUGH_MAPPING_SITE = fileURLToPath(
  new URL("./sdk-passthrough.ts", import.meta.url),
);

/** Query methods whose subcommand is not the method's kebab-case name. */
const SUBCOMMAND_ALIASES: Record<string, string> = {
  // Stable alias; the SDK marks the method experimental.
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: "usage",
};

function queryMethodNames(): string[] {
  const dts = readFileSync(SDK_DTS, "utf8");
  const body = dts.match(
    /^export declare interface Query extends AsyncGenerator<SDKMessage, void> \{([\s\S]*?)^\}/m,
  );
  assert.ok(body, "Query interface not found in sdk.d.ts");
  // Method declarations at the interface's own indentation; nested option
  // objects are indented deeper.
  return [...body[1]!.matchAll(/^ {4}([A-Za-z_]\w*)\(/gm)].map(
    (match) => match[1]!,
  );
}

function kebabCase(name: string): string {
  return name.replace(/[A-Z]/g, (upper) => `-${upper.toLowerCase()}`);
}

test("every Query method is a subcommand or an exclusion documented at the mapping site", () => {
  const methods = queryMethodNames();
  assert.ok(methods.length > 0);
  const mappingSite = readFileSync(PASSTHROUGH_MAPPING_SITE, "utf8");
  const uncovered = methods.filter((method) => {
    const subcommand = SUBCOMMAND_ALIASES[method] ?? kebabCase(method);
    return !(subcommand in sdkRoutes) && !mappingSite.includes(method);
  });
  assert.deepEqual(uncovered, []);
});
