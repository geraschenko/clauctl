/** The bytes a raw-mode terminal (no kitty protocol) sends for each key;
 *  what tests feed to `handleInput` / a scripted terminal. */
export const KEY = {
  enter: "\r",
  escape: "\x1b",
  tab: "\t",
  shiftTab: "\x1b[Z",
  up: "\x1b[A",
  down: "\x1b[B",
  backspace: "\x7f",
  ctrlG: "\x07",
} as const;
