/**
 * The TUI's layout: the components it composes and how they mount on
 * the regular (document) and fullscreen (viewport) renderers.
 */

import {
  Container,
  isViewportTUI,
  ScrollView,
  VStack,
  type Component,
  type StackEntry,
  type TUI,
} from "@earendil-works/pi-tui";
import { FitWidth } from "../components/fit-width.ts";

/** The components the TUI composes, in one place so both mount paths draw
 *  from the same set. */
export interface TuiParts {
  chatContainer: Container;
  statusContainer: Container;
  pendingMessages: Component;
  /** Holds the editor, or the permission prompt while an ask is pending. */
  inputSlot: Container;
  hintText: Component;
  footer: Component;
}

/**
 * The non-transcript components in visual order, with their fullscreen dock
 * sizing (minSize keeps the editor at 3 rows and the footer at 1 on short
 * terminals). The single source of the below-transcript ordering: the
 * fullscreen dock VStack consumes the entries, the regular-mode flat mount
 * consumes just the components.
 */
function dockEntries(parts: TuiParts): StackEntry[] {
  return [
    { component: parts.statusContainer, shrink: 1, minSize: 0 },
    { component: parts.pendingMessages, shrink: 1, minSize: 0 },
    { component: parts.inputSlot, shrink: 1, minSize: 3 },
    { component: parts.hintText, shrink: 1, minSize: 0 },
    { component: parts.footer, shrink: 1, minSize: 1 },
  ];
}

/** The layout TuiAltScreen renders: transcript in a scroll region that takes
 *  the spare height, everything else in a fixed-bottom dock. */
export interface FullscreenLayout {
  /** The component handed to TuiAltScreen.setLayoutRoot. */
  layoutRoot: VStack;
  transcriptScrollView: ScrollView;
}

/**
 * Pure layout composition (exported for tests): wraps the transcript
 * container in the primary ScrollView — follow:"end" keeps it pinned to new
 * output until the user scrolls, overscroll:"chain" lets wheel input past
 * the edges fall through — and docks the dockEntries components below it;
 * the transcript absorbs the spare height via grow:1.
 */
export function buildFullscreenLayout(parts: TuiParts): FullscreenLayout {
  const transcriptScrollView = new ScrollView(parts.chatContainer, {
    follow: "end",
    primary: true,
    overscroll: "chain",
  });
  const layoutRoot = new VStack([
    {
      component: transcriptScrollView,
      basis: 0,
      grow: 1,
      shrink: 1,
      minSize: 1,
    },
    {
      component: new VStack(dockEntries(parts)),
      basis: "auto",
      grow: 0,
      shrink: 1,
      minSize: 1,
    },
  ]);
  return { layoutRoot, transcriptScrollView };
}

/**
 * Mount the parts on the renderer — the one place that knows the two
 * rendering shapes. A viewport renderer gets the explicit layout root;
 * regular mode gets the flat document (transcript, then the dock components
 * in the same dockEntries order). Either/or, unlike pi's mount, which does
 * both unconditionally because its runtime mode switching moves the same
 * components between renderers; without that (a recorded non-goal), the
 * unused mount would just be a second copy of the layout to keep in sync.
 */
export function mountParts(ui: TUI, parts: TuiParts): void {
  if (isViewportTUI(ui)) {
    ui.setLayoutRoot(buildFullscreenLayout(parts).layoutRoot);
    return;
  }
  // Regular mode is where an over-wide line crashes the screen (fit-width.ts).
  ui.addChild(new FitWidth(parts.chatContainer));
  for (const { component } of dockEntries(parts)) {
    ui.addChild(new FitWidth(component));
  }
}
