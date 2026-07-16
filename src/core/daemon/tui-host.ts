import { CURSOR_HOME, ERASE_SCREEN } from "../generated/ansi.ts";
import { PtyScreen } from "../generated/pty-screen.ts";
import { mainEntryPath } from "../main-entry-path.ts";

export const RAPID_EXIT_MS = 5_000;
export const MAX_CONSECUTIVE_RAPID_EXITS = 3;

/**
 * Fold one tui exit into the consecutive-rapid-exit count. A "rapid" exit is
 * one within RAPID_EXIT_MS of its spawn; a slow exit resets the count.
 * MAX_CONSECUTIVE_RAPID_EXITS rapid exits in a row mean the tui is broken —
 * the caller stops respawning instead of crash-looping.
 */
export function nextConsecutiveRapidExits(
  consecutiveRapidExits: number,
  spawnedAtMs: number,
  exitedAtMs: number,
): number {
  return exitedAtMs - spawnedAtMs < RAPID_EXIT_MS
    ? consecutiveRapidExits + 1
    : 0;
}

interface TuiHostOptions {
  sdkSocket: string;
  cwd: string;
  env: Record<string, string>;
  /** Wired to ttyServer.broadcastOutput. */
  onOutput: (data: string) => void;
  /** Called with a timestamp when respawning stops, and with undefined
   *  whenever a respawn is attempted (the failure is cleared at the attempt,
   *  not on survival — if the tui crash-loops again the field briefly flaps,
   *  which self-corrects within the rapid-exit window). */
  onFailedChanged: (failedAt: string | undefined) => void;
  log: (message: string) => void;
}

/**
 * Runs `clauctl _tui --managed` in a PtyScreen (generated/pty-screen.ts);
 * respawns on exit per the crash-loop policy above. Each (re)spawn is a fresh
 * PtyScreen; the last one is kept after exit so its screen — including crash
 * output — remains snapshotable while the tui is failed.
 */
export class TuiHost {
  private readonly opts: TuiHostOptions;
  private screen!: PtyScreen;
  private spawnedAtMs = 0;
  private consecutiveRapidExits = 0;
  private tuiExited = false;
  private failed = false;
  private shuttingDown = false;
  /** Last size applied via resize(), re-applied to every fresh PtyScreen:
   *  TtyServer only calls the resize hook when the min across attachers
   *  *changes*, so without this a respawned tui would stay at the pty
   *  default while the attachers keep their old geometry. */
  private lastSize: { cols: number; rows: number } | undefined;

  constructor(opts: TuiHostOptions) {
    this.opts = opts;
    this.spawnTui();
  }

  private spawnTui(): void {
    this.spawnedAtMs = Date.now();
    this.tuiExited = false;
    this.screen = new PtyScreen(
      process.execPath,
      [
        mainEntryPath(),
        "_tui",
        "--sdk-socket",
        this.opts.sdkSocket,
        "--managed",
      ],
      { cwd: this.opts.cwd, env: this.opts.env },
    );
    // Listener registration must stay synchronous with construction (no await
    // in between): PtyScreen holds a single listener slot per event, and pty
    // data arriving in an await gap would bypass the broadcast.
    this.screen.onData(this.opts.onOutput);
    this.screen.onExit((exitCode) => this.handleExit(exitCode));
    if (this.lastSize !== undefined) {
      this.screen.resize(this.lastSize.cols, this.lastSize.rows);
    }
  }

  private respawn(): void {
    this.failed = false;
    this.opts.onFailedChanged(undefined);
    // The fresh emulator starts blank; clearing the attachers' screens first
    // keeps them in lockstep with it.
    this.opts.onOutput(`${CURSOR_HOME}${ERASE_SCREEN}`);
    this.spawnTui();
  }

  private handleExit(exitCode: number): void {
    this.tuiExited = true;
    if (this.shuttingDown) {
      return;
    }
    this.opts.log(`tui exited with code ${exitCode}`);
    this.consecutiveRapidExits = nextConsecutiveRapidExits(
      this.consecutiveRapidExits,
      this.spawnedAtMs,
      Date.now(),
    );
    if (this.consecutiveRapidExits < MAX_CONSECUTIVE_RAPID_EXITS) {
      this.respawn();
    } else {
      this.failed = true;
      this.opts.log(
        `tui exited rapidly ${this.consecutiveRapidExits} times in a row; ` +
          `not respawning until the next attach`,
      );
      this.opts.onFailedChanged(new Date().toISOString());
    }
  }

  // write/resize are dropped after tui exit: the pty fd is gone, and the
  // frozen crash screen has nothing to receive them. serializeScreen stays
  // valid — PtyScreen's emulator survives process exit.
  write(data: string): void {
    if (!this.tuiExited) {
      this.screen.write(data);
    }
  }

  resize(cols: number, rows: number): void {
    this.lastSize = { cols, rows };
    if (!this.tuiExited) {
      this.screen.resize(cols, rows);
    }
  }

  serializeScreen(): Promise<string> {
    return this.screen.serializeScreen();
  }

  /** Wakes a failed host: resets the crash counter and respawns. No-op while
   *  the tui is running. */
  notifyAttach(): void {
    if (!this.failed || this.shuttingDown) {
      return;
    }
    this.consecutiveRapidExits = 0;
    this.respawn();
  }

  /** Stop respawning and SIGTERM the current pty (daemon shutdown). */
  shutdown(): void {
    this.shuttingDown = true;
    if (!this.tuiExited) {
      this.screen.kill("SIGTERM");
    }
  }
}
