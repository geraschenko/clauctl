import { ProtocolClient } from "./protocol-client.ts";

/**
 * Connect, retrying while the socket does not exist yet or refuses connections
 * (daemon still starting, or a stale socket file). Backoff doubles from 50ms,
 * capped at 500ms; there is no event to await for "the daemon has bound its
 * socket", so bounded retry is the fallback.
 */
export async function connectWithRetry(
  socketPath: string,
  deadlineMs: number,
): Promise<ProtocolClient> {
  const deadline = Date.now() + deadlineMs;
  let delay = 50;
  while (true) {
    try {
      const client = await ProtocolClient.connect(socketPath);
      // CLI consumers all connect through here; the TUI connects directly
      // and banners the warning instead (stderr would land under its
      // alternate screen).
      if (client.versionWarning !== undefined) {
        process.stderr.write(`clauctl: warning: ${client.versionWarning}\n`);
      }
      return client;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryable = code === "ENOENT" || code === "ECONNREFUSED";
      if (!retryable || Date.now() + delay > deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 500);
    }
  }
}
