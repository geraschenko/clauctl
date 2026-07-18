import assert from "node:assert/strict";
import { test } from "node:test";
import { TuiAutocompleteProvider } from "./autocomplete.ts";

// Drives the provider the way the Editor does: a "/" prefix at the cursor.
async function slashSuggestions(
  provider: TuiAutocompleteProvider,
  input: string,
): Promise<string[]> {
  const suggestions = await provider.getSuggestions([input], 0, input.length, {
    signal: new AbortController().signal,
  });
  return (suggestions?.items ?? []).map((item) => item.value);
}

test("local /model is offered with no SDK commands", async () => {
  const provider = new TuiAutocompleteProvider(null, null, () => {});
  assert.deepEqual(await slashSuggestions(provider, "/"), ["model", "tree"]);
});

test("setCommands merges SDK commands with the local ones", async () => {
  const provider = new TuiAutocompleteProvider(null, null, () => {});
  provider.setCommands([
    { name: "compact", description: "compact the conversation" },
    { name: "usage", description: "show usage" },
  ]);
  const values = await slashSuggestions(provider, "/");
  assert.deepEqual(values.toSorted(), ["compact", "model", "tree", "usage"]);
});

test("a local command shadows a same-named SDK entry", async () => {
  const provider = new TuiAutocompleteProvider(null, null, () => {});
  provider.setCommands([
    { name: "model", description: "the SDK's model command" },
  ]);
  const suggestions = await provider.getSuggestions(["/model"], 0, 6, {
    signal: new AbortController().signal,
  });
  const items = suggestions?.items ?? [];
  assert.equal(items.length, 1);
  assert.equal(items[0]!.value, "model");
  assert.equal(items[0]!.description, "select the agent's model interactively");
});

test("setCommands replaces the previous SDK list", async () => {
  const provider = new TuiAutocompleteProvider(null, null, () => {});
  provider.setCommands([{ name: "old" }]);
  provider.setCommands([{ name: "new" }]);
  const values = await slashSuggestions(provider, "/");
  assert.deepEqual(values.toSorted(), ["model", "new", "tree"]);
});

test("@ without fd fires the hint once and yields no suggestions", async () => {
  let hints = 0;
  const provider = new TuiAutocompleteProvider("/tmp", null, () => {
    hints += 1;
  });
  const options = { signal: new AbortController().signal };
  assert.equal(await provider.getSuggestions(["@src"], 0, 4, options), null);
  assert.equal(hints, 1);
  assert.equal(await provider.getSuggestions(["@src"], 0, 4, options), null);
  assert.equal(hints, 1);
});

test("non-@ input does not fire the hint", async () => {
  let hints = 0;
  const provider = new TuiAutocompleteProvider("/tmp", null, () => {
    hints += 1;
  });
  await slashSuggestions(provider, "/mo");
  assert.equal(hints, 0);
});
