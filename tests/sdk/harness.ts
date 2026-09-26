// Scratch-config plumbing shared by the sdk tests (tests/sdk/*.test.ts)
// and the derisk probes (docs/derisk/*/harness.mjs re-exports it).
//
// SECURITY: never writes to the real ~/.claude. Every session runs with
// env = baseEnv(...), which points CLAUDE_CONFIG_DIR at a scratch dir seeded
// with a mode-0600 COPY of ~/.claude/.credentials.json. The copied access
// token stays valid for hours and scratch CLIs don't refresh before expiry,
// so the real session's refresh-token family is not rotated. Onboarding
// state is the real ~/.claude.json with its project list cleared. Uses the
// SDK-bundled `claude` binary.
//
// TELEMETRY: probes deliberately put sessions into error-shaped states
// (crashes between tool call and result, malformed boundary playlists), which
// would otherwise stream telemetry and error reports that look like organic
// failures. Essential-traffic mode suppresses both (DISABLE_TELEMETRY alone
// leaves error reporting on). Set here at module scope so it covers every
// probe path: spawned CLIs inherit it via baseEnv's process.env spread, and
// in-process SDK calls read process.env directly.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// See TELEMETRY note above; docs/derisk/AGENTS.md states the policy.
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

export const REPO_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
// Derisk probes reference case dirs under this root as string literals.
const SCRATCH_ROOT = "/tmp/clauctl-cbi-derisk";
const CRED_SOURCE = `${process.env.HOME}/.claude/.credentials.json`;
const CLAUDE_JSON_SOURCE = `${process.env.HOME}/.claude.json`;

// Live checks must exercise the SDK clauctl ships: the installed package has
// to equal package.json's exact pin (README Hygiene). Derisk reports record
// which version produced them; check-reports.mjs version-conditions the
// assertions that carry known drift.
export function assertVersions(): { sdk: string } {
  const pinned: string = JSON.parse(
    fs.readFileSync(path.join(REPO_DIR, "package.json"), "utf8"),
  ).dependencies["@anthropic-ai/claude-agent-sdk"];
  const installed: string = JSON.parse(
    fs.readFileSync(
      path.join(
        REPO_DIR,
        "node_modules/@anthropic-ai/claude-agent-sdk/package.json",
      ),
      "utf8",
    ),
  ).version;
  if (installed !== pinned) {
    throw new Error(
      `installed SDK ${installed} != package.json pin ${pinned} — run npm ci`,
    );
  }
  return { sdk: installed };
}

/** How the scratch dir's credentials relate to the real ones: `"copy"`
 *  keeps the real expiry (and refuses near expiry, see SECURITY);
 *  `"never-expiring"` stamps `expiresAt` far ahead so the CLI never
 *  attempts a refresh — for runs whose requests never reach the API. */
export type CredentialSeed = "copy" | "never-expiring";

// Fresh scratch CLAUDE_CONFIG_DIR seeded with auth. One per case. `settings`,
// when given, becomes the scratch dir's settings.json (the user tier).
export function makeConfigDir(
  caseName: string,
  settings?: Record<string, unknown>,
  credentials: CredentialSeed = "copy",
): string {
  const dir = `${SCRATCH_ROOT}/${caseName}`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const creds = JSON.parse(fs.readFileSync(CRED_SOURCE, "utf8"));
  const expiresAt: number = creds.claudeAiOauth?.expiresAt ?? 0;
  if (credentials === "never-expiring") {
    creds.claudeAiOauth = {
      ...creds.claudeAiOauth,
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
    };
  } else if (expiresAt - Date.now() < 15 * 60 * 1000) {
    throw new Error(
      `~/.claude access token expires at ${new Date(expiresAt).toISOString()} — ` +
        `refusing to run (a scratch-CLI refresh could rotate the real session's tokens)`,
    );
  }
  fs.writeFileSync(`${dir}/.credentials.json`, JSON.stringify(creds), {
    mode: 0o600,
  });
  // .claude.json carries onboarding state; without it the CLI may block on
  // first-run prompts. Projects are cleared so no real trust state leaks in.
  const cj = JSON.parse(fs.readFileSync(CLAUDE_JSON_SOURCE, "utf8"));
  fs.writeFileSync(
    `${dir}/.claude.json`,
    JSON.stringify({ ...cj, projects: {} }),
  );
  if (settings !== undefined) {
    fs.writeFileSync(`${dir}/settings.json`, JSON.stringify(settings));
  }
  return dir;
}

export function baseEnv(
  configDir: string,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return { ...process.env, CLAUDE_CONFIG_DIR: configDir, ...extra };
}
