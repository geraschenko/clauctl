import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  KeybindingsManager,
  type KeybindingDefinitions,
} from "@earendil-works/pi-tui";
import {
  conflictWarnings,
  defaultBindings,
  promoteEditedDefaults,
  readKeybindingsConfig,
  writeDefaultBindings,
} from "./keybindings.ts";

const DEFS: KeybindingDefinitions = {
  "app.one": { defaultKeys: "ctrl+o" },
  "app.two": { defaultKeys: ["ctrl+t", "alt+t"] },
};

function tempConfigPath(): string {
  return join(mkdtempSync(join(tmpdir(), "clauctl-kb-")), "keybindings.json");
}

function writeConfig(path: string, value: unknown): void {
  writeFileSync(
    path,
    typeof value === "string" ? value : JSON.stringify(value),
  );
}

function parseFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

test("defaultBindings: single key as string, multiple as array", () => {
  assert.deepEqual(defaultBindings(DEFS), {
    "app.one": "ctrl+o",
    "app.two": ["ctrl+t", "alt+t"],
  });
});

test("read: missing file is an empty config", () => {
  const read = readKeybindingsConfig(tempConfigPath(), DEFS);
  assert.deepEqual(read, { ok: true, bindings: {}, warnings: [] });
});

test("read: parse failure is fatal", () => {
  const path = tempConfigPath();
  writeConfig(path, "{ not json");
  const read = readKeybindingsConfig(path, DEFS);
  assert.equal(read.ok, false);
});

test("read: non-object root is fatal", () => {
  const path = tempConfigPath();
  writeConfig(path, [1, 2]);
  const read = readKeybindingsConfig(path, DEFS);
  assert.equal(read.ok, false);
});

test("read: valid overrides pass through, [] unbinds", () => {
  const path = tempConfigPath();
  writeConfig(path, { "app.one": ["ctrl+x", "alt+x"], "app.two": [] });
  const read = readKeybindingsConfig(path, DEFS);
  assert.ok(read.ok);
  assert.deepEqual(read.bindings, {
    "app.one": ["ctrl+x", "alt+x"],
    "app.two": [],
  });
  assert.deepEqual(read.warnings, []);
});

test("read: unknown id, malformed entry, and bad key warn but do not block the rest", () => {
  const path = tempConfigPath();
  writeConfig(path, {
    "app.typo": "ctrl+x",
    "app.one": 7,
    "app.two": "ctrl+oo",
  });
  const read = readKeybindingsConfig(path, DEFS);
  assert.ok(read.ok);
  assert.deepEqual(read.bindings, {});
  assert.equal(read.warnings.length, 3);
  assert.match(read.warnings[0]!, /unknown action id "app.typo"/);
  assert.match(read.warnings[1]!, /"app.one": expected a key string/);
  assert.match(read.warnings[2]!, /"app.two": unrecognized key "ctrl\+oo"/);
});

test("read: modifier chains and symbol keys are well-formed", () => {
  const path = tempConfigPath();
  writeConfig(path, { "app.one": "ctrl+shift+p", "app.two": "ctrl++" });
  const read = readKeybindingsConfig(path, DEFS);
  assert.ok(read.ok);
  assert.deepEqual(read.warnings, []);
  assert.deepEqual(read.bindings, {
    "app.one": "ctrl+shift+p",
    "app.two": "ctrl++",
  });
});

test("read: default_bindings is stripped; matching snapshot is silent", () => {
  const path = tempConfigPath();
  writeConfig(path, {
    default_bindings: { "//": "note", ...defaultBindings(DEFS) },
  });
  const read = readKeybindingsConfig(path, DEFS);
  assert.ok(read.ok);
  assert.deepEqual(read.bindings, {});
  assert.deepEqual(read.warnings, []);
});

test("read: default_bindings drift nudges without implying self-healing", () => {
  const path = tempConfigPath();
  writeConfig(path, {
    default_bindings: { "app.one": "ctrl+z", "app.two": ["ctrl+t", "alt+t"] },
  });
  const read = readKeybindingsConfig(path, DEFS);
  assert.ok(read.ok);
  assert.equal(read.warnings.length, 1);
  assert.match(read.warnings[0]!, /differs from the current defaults/);
  assert.match(read.warnings[0]!, /run \/keybindings to refresh/);
});

