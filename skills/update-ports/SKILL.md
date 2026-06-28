---
name: update-ports
description: Update the files in src/tui/components/ that are ported from pi coding-agent to track a newer pi release tag.
disable-model-invocation: true
---

## Fixed facts

- The pi repo lives at `~/git/earendil-works/pi` (override with `PI_REPO=<path>`).
- The ported files and their upstream counterparts are listed in
  `scripts/update-ports.sh` (`PORTS`); each port's header comment records the
  pi version it tracks (`@ <version>`) and the intentional differences from
  upstream.
- Ported files keep this repo's formatting; the script formats both upstream
  snapshots with our prettier before diffing so formatting noise cancels out.

## Procedure

1. Read the `@ <version>` pin in the ported files' headers; the old tag is
   that version with a leading `v` (e.g. `0.80.2-fork.2` → `v0.80.2-fork.2`).
   Confirm both tags exist: `git -C "$PI_REPO" tag | grep <version>`.
2. Run `scripts/update-ports.sh <old-tag> <new-tag>`. It applies the
   upstream old→new diff to each port and bumps the header pins.
3. If a port reports conflicts, resolve its `.rej` hunks by hand. Keep the
   intentional differences listed in the file's header (render-types instead
   of pi-ai, theme from `../theme.ts`, and for `tool-execution.ts` only the
   generic-fallback rendering path). If a hunk touches upstream functionality
   we deliberately did not port, drop it; if it adds new functionality,
   stop and ask the user whether to port it.
4. If upstream changed a component's inputs (new pi-ai fields, new theme
   keys), mirror the shape in `src/tui/render-types.ts` / `src/tui/theme.ts`
   and update the converter in `src/tui/sdk-render.ts`.
5. Update the header's intentional-differences list if it changed, run
   treefmt and the presubmit, and note the migration in
   `docs/specs/tui.md`'s WORK LOG.
