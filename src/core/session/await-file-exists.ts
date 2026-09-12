import { existsSync, watch } from "node:fs";
import { dirname } from "node:path";

/** Bound on waiting for an announced session's file to appear. */
export const SESSION_FILE_TIMEOUT_MS = 10_000;

/** Resolve once filePath exists, by watching its nearest existing ancestor
 *  directory (watch installed before the existence re-check, so a creation
 *  racing the setup is not missed). Bounded by the shared deadline. */
export async function awaitFileExists(
  filePath: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(filePath)) {
    let ancestor = dirname(filePath);
    while (!existsSync(ancestor)) {
      ancestor = dirname(ancestor);
    }
    await awaitDirectoryChange(ancestor, filePath, deadline);
  }
}

/** Resolve on any change in `dir` (the outer loop re-checks existence and
 *  re-descends); reject at the deadline. */
function awaitDirectoryChange(
  dir: string,
  filePath: string,
  deadline: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // settle only ever runs after the synchronous setup below: watch and
    // timer callbacks are asynchronous, and the trailing re-check is last.
    const settle = (error?: Error): void => {
      watcher.close();
      clearTimeout(timer);
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const watcher = watch(dir, () => settle());
    watcher.on("error", (error) => settle(error));
    const timer = setTimeout(
      () =>
        settle(
          new Error(
            `session file ${filePath} did not appear within the deadline`,
          ),
        ),
      Math.max(0, deadline - Date.now()),
    );
    // The watch is installed before this re-check, so a creation racing the
    // setup is not missed. Any progress — the file itself, or a deeper
    // ancestor than the one being watched — settles; the outer loop
    // re-derives where to look.
    let nearest = dirname(filePath);
    while (!existsSync(nearest)) {
      nearest = dirname(nearest);
    }
    if (nearest !== dir || existsSync(filePath)) {
      settle();
    }
  });
}