test("read: non-empty replaced_default_bindings warns until removed", () => {
  const path = tempConfigPath();
  writeConfig(path, {
    replaced_default_bindings: [{ "app.one": "ctrl+z" }],
  });
  const read = readKeybindingsConfig(path, DEFS);
  assert.ok(read.ok);
  assert.equal(read.warnings.length, 1);
  assert.match(read.warnings[0]!, /replaced_default_bindings/);
  const empty = tempConfigPath();
  writeConfig(empty, { replaced_default_bindings: [] });
  const emptyRead = readKeybindingsConfig(empty, DEFS);
  assert.ok(emptyRead.ok);
  assert.deepEqual(emptyRead.warnings, []);
});

test("writeDefaultBindings: creates the file with the note and defaults", () => {
  const path = tempConfigPath();
  writeDefaultBindings(path, DEFS);
  const root = parseFile(path);
  const field = root.default_bindings as Record<string, unknown>;
  assert.match(field["//"] as string, /move it to the top level/i);
  assert.deepEqual(field["app.one"], "ctrl+o");
  assert.deepEqual(field["app.two"], ["ctrl+t", "alt+t"]);
  assert.equal(root.replaced_default_bindings, undefined);
});

test("writeDefaultBindings: preserves top-level user entries", () => {
  const path = tempConfigPath();
  writeConfig(path, { "app.one": "ctrl+x" });
  writeDefaultBindings(path, DEFS);
  const root = parseFile(path);
  assert.equal(root["app.one"], "ctrl+x");
});

test("writeDefaultBindings: displaces drift into replaced_default_bindings with dedupe", () => {
  const path = tempConfigPath();
  writeConfig(path, {
    default_bindings: { "app.one": "ctrl+z", "app.two": ["ctrl+t", "alt+t"] },
    replaced_default_bindings: [
      { "app.one": "ctrl+z" },
      { "app.one": "ctrl+y" },
    ],
  });
  writeDefaultBindings(path, DEFS);
  const root = parseFile(path);
  // "app.one": "ctrl+z" is already snapshotted — deduplicated, not repeated.
  assert.deepEqual(root.replaced_default_bindings, [
    { "app.one": "ctrl+z" },
    { "app.one": "ctrl+y" },
  ]);
  const field = root.default_bindings as Record<string, unknown>;
  assert.equal(field["app.one"], "ctrl+o");
});

test("writeDefaultBindings: throws on an unparseable file", () => {
  const path = tempConfigPath();
  writeConfig(path, "{ not json");
  assert.throws(() => writeDefaultBindings(path, DEFS));
  assert.equal(readFileSync(path, "utf8"), "{ not json");
});

test("promoteEditedDefaults: moves edits to top-level overrides and restores the default", () => {
  const path = tempConfigPath();
  writeDefaultBindings(path, DEFS);
  const root = parseFile(path);
  (root.default_bindings as Record<string, unknown>)["app.one"] = "ctrl+x";
  writeConfig(path, root);
  const { warnings } = promoteEditedDefaults(path, DEFS);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /"app.one" moved to a top-level override/);
  const after = parseFile(path);
  assert.equal(after["app.one"], "ctrl+x");
  assert.equal(
    (after.default_bindings as Record<string, unknown>)["app.one"],
    "ctrl+o",
  );
});

test("promoteEditedDefaults: an existing top-level entry wins", () => {
  const path = tempConfigPath();
  writeConfig(path, { "app.one": "ctrl+v" });
  writeDefaultBindings(path, DEFS);
  const root = parseFile(path);
  (root.default_bindings as Record<string, unknown>)["app.one"] = "ctrl+x";
  writeConfig(path, root);
  const { warnings } = promoteEditedDefaults(path, DEFS);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /top-level entry wins/);
  const after = parseFile(path);
  assert.equal(after["app.one"], "ctrl+v");
});

test("promoteEditedDefaults: no drift means no rewrite and no warnings", () => {
  const path = tempConfigPath();
  writeDefaultBindings(path, DEFS);
  const before = readFileSync(path, "utf8");
  assert.deepEqual(promoteEditedDefaults(path, DEFS), { warnings: [] });
  assert.equal(readFileSync(path, "utf8"), before);
});

test("conflictWarnings: formats user-vs-user key claims", () => {
  const manager = new KeybindingsManager(DEFS, {
    "app.one": "ctrl+x",
    "app.two": "ctrl+x",
  });
  const warnings = conflictWarnings(manager);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /key "ctrl\+x" is bound to multiple actions/);
  assert.match(warnings[0]!, /app.one/);
  assert.match(warnings[0]!, /app.two/);
});
