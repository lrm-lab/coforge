# Labels (`coforge label`)

A label is a Workspace-wide tag a Task carries (at most five). `label list` shows every label
the Workspace has — archived ones included, marked `archived` — with its group, how many open
and all Tasks carry it, and when it was last attached.

Attach and detach happen on the Task commands, not here: `task create --label <name>` and
`task amend --label <name>` (repeatable; `--label -name` removes). `task list --label <name>`
filters a board by label, `--label none` the unlabeled. An unknown name on a create attaches
only with `--label-description` naming what the new label is for.

## Commands

| Command                    | Does                                                              |
| -------------------------- | ----------------------------------------------------------------- |
| `label list [--json]`      | Prints the Workspace's labels, alphabetical by name.               |

Each row reads `- <name> (color=…, open=<n>, tasks=<n>[, group=<name>][, lastUsedAt=<iso>][, archived])[ — <description>]`.
An empty Workspace prints `No labels.`
