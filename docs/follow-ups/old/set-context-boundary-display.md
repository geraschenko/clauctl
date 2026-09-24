# Displaying set-context boundaries

When a compaction boundary was created by set-context with an explicit
playlist (as opposed to a rewind or an "effectively normal"
compaction), the display tree should show exactly what the assistant
sees. That means we somehow need to identify those boundaries. For
those cases, we should _not_ reparent the boundary (instead treat it
as having no parent?) and _do_ show the `@boundary` rows in its
playlist.

# Expansion: rewind-and-append

set-context should support `--rewind-to` combined with a uuid list:
rewind to the given message, then append the listed uuids to the end
of the conversation. Very common workflow: go off on a tangent,
produce a summary at the end of the tangent, then rewind — but keep
the summary. Mechanically this is already expressible as a plain
`--uuids` boundary whose playlist is [chain up to the rewind target]

- [the appended uuids]; the extension computes the rewind chain for
  the caller and captures the intent.

Phasing: first update set-context to support the combined form, then
work out `/tree` usage.

Display for these cases: the display tree should logically branch off
the `--rewind-to` point and then show _duplicated_ versions of the
entries in the uuid list. The algorithm probably has to look for a
prefix of the playlist which matches an initial segment in the
existing display tree, branch off the end of that initial segment,
and show the playlist remainder as duplicated (`@boundary`) rows.
