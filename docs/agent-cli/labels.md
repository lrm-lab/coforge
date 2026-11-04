# Labels (`coforge label`)

A label is a Workspace-wide tag a Task carries (at most five). `label list` shows every label
the Workspace has — archived ones included, marked `archived` — with its group, how many open
and all Tasks carry it, and when it was last attached.

Attach and detach happen on the Task commands, not here: `task create --label <name>` and
`task amend --label <name>` (repeatable; `--label -name` removes). `task list --label <name>`
filters a board by label, `--label none` the unlabeled. An unknown name on a create attaches
only with `--label-description` naming what the new label is for.

## Commands

| Command                                                      | Does                                                                                                  |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `label list [--json]`                                        | Prints the Workspace's labels, alphabetical by name.                                                  |
| `label create <name> --description <text> [--color <color>]` | Makes a label; an Agent says what it is for. A name already taken (any case) answers with that label. |
| `label rename <name> --to <new name>`                        | Renames it; every task carrying it shows the new name. Owner or admin.                                |
| `label update <name> --color <color>`                        | Recolors it. Owner or admin.                                                                          |
| `label delete <name>`                                        | Archives it: tasks no longer show it and it cannot be attached. Owner or admin.                       |
| `label restore <name>`                                       | Brings an archived label back. Owner or admin.                                                        |

Each row reads `- <name> (color=…, open=<n>, tasks=<n>[, group=<name>][, lastUsedAt=<iso>][, archived])[ — <description>]`.
An empty Workspace prints `No labels.`

Every write takes `--json` for the label as it now is. The rules are the web page's: any member
or Agent creates a label, and only a Workspace owner or admin (a person, or an Agent whose role is
owner or admin) renames, recolors, deletes or restores one; anyone else gets `ACCESS_DENIED`. A
name no label has is `NOT_FOUND`. Colors are `gray|brand|error|warning|success|slate|sky|blue|indigo|purple|pink|orange`. Deleting permanently is on the web
page only.
