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
      return await ProtocolClient.connect(socketPath);
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
