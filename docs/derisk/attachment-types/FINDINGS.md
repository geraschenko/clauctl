# Derisk: attachment entry types

Question: what `attachment.type`s does the CLI write to session files, and
what does each carry? Referenced from `docs/socket-interface.md` (the
file-only information list).

Method: `node docs/derisk/attachment-types/scan.mjs ~/.claude/projects docs tests`
— a read-only scan of every local session file (1160 files, 2026-07 through
2026-09-15, CLI versions up to 2.1.258) plus the repo's captured fixtures. No
probe was run; this is an inventory of what has been observed, not of what
the CLI can write. The scan prints, per type, the count, the union of
payload keys, and a sample.

## Findings

Every attachment entry observed has a `parentUuid` (it is a link in the
chain; `ContextTree` includes attachments because the CLI parents the next
turn on them) and none is `isMeta`. Only `queued_command` carries user
content that clauctl renders (`src/core/session/file.ts`); the TUI renders
nothing for every other type.

| type                        | count | payload keys                                                                                                                                  | what it is                                                                                                      |
| --------------------------- | ----: | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `todo_reminder`             | 11013 | `content`, `itemCount`                                                                                                                        | current todo list (often empty) re-shown to the model                                                           |
| `file`                      | 10519 | `filename`, `displayPath`, `content{type,file{filePath,content}}`                                                                             | a file the prompt `@`-included, whole contents                                                                  |
| `hook_success`              |  4116 | `hookName`, `hookEvent`, `toolUseID`, `command`, `stdout`, `stderr`, `exitCode`, `durationMs`, `content`                                      | a hook ran; its output                                                                                          |
| `task_reminder`             |  3614 | `content`, `itemCount`                                                                                                                        | current task list (the `Task*` tools' successor to todos)                                                       |
| `total_tokens_reminder`     |  3454 | `text`                                                                                                                                        | `<total_tokens>N tokens left</total_tokens>` budget reminder                                                    |
| `edited_text_file`          |  3293 | `filename`, `displayPath`, `snippet`                                                                                                          | a file changed outside the model's edits (IDE/user); numbered snippet                                           |
| `deferred_tools_delta`      |  3126 | `addedNames`, `addedLines`, `removedNames`, `readdedNames`, `pendingMcpServers`, `needsAuthMcpServers`, `failedMcpServers`, `wireHiddenNames` | change in the deferred (ToolSearch-loaded) tool set, incl. MCP server state                                     |
| `queued_command`            |  2468 | `prompt`, `commandMode`, `origin{kind}`, `timestamp`, `source_uuid`                                                                           | a queued prompt absorbed mid-turn (a steer); `source_uuid` = the stamped `SDKUserMessage.uuid` when one was set |
| `batching_reminder_sent`    |  2327 | `text`, `model`                                                                                                                               | "batch your tool calls" nudge                                                                                   |
| `compact_file_reference`    |  1926 | `filename`, `displayPath`                                                                                                                     | after compaction: a file that was in context, by name only                                                      |
| `skill_listing`             |   839 | `content`, `skillCount`, `isInitial`, `names`                                                                                                 | the available skills list (initial and on change)                                                               |
| `agent_listing_delta`       |   711 | `addedTypes`, `addedLines`, `removedTypes`, `isInitial`, `showConcurrencyNote`                                                                | change in the available subagent types                                                                          |
| `date_change`               |   631 | `newDate`                                                                                                                                     | the calendar date rolled over during the session                                                                |
| `nested_memory`             |   332 | `path`, `displayPath`, `content{path,type,content}`                                                                                           | a nested `CLAUDE.md` loaded when the model first touched its directory                                          |
| `invoked_skills`            |   320 | `skills[{name,path,content}]`                                                                                                                 | full text of skills invoked this turn                                                                           |
| `command_permissions`       |   265 | `allowedTools`                                                                                                                                | the tool allow-list in force (often empty)                                                                      |
| `silent_turn_reminder`      |   245 | `text`                                                                                                                                        | "the user hasn't heard from you in a while" nudge                                                               |
| `bash_output_audience_note` |   121 | `toolUseID`                                                                                                                                   | note attached to a Bash result about who sees the output                                                        |
| `auto_mode`                 |   111 | `autoModeConsentFlow`, `bashFirst`, `steerOnly`, `bypass`                                                                                     | auto permission mode entered; its flags                                                                         |
| `plan_mode_exit`            |    43 | `planFilePath`, `planExists`                                                                                                                  | plan mode left                                                                                                  |
| `directory`                 |    11 | `path`, `displayPath`, `content`                                                                                                              | a directory the prompt `@`-included, as a listing                                                               |
| `read_truncation_notice`    |    10 | `banner`, `toolUseID`                                                                                                                         | a Read result was cut at the token cap; how to page                                                             |
| `already_read_file`         |     6 | `filename`, `displayPath`, `content`                                                                                                          | `@`-included file the model had already read                                                                    |
| `plan_mode`                 |     6 | `reminderType`, `isSubAgent`, `planFilePath`, `planExists`                                                                                    | plan mode entered / reminder                                                                                    |
| `hook_additional_context`   |     5 | `content[]`, `hookName`, `hookEvent`, `toolUseID`                                                                                             | context a hook injected (e.g. `<ide_diagnostics>`)                                                              |
| `auto_mode_exit`            |     1 | —                                                                                                                                             | auto mode left                                                                                                  |
| `workflow_keyword_request`  |     1 | —                                                                                                                                             | unknown; single occurrence                                                                                      |

The "what it is" column is read off the payloads and the surrounding
entries; the CLI's rendering of each into the API request (the
`<system-reminder>` text the model sees) was not captured and is not in the
file — only the structured payload is.

## Consequences

- The inventory is open-ended: the CLI adds types with releases (the
  `task_*`, skill and agent listings are recent). Code must treat
  `attachment.type` as an open string and render nothing for unknown types,
  which it does.
- The only type with user-visible content is `queued_command`; the rest
  are harness state the model sees and the user does not, which is why
  the display tree hides them and the context tree keeps them.
