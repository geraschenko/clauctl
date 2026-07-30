// DO NOT MODIFY — generated from pictl by scripts/sync-from-pictl.mjs.
// The canonical copy lives in pictl; edit it there and re-run the script.

/** Shared test helpers. */

/** A NodeJS.Process stand-in for runCliApp tests. */
export interface CapturedProcess {
  proc: NodeJS.Process;
  /** One element per write() call, in order. */
  stdoutChunks: readonly string[];
  stderrChunks: readonly string[];
  /** The chunks joined — what the user saw. */
  stdout: string;
  stderr: string;
}

export function fakeProcess(env: NodeJS.ProcessEnv = {}): CapturedProcess {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const proc = {
    env,
    stdout: {
      write: (chunk: string) => {
        stdoutChunks.push(chunk);
      },
    },
    stderr: {
      write: (chunk: string) => {
        stderrChunks.push(chunk);
      },
    },
    exitCode: undefined as number | undefined,
  };
  return {
    proc: proc as unknown as NodeJS.Process,
    stdoutChunks,
    stderrChunks,
    get stdout() {
      return stdoutChunks.join("");
    },
    get stderr() {
      return stderrChunks.join("");
    },
  };
}
