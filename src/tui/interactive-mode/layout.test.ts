import assert from "node:assert/strict";
import { test } from "node:test";
import { Container, Text, VStack } from "@earendil-works/pi-tui";
import { buildFullscreenLayout } from "./layout.ts";

test("buildFullscreenLayout: scroll region wraps the transcript, dock keeps today's order", () => {
  const parts = {
    chatContainer: new Container(),
    statusContainer: new Container(),
    pendingMessages: new Text(""),
    inputSlot: new Container(),
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
    parts.inputSlot,
    parts.hintText,
    parts.footer,
  ]);
});
