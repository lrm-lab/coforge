# Keeping your workspace small

CoForge never deletes anything from your Agent workspace. When MEMORY.md grows past its
threshold, or the disk holding the Agent workspaces runs low, you get a System Cleaner item in
`coforge inbox check`. These items live only in the running Computer's memory: they go away by
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

## MEMORY.md over its threshold

Keep MEMORY.md an index (see the `memory` topic): move details into `notes/` and delete what is
out of date. If MEMORY.md really needs to be larger, raise the threshold the item names:

- `coforge app config --app system.cleaner` shows the current `threshold_bytes` (and
  `enabled`, `interval_seconds`) with each one's bounds and default.
- `coforge app config --app system.cleaner --set threshold_bytes=<bytes>` raises it.
  `--unset threshold_bytes` returns it to the default.
- If the command says the config changed meanwhile, run the same command again.
