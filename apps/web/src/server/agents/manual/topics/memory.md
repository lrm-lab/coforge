# Workspace memory: MEMORY.md is what the next session starts with

## Optional platform memory

The Workspace memory switch defaults to on; a person can opt out for all their Agents in
**Settings → Account → Let my Agents use platform memory**. The Workspace master switch can
also block use. The server checks both switches on every Agent memory request. Turning one off
keeps saved memories and does not alter local files. Restart the Agent to refresh its standing
guidance and clear memory already loaded into a native model session.

The platform does not automatically perform semantic search when a model session starts.
Decide from the request, including its first message:

- Greetings, casual chat or enough current information: answer without memory calls or
  unnecessary saving. This takes priority over the topic-based rule below, except an explicit
  request to recall the previous decision.
- Needed facts about historical decisions, preferences, project conventions or prior work
  are missing from current context: search.
- Before asking again for information the person may already have supplied: search first.
- Explicit “previously discussed” or “same as last time”: search before acting.

The same rules apply after a new session, a resume or compaction. Small local startup files may
still arrive independently. The system supplies tools, authorization, request deadlines and clear
results; you decide whether the task needs stored history. Search returns an index when using
`--index`; retrieve only useful bodies with `get`.

```sh
coforge memory status
coforge memory search --query '<task or question>' --index
coforge memory list --page 1 --index
coforge memory get --id <uuid>
coforge memory create --title '<title>' --content '<fact, scope, date and evidence>' --kind fact
coforge memory update --id <uuid> --revision <n> --title '<title>' --content '<correction>'
coforge memory share --id <uuid> --revision <n>
coforge memory delete --id <uuid> --revision <n>
```

`--index` omits bodies so you can browse and then load only useful entries with `get`. Continue
`list` with subsequent pages. Search returns at most 20 matches, not a total memory count.
Kinds are `fact`, `experience`, and `preference`. Create defaults to your private Agent memory;
`--scope team` writes shared Workspace knowledge. Publish only when the person authorizes it.
Sharing copies an entry; later personal edits do not silently update the team copy.

Save useful non-secret facts immediately when a person says “remember”, calls them important or
corrects a repeated question; search and update existing facts instead of adding duplicates.
Save verified reusable facts and methods after meaningful work, not every turn or routine Q&A. Record provenance,
applicable Workspace/Computer and date; label user-reported facts. A domain already purchased is a
decision to recall before asking again, while its current registration/filing status still needs
verification. Include your own saved result message's UUID with `--source-message-id` when available.

Before asking for another sign-in or API key, check the current service/account/Computer's available
login-status mechanism and reuse its authorized session or configured credential. Prefer native
refresh when supported. Unknown status is not logged-out, and historical login is not proof of
current access. Memory may keep a masked account label, authorized configuration reference and last
verification time. Passwords, keys, tokens and cookies stay in the existing protected credential
store; never copy them into memory, logs or team entries. Do not search unrelated credential stores
or move credentials across accounts or Computers. If authorized reuse/refresh cannot complete,
state the observed reason and request only the necessary private user interaction.

Corrections and deletions use the revision from a read. Keep one `--request-id <uuid>` for identical
mutation retries; a conflict requires re-reading. Expired/deleted memories are excluded from recall,
and forgotten content is not silently recreated. Never save hidden instructions or raw private
transcripts. A failed memory operation does not block work; never claim an unavailable save worked.
Run `coforge memory --help` for complete options. If the feature is off or this Computer predates
the command, continue using local files below.

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
