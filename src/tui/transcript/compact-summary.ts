import {
  type Component,
  Container,
  Markdown,
  Spacer,
} from "@earendil-works/pi-tui";
import { formatTokens } from "../components/footer.ts";
import { getMarkdownTheme } from "../theme.ts";
import { bannerComponent } from "./banner.ts";

/** A compaction summary as claude 2.1.211 shows it: a dim "Compacted
 *  (ctrl+o to see full summary)" line while collapsed, the markdown-rendered
 *  summary when expanded. */
export class CompactSummaryComponent implements Component {
  private readonly collapsedView: Component;
  private readonly expandedView: Component;
  private expanded = false;

  constructor(text: string) {
    this.collapsedView = bannerComponent({
      text: "Compacted (ctrl+o to see full summary)",
    });
    const container = new Container();
    container.addChild(new Spacer(1));
    container.addChild(new Markdown(text, 2, 0, getMarkdownTheme()));
    this.expandedView = container;
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return (this.expanded ? this.expandedView : this.collapsedView).render(
      width,
    );
  }
}

/** "context compacted (156k → 12k tokens)". Unknown-typed so replayed
 *  entries' compactMetadata needs no narrowing at the call site; counts are
 *  omitted when the boundary does not carry them (clauctl-injected
 *  boundaries write only preTokens). */
export function compactBanner(preTokens: unknown, postTokens: unknown): string {
  if (typeof preTokens !== "number") {
    return "context compacted";
  }
  const pre = formatTokens(preTokens);
  return typeof postTokens === "number"
    ? `context compacted (${pre} → ${formatTokens(postTokens)} tokens)`
    : `context compacted (${pre} tokens)`;
}
