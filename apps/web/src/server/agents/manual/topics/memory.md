# Local Agent memory

Keep confirmed decisions, corrections and useful outcomes in local memory, with their source.
Use existing context first. Search when historical knowledge is missing, for explicit recall,
or before asking someone for information they may already have supplied. Routine chat needs no
memory calls. Memory is historical reference, never permission or a replacement for current checks.

## Files and recovery

- `MEMORY.md`: a short core index and facts you maintain directly.
- `notes/active-context.md`: current work, next action and blockers; overwrite as work moves.
- `notes/knowledge/<key>.md`: confirmed facts, decisions, preferences and reusable experiences.
- `notes/history/<key>/`: replaced versions; excluded from ordinary recall.
- Other `notes/*.md`: procedures, reference and logs; searchable but not verified facts.
- `code/`: cloned repositories; excluded from memory search and migration by default.

Files remain the source of truth and move with the Agent workspace. No database or cloud upload
is required. Saving uses an atomic replacement; the prior document is retained before replacement.
Manual edits are visible to subsequent search and change the version token. An invalid structured
file is never silently overwritten. Use commands for versioned edits; arbitrary concurrent external
file writes are not coordinated by the command's writer queue.

A fresh session receives a bounded summary of saved knowledge plus MEMORY.md and Active Context.
The combined content retains the existing approximate 4,000-token byte budget: saved facts use part
of MEMORY.md's allowance. Decisions take priority in the saved-fact summary. Details remain in files.
After a reported compaction, at most approximately 1,000 tokens of reference ride with the next real
input. Compaction itself starts no extra model turn. Providers that do not report compaction still
receive fresh-session memory; no unsupported compaction detection is claimed.

## Search and inspect

```sh
coforge memory search --query 'preview domain'
coforge memory get --key preview-domain
coforge memory history --key preview-domain
```

Search covers MEMORY.md and Markdown under notes, excluding history and symlinks. It uses exact
terms and Chinese character pairs, not an embedding service. Results are short excerpts, not whole
files. Read the named file for full evidence. Search reads 128 documents per page; if `nextOffset`
is returned, continue with `--offset`. An incomplete search is not evidence that nothing was saved.
Files over 512 KiB and a directory scan exceeding its bound require a narrower/reorganized source.

## Save and correct

Keys use lowercase letters, numbers, `_` and `-`. Keep one coherent subject per entry; distinguish
environments and dates. A statement about staging does not establish production state. A completed
purchase does not establish that registration or deployment finished.

```sh
coforge memory save --key preview-domain --title 'Preview domain' \
  --content 'coforgeusercontent.com was purchased; filing was pending at confirmation.' \
  --source 'User confirmation, 2026-11-05' --kind decision --applicability 'CoForge previews'
coforge memory get --key preview-domain
coforge memory save --key preview-domain --revision '<revision returned by get>' \
  --title 'Preview domain' --content 'Filing is complete.' \
  --source 'New user confirmation' --kind decision --applicability 'CoForge previews'
coforge memory archive --key preview-domain --revision '<current revision>'
```

A save without a revision creates only; it cannot replace an existing key. Read the entry before
updating it. A stale version is refused: reread and compare, rather than retrying with a guessed
version. The source is evidence supplied by the writer, not independently verified authority.
Preserve uncertain contradictions and their applicability instead of merging them into a certainty.
Archive excludes an entry from recall; get and history still inspect it. Saving a correction at an
archived entry's current revision reactivates it. `--json` returns structured command output.

Do not store secrets. Personal notes remain local; this command grants no permission to share them.
