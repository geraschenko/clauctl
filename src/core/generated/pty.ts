// DO NOT MODIFY — generated from pictl by scripts/sync-from-pictl.mjs.
// The canonical copy lives in pictl; edit it there and re-run the script.

/**
 * Thin wrapper over node-pty that repairs a packaging bug before the first
 * spawn: node-pty 1.1.0 publishes the macOS `spawn-helper` binary without the
 * execute bit (it ships -rw-r--r-- in the npm tarball), so the first
 * `pty.spawn` on macOS fails with EACCES when the helper is exec'd. The helper
 * exists only in the darwin prebuilds, so the fix is macOS-only.
 *
 * Upstream status (https://github.com/microsoft/node-pty/issues/850): fixed by
 * the merged PR https://github.com/microsoft/node-pty/pull/866, which chmods
 * the helper in the publish pipeline so the tarball ships it executable. The
 * fix is live on the `beta` dist-tag (1.2.0-beta.7+ verified -rwxr-xr-x) but
 * NOT on `latest`, which is still the broken 1.1.0 with no patch backport. Our
 * dependency range (^1.0.0) therefore resolves to the broken 1.1.0.
 *
 * Remove this file once a fixed node-pty reaches `latest` (1.2.0 stable) and we
 * pin `^1.2.0`. The beta is not a pin candidate: the 1.2.0 line also drops
 * winpty and is otherwise in flux. That same bump also adds Linux prebuilds, so
 * update the README to drop the build-toolchain requirement note at that point.
 */

import { chmodSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import pty, { type IPty, type IPtyForkOptions } from "node-pty";

let helperChecked = false;

function ensureSpawnHelperExecutable(): void {
  if (process.platform !== "darwin") return;
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("node-pty/package.json"));
  const helper = join(
    root,
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  );
  try {
    const mode = statSync(helper).mode;
    if ((mode & 0o111) === 0) chmodSync(helper, mode | 0o755);
  } catch {
    // No prebuilt helper here (e.g. built from source, where the build sets the
    // bit itself). If the helper is genuinely missing, node-pty surfaces a
    // clearer error at spawn time.
  }
}

export function spawnPty(
  file: string,
  args: string[],
  options: IPtyForkOptions,
): IPty {
  if (!helperChecked) {
    ensureSpawnHelperExecutable();
    helperChecked = true;
  }
  return pty.spawn(file, args, options);
}
