import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { CLAUCTL_KEYBINDINGS, keybindingsPath } from "../keybindings.ts";
import type { Banner } from "../transcript/index.ts";
import { editKeybindings, reloadKeybindings } from "./keybindings-commands.ts";

/** editFileInExternalEditor only stops, restarts and re-renders its TUI. */
const STUB_TUI = {
  mode: "regular",
  stop: () => {},
  start: () => {},
  requestRender: () => {},
} as unknown as TUI;

/** Runs `body` with the given environment (undefined unsets) and a fresh
 *  config directory, restoring the environment afterwards. */
async function withEnv<T>(
  env: Record<string, string | undefined>,
  body: () => T | Promise<T>,
): Promise<T> {
  const vars = {
    CLAUCTL_CONFIG_DIR: mkdtempSync(join(tmpdir(), "kb-")),
    ...env,
  };
  const saved = Object.fromEntries(
    Object.keys(vars).map((name) => [name, process.env[name]]),
  );
  const assign = (values: Record<string, string | undefined>): void => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  assign(vars);
  try {
    return await body();
  } finally {
    assign(saved);
  }
}

const freshManager = (): KeybindingsManager =>
  new KeybindingsManager(CLAUCTL_KEYBINDINGS, {});

test("/keybindings without an editor only warns", async () => {
  const banners = await withEnv({ VISUAL: undefined, EDITOR: undefined }, () =>
    editKeybindings(STUB_TUI, freshManager()),
  );
  assert.deepEqual(banners, [
    { text: "set $EDITOR to edit keybindings", color: "warning" },
  ]);
});

test("/keybindings with a failing editor warns and does not reload", async () => {
  const banners = await withEnv({ VISUAL: undefined, EDITOR: "false" }, () =>
    editKeybindings(STUB_TUI, freshManager()),
  );
  assert.deepEqual(banners, [
    {
      text: "keybindings: editor exited nonzero; changes not applied",
      color: "warning",
    },
  ]);
});

test("/keybindings with an unparseable file still edits, then reports the failed reload", async () => {
  const banners = await withEnv({ VISUAL: undefined, EDITOR: "true" }, () => {
    writeFileSync(keybindingsPath(), "{not json");
    return editKeybindings(STUB_TUI, freshManager());
  });
  assert.deepEqual(
    banners.map(({ color }) => color),
    ["warning", "error"],
  );
  assert.match(banners[0]!.text, /^keybindings: defaults refresh skipped: /);
  assert.match(banners[1]!.text, /^keybindings not reloaded: /);
});

test("/keybindings with a clean edit reloads", async () => {
  const banners = await withEnv({ VISUAL: undefined, EDITOR: "true" }, () =>
    editKeybindings(STUB_TUI, freshManager()),
  );
  assert.deepEqual(banners, [{ text: "keybindings reloaded" }]);
});

test("a fatal reload keeps the live bindings", async () => {
  const keybindings = freshManager();
  const banners: Banner[][] = await withEnv({}, () => {
    writeFileSync(keybindingsPath(), JSON.stringify({ "app.detach": "f9" }));
    const applied = reloadKeybindings(keybindings);
    writeFileSync(keybindingsPath(), "{not json");
    return [applied, reloadKeybindings(keybindings)];
  });
  assert.deepEqual(banners[0], [{ text: "keybindings reloaded" }]);
  assert.equal(banners[1]![0]!.color, "error");
  assert.deepEqual(keybindings.getKeys("app.detach"), ["f9"]);
});

test("read warnings come back as keybindings warnings", async () => {
  const banners = await withEnv({}, () => {
    writeFileSync(keybindingsPath(), JSON.stringify({ "no.such.id": "f9" }));
    return reloadKeybindings(freshManager());
  });
  assert.equal(banners.length, 1);
  assert.equal(banners[0]!.color, "warning");
  assert.match(banners[0]!.text, /^keybindings: .*no\.such\.id/);
});
