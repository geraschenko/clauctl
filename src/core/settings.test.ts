import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSettings } from "./settings.ts";

function tempSettingsPath(): string {
  return join(
    mkdtempSync(join(tmpdir(), "clauctl-settings-")),
    "settings.json",
  );
}

const DEFAULTS = {
  tuiMode: "fullscreen",
  showResolvedBoundary: false,
  tree: { showSizes: true },
};

test("read: missing file is the defaults with no warnings", () => {
  const read = readSettings(tempSettingsPath());
  assert.deepEqual(read, { settings: DEFAULTS, warnings: [] });
});

test("read: explicit regular mode", () => {
  const path = tempSettingsPath();
  writeFileSync(path, JSON.stringify({ tuiMode: "regular" }));
  const read = readSettings(path);
  assert.deepEqual(read, {
    settings: { ...DEFAULTS, tuiMode: "regular" },
    warnings: [],
  });
});

test("read: explicit fullscreen mode", () => {
  const path = tempSettingsPath();
  writeFileSync(path, JSON.stringify({ tuiMode: "fullscreen" }));
  const read = readSettings(path);
  assert.deepEqual(read, { settings: DEFAULTS, warnings: [] });
});

test("read: showResolvedBoundary takes a boolean; anything else warns and keeps the default", () => {
  const path = tempSettingsPath();
  writeFileSync(path, JSON.stringify({ showResolvedBoundary: true }));
  assert.deepEqual(readSettings(path), {
    settings: { ...DEFAULTS, showResolvedBoundary: true },
    warnings: [],
  });
  writeFileSync(path, JSON.stringify({ showResolvedBoundary: "yes" }));
  const read = readSettings(path);
  assert.equal(read.settings.showResolvedBoundary, false);
  assert.equal(read.warnings.length, 1);
  assert.match(read.warnings[0]!, /"showResolvedBoundary"/);
  assert.match(read.warnings[0]!, /"yes"/);
});

test("read: tree.showSizes takes a boolean; a non-object tree or unknown tree key warns", () => {
  const path = tempSettingsPath();
  writeFileSync(path, JSON.stringify({ tree: { showSizes: false } }));
  assert.deepEqual(readSettings(path), {
    settings: { ...DEFAULTS, tree: { showSizes: false } },
    warnings: [],
  });
  writeFileSync(path, JSON.stringify({ tree: { showSizes: 1, other: true } }));
  const read = readSettings(path);
  assert.deepEqual(read.settings, DEFAULTS);
  assert.deepEqual(
    read.warnings.map((warning) => warning.split(":")[0]),
    ['"tree.showSizes"', 'unknown setting "tree.other" (ignored)'],
  );
  writeFileSync(path, JSON.stringify({ tree: [] }));
  assert.match(readSettings(path).warnings[0]!, /"tree": expected an object/);
});

test("read: parse failure warns and falls back to defaults", () => {
  const path = tempSettingsPath();
  writeFileSync(path, "{ not json");
  const read = readSettings(path);
  assert.equal(read.settings.tuiMode, "fullscreen");
  assert.equal(read.warnings.length, 1);
  assert.match(read.warnings[0]!, /cannot parse/);
});

test("read: non-object root warns and falls back to defaults", () => {
  const path = tempSettingsPath();
  writeFileSync(path, JSON.stringify([1, 2]));
  const read = readSettings(path);
  assert.equal(read.settings.tuiMode, "fullscreen");
  assert.equal(read.warnings.length, 1);
  assert.match(read.warnings[0]!, /root must be a JSON object/);
});

test("read: invalid tuiMode value warns and keeps the default", () => {
  const path = tempSettingsPath();
  writeFileSync(path, JSON.stringify({ tuiMode: "full" }));
  const read = readSettings(path);
  assert.equal(read.settings.tuiMode, "fullscreen");
  assert.equal(read.warnings.length, 1);
  assert.match(read.warnings[0]!, /"tuiMode"/);
  assert.match(read.warnings[0]!, /"full"/);
});

test("read: non-string tuiMode value warns and keeps the default", () => {
  const path = tempSettingsPath();
  writeFileSync(path, JSON.stringify({ tuiMode: 3 }));
  const read = readSettings(path);
  assert.equal(read.settings.tuiMode, "fullscreen");
  assert.equal(read.warnings.length, 1);
});

test("read: unknown keys warn individually and are ignored", () => {
  const path = tempSettingsPath();
  writeFileSync(
    path,
    JSON.stringify({ tuiMode: "regular", theme: "dark", fontSize: 12 }),
  );
  const read = readSettings(path);
  assert.equal(read.settings.tuiMode, "regular");
  assert.deepEqual(read.warnings, [
    'unknown setting "theme" (ignored)',
    'unknown setting "fontSize" (ignored)',
  ]);
});
