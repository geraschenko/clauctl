import { PLAIN_DENY_MESSAGE } from "../permission-dialog.ts";
import type {
  PermissionRequest,
  PermissionResolution,
} from "../../core/protocol/index.ts";

/** Transcript banner for a `permissionResolved`, so a TUI that did not
 *  answer still sees what happened (decided divergence: claude shows
 *  nothing beyond the tool result). None for AskUserQuestion, whose tool
 *  result already shows the answers or the decline. */
export function resolutionBanner(
  resolution: PermissionResolution,
  resolvedRequest: PermissionRequest | undefined,
): string | undefined {
  if (resolvedRequest?.toolName === "AskUserQuestion") return undefined;
  switch (resolution.behavior) {
    case "allow": {
      const updates = resolution.updatedPermissions?.length ?? 0;
      return updates === 0
        ? "permission allowed"
        : `permission allowed (+${updates} updates)`;
    }
    case "deny":
      return resolution.message === PLAIN_DENY_MESSAGE
        ? "permission denied"
        : `permission denied: ${resolution.message}`;
    case "cancelled":
      return "permission cancelled";
  }
}
