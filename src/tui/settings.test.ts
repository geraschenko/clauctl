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

test("read: missing file is the fullscreen default with no warnings", () => {
  const read = readSettings(tempSettingsPath());
  assert.deepEqual(read, {
    settings: { tuiMode: "fullscreen" },
    warnings: [],
  });
});

test("read: explicit regular mode", () => {
  const path = tempSettingsPath();
  writeFileSync(path, JSON.stringify({ tuiMode: "regular" }));
  const read = readSettings(path);
  assert.deepEqual(read, { settings: { tuiMode: "regular" }, warnings: [] });
});

test("read: explicit fullscreen mode", () => {
  const path = tempSettingsPath();
  writeFileSync(path, JSON.stringify({ tuiMode: "fullscreen" }));
  const read = readSettings(path);
  assert.deepEqual(read, { settings: { tuiMode: "fullscreen" }, warnings: [] });
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
