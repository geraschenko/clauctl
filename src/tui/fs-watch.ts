// Ported from pi coding-agent src/utils/fs-watch.ts @ 0.80.10
//
// Differences from the pi original, kept minimal for mirror-diffing
// (see scripts/update-ports.sh for the update procedure): none.

import { type FSWatcher, type WatchListener, watch } from "node:fs";

export const FS_WATCH_RETRY_DELAY_MS = 5000;

export function closeWatcher(watcher: FSWatcher | null | undefined): void {
  if (!watcher) {
    return;
  }

  try {
    watcher.close();
  } catch {
    // Ignore watcher close errors
  }
}

export function watchWithErrorHandler(
  path: string,
  listener: WatchListener<string>,
  onError: () => void,
): FSWatcher | null {
  try {
    const watcher = watch(path, listener);
    watcher.on("error", onError);
    return watcher;
  } catch {
    onError();
    return null;
  }
}
