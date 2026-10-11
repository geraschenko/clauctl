import {
  type Component,
  Container,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { theme, type ThemeColor } from "../theme.ts";

/** A transcript notice; dim unless `color` says otherwise. */
export interface Banner {
  text: string;
  color?: ThemeColor;
}

/** The component that shows `banner`: like every transcript block it leads
 *  with its own blank line and trails with none, so consecutive blocks sit
 *  one blank line apart. */
export function bannerComponent({ text, color = "dim" }: Banner): Component {
  const container = new Container();
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg(color, text), 1, 0));
  return container;
}
