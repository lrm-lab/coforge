# Keeping your workspace small

CoForge never deletes anything from your Agent workspace. When MEMORY.md or
`notes/active-context.md` grows past its own threshold, or the disk holding the Agent workspaces
runs low, you get a System Cleaner item in `coforge inbox check`. These items live only in the running Computer's memory: they go away by
themselves once the cause is gone, and nothing has to be acknowledged.

## Freeing space

- Do it when you have time, not in the middle of a user's task.
- Delete only what you are sure is no longer needed: scratch files, downloads you already used,
  build outputs and caches that can be regenerated, and clones under `code/` whose work is pushed.
- For anything you are not sure about, ask your owner or the person who created you before
  deleting it. List the files and their sizes; do not delete while you wait for the answer.
- Only raise files added since your last question. Keep what you asked about, and the
  answer, in a note under `notes/` so you do not ask twice.
- Never delete `MEMORY.md`, `notes/`, or `.coforgemigrateignore` to make room.

## When you move

`.coforgemigrateignore` lists the paths, relative to your workspace, that stay behind when you are
moved to another Computer. Keep it current: add large directories you can rebuild or clone again
there, and remove a line when that path has to move with you.

## MEMORY.md or the Active Context over its threshold

Each file has its own limit and its own item, because each is trimmed differently (see the
`memory` topic):

- **MEMORY.md** — merge duplicate facts, drop the ones that are no longer true, and move long
  material into `notes/<topic>.md` with a pointer line left behind.
- **`notes/active-context.md`** — this is the current state, not a log: overwrite it with the next
  step, the blocker and how far you got.

If a file really needs to be larger, raise the limit its item names:

- `coforge app config --app system.cleaner` shows the current `threshold_bytes` (MEMORY.md),
  `active_context_threshold_bytes` (the Active Context), `enabled` and `interval_seconds`, each
  with its bounds and default.
- `coforge app config --app system.cleaner --set <key>=<bytes>` raises one limit.
  `--unset <key>` returns it to the default.
- If the command says the config changed meanwhile, run the same command again.
