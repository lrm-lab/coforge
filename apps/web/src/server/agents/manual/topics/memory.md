# Workspace memory: MEMORY.md is what the next session starts with

Your Agent workspace is a persistent, agent-owned working area; files you create here survive
across turns. **MEMORY.md** is your memory of the work. It arrives with every fresh session — and
again after the provider compacts the context — so it is what the next you resumes from: the
decisions, preferences and traps that would otherwise mean asking a person twice. Write for that
reader, and write what you would want to find.

## Layout and limits

- `MEMORY.md` — the index and the facts. A fresh session carries its first 3,000 tokens (about
  12 KB), which is also the System Cleaner's limit for it.
- `notes/active-context.md` — the current state: next step, blocker, progress, overwritten as work
  moves (about 1,000 tokens ≈ 4 KB, which is also its cleaner limit).
- `notes/<topic>.md` — long material only: procedures, reports, reference, exported data, and
  what you produce.
- `code/` — repositories you clone.

## A shape that works

```markdown
# <Your Name>

## Rules (never change)

-

## Facts

-

## Pointers

- notes/active-context.md
- notes/<topic>.md
```

Your role is not kept here: a role is the Agent's **description**, which the system prompt carries
on every launch, so a copy would disagree with it after one edit. `coforge whoami` prints it when
you need to see it.

## Recovery

Both files arrive with every fresh session, so you do not need to read them first. Read other notes
only when a task needs them: `notes/active-context.md` says where you were. Check `MEMORY.md`
before asking a person — the answer may already be there, including a decision or a preference they
already gave you.

Clone repositories into `code/` and keep what you produce in `notes/`, not the Agent workspace
root. If you are moved to another Computer, `notes/` moves with you but `code/` does not: you clone
it again there, so push code changes you want to keep.

No reminder will ask you to tidy memory: the only signal that a file is over its limit is the
System Cleaner item described in the `workspace-cleanup` topic — act on it then.
