import assert from "node:assert/strict";
import { test } from "node:test";
import { Container, Text, VStack } from "@earendil-works/pi-tui";
import {
  buildFullscreenLayout,
  parseEffortCommand,
  parseModelCommand,
} from "./interactive-mode.ts";

test("bare /model opens the menu", () => {
  assert.deepEqual(parseModelCommand("/model"), { model: undefined });
  assert.deepEqual(parseModelCommand("  /model  "), { model: undefined });
});

test("/model with an argument passes the trimmed remainder verbatim", () => {
  assert.deepEqual(parseModelCommand("/model opus"), { model: "opus" });
  assert.deepEqual(parseModelCommand("/model  claude-sonnet-4-6  "), {
    model: "claude-sonnet-4-6",
  });
  assert.deepEqual(parseModelCommand("/model opus with words"), {
    model: "opus with words",
  });
});

test("only an exact case-sensitive /model token matches", () => {
  assert.equal(parseModelCommand("/Model"), null);
  assert.equal(parseModelCommand("/models"), null);
  assert.equal(parseModelCommand("/model/x"), null);
  assert.equal(parseModelCommand("model"), null);
  assert.equal(parseModelCommand("tell me about /model"), null);
  assert.equal(parseModelCommand("/compact"), null);
});

test("bare /effort opens the menu", () => {
  assert.deepEqual(parseEffortCommand("/effort"), { level: undefined });
  assert.deepEqual(parseEffortCommand("  /effort  "), { level: undefined });
});

test("/effort with an argument passes the trimmed remainder verbatim", () => {
  assert.deepEqual(parseEffortCommand("/effort high"), { level: "high" });
  assert.deepEqual(parseEffortCommand("/effort  max  "), { level: "max" });
  assert.deepEqual(parseEffortCommand("/effort not a level"), {
    level: "not a level",
  });
});

test("only an exact case-sensitive /effort token matches", () => {
  assert.equal(parseEffortCommand("/Effort"), null);
  assert.equal(parseEffortCommand("/efforts"), null);
  assert.equal(parseEffortCommand("/effort/x"), null);
  assert.equal(parseEffortCommand("effort"), null);
  assert.equal(parseEffortCommand("tell me about /effort"), null);
  assert.equal(parseEffortCommand("/compact"), null);
});

test("buildFullscreenLayout: scroll region wraps the transcript, dock keeps today's order", () => {
  const parts = {
    chatContainer: new Container(),
    statusContainer: new Container(),
    pendingMessages: new Text(""),
    editor: new Text(""),
    hintText: new Text(""),
    footer: new Text(""),
  };
  const layout = buildFullscreenLayout(parts);
  // The transcript scroll view is the primary (fullscreen navigation/search
  // target), follows new output, and chains overscroll to the terminal.
  assert.equal(layout.transcriptScrollView.children[0], parts.chatContainer);
  assert.equal(layout.transcriptScrollView.primary, true);
  assert.equal(layout.transcriptScrollView.overscroll, "chain");
  assert.equal(layout.transcriptScrollView.isFollowingEnd, true);
  // Root: transcript region above a single dock.
  assert.equal(layout.layoutRoot.children.length, 2);
  assert.equal(layout.layoutRoot.children[0], layout.transcriptScrollView);
  const dock = layout.layoutRoot.children[1];
  assert.ok(dock instanceof VStack);
  // Same visual order as the regular-mode flat mount (minus the transcript).
  assert.deepEqual(dock.children, [
    parts.statusContainer,
    parts.pendingMessages,
    parts.editor,
    parts.hintText,
    parts.footer,
  ]);
});
