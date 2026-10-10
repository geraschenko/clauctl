/** The bytes a raw-mode terminal (no kitty protocol) sends for each key;
 *  what tests feed to `handleInput` / a scripted terminal. */
export const KEY = {
  enter: "\r",
  escape: "\x1b",
  tab: "\t",
  shiftTab: "\x1b[Z",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  backspace: "\x7f",
  ctrlC: "\x03",
  ctrlG: "\x07",
} as const;
