# Workspace memory: MEMORY.md holds the index and the facts

Your Agent workspace is a persistent, agent-owned working area; files you create here survive
across turns. **MEMORY.md** carries two things: a short index, and the durable facts themselves —
one fact per line. Only long material lives elsewhere, and only as a pointer.

## Layout

- `MEMORY.md` — the index and the facts; a fresh session carries its first 3,000 tokens (about
  12 KB), which is also the System Cleaner's limit for it
- `notes/active-context.md` — the current state: next step, blocker, progress (about 1,000 tokens
  ≈ 4 KB, which is also its cleaner limit; not a log)
- `notes/<topic>.md` — long material only: procedures, reports, reference, exported data
- `notes/` — also what you produce: reports, exported data, images
- `code/` — repositories you clone

## MEMORY.md template

```markdown
# <Your Name>

## Role

<your role definition, evolved over time>

## Rules (never change)

-

## Facts

- <one durable fact per line>

## Pointers

- notes/active-context.md
- notes/<topic>.md
```

## What belongs where

- **A fact** is one line: a decision a human made, a preference they stated, a project convention,
  an environment quirk, a pitfall you hit. Write it in `MEMORY.md` itself, not in a note behind a
  pointer.
- **Long material** — a procedure with many steps, a reference table, a report — goes in
  `notes/<topic>.md`, with one pointer line in `MEMORY.md` saying what it is for. Do not copy the
  material itself into `MEMORY.md`.
- **The current state** — what you are doing, the next step, what blocks you — goes in
  `notes/active-context.md`, overwritten as it changes. It is not a log and holds no task list.
- Do not put PIDs, numeric results, hashes, timestamps, or message ids in `MEMORY.md`.

## When to write

- When a human decides something or states a preference, edit the matching fact in `MEMORY.md` at
  that moment.
- When you hit a pitfall (a command that failed for a non-obvious reason, an environment quirk), add
  that fact.
- In the same edit, merge duplicates and drop facts that are no longer true; a fact that changed is
  rewritten in place, not appended.
- Overwrite `notes/active-context.md` when work starts, finishes or blocks.
- Check `MEMORY.md` before asking a human: the answer may already be there.
- No reminder will ask you to tidy memory. The only signal that a file is over its limit is the
  System Cleaner item described in the `workspace-cleanup` topic — act on it then.

## Recovery

Both files arrive with every fresh session (and again after the provider compacts the context), so
you do not need to read them first. Read other notes only when a specific task needs them:
`notes/active-context.md` says where you were.

Clone repositories into `code/` and keep what you produce in `notes/`, not the Agent workspace
root. If you are moved to another Computer, `notes/` moves with you but `code/` does not: you clone
it again there, so push code changes you want to keep.
