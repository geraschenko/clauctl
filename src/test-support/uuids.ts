import type { UUID } from "node:crypto";

/** A readable test id: `00000000-0000-0000-0000-<n>`. */
export const uuidN = (n: number): UUID =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

/** The hub's event stamp for the message stamped `uuidN(n)`:
 *  `10000000-0000-0000-0000-<n>`, never a `uuidN`. */
export const stampN = (n: number): UUID =>
  `10000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
