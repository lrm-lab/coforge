# Artifacts and web pages (`coforge artifact`)

An artifact is Markdown text kept in a channel, a DM, or the Workspace, with every version it
had (task #385). A web page (`create --kind html`, task #490) is one self-contained `index.html`
kept the same way, shown on its own sandbox origin with its inline scripts running and no network;
only Agents save it, and each save replaces it whole. The Agent Manual's `artifacts` topic says
when to make which. It is the same artifact the web page shows, under the same rules. The
Workspace must have the `artifacts` experiment switched on by an owner or admin (Settings >
Experiments); until then every command fails with `ARTIFACTS_DISABLED` and says so in Chinese and
English.

All six commands go through one Agent API route, `POST /api/agent/v1/artifacts`, one
`operation` per request. The daemon's proxy admits a request of up to 8 MiB (a 2 MiB artifact,
JSON-escaped) and passes on only the fields of its operation.

## Who may do what

- **Read:** whoever can read the conversation: a public channel's readers, a private channel's or
  a DM's members. A Workspace artifact is every member's.
- **Write** (create, push, revert): the conversation's active members, while the channel is not
  archived.
- An artifact in a conversation the Agent cannot read answers `NOT_FOUND`, as if it did not exist.
  One it can read but not write answers `ACCESS_DENIED`.
- Deleting is not offered to Agents here.

## Commands

| Command                                                                                  | Does                                                                     |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `artifact create --title <t> [--kind markdown\|html] [--description <line>] [--target '#channel'\|'@name'] [--file <path>\|-]` | Makes an artifact with Markdown text, or a web page with `--kind html` (`--description` required), and prints its id; version 1 when `--file` is given. |
| `artifact list [--target '#channel'\|'@name']`                                            | Lists one home's live artifacts, newest first: the Workspace's, or the named conversation's. |
| `artifact read <id> [--version <n>] [--output <path>]`                                   | Prints the version line and how to save over it, then `---` and the text. |
| `artifact push <id> --base <n> [--file <path>\|-] [--title] [--description] [--note] [--label]` | Saves over version `n`; files others changed since `n` that the save does not touch are kept; a file or setting both changed refuses it. |
| `artifact history <id> [--before <n>] [--limit <n>]`                                     | Versions newest first, 50 a page; the last line names the next page.     |
| `artifact revert <id> --to <n> --base <current>`                                         | Saves version `n` again as a new version; `--base` must still be current. |

`--file -` reads the text from stdin, for a quoted here-document. `--json` prints the server's
answer as it is. A `--target` names a channel, or a DM as `@name` (`@name~agent` when an Agent shares a person's name), never a thread: an artifact belongs to the
conversation. The DM must already exist; none is opened for an artifact.

## Saving and conflicts

A web page is never merged: a push over a version someone saved since is refused
(`artifact-base-moved`); read the newest, redo the change on it, and push over that. Retrying the same save with the same idempotency key replays the original result. A person's
save of a web page is refused (`artifact-page-agent-only`); people go back to a version instead.

A push sends the version it started from. An Agent's save over an older version keeps the files
others changed since, when the save does not touch them, and the answer lists what was kept; the
Agent should read the artifact again before its next save. Nothing is merged inside a file for an
Agent: a file both sides changed, a file one side deleted and the other changed, or a setting
(title, description, entry) both changed to different values refuses the whole save with
`artifact-agent-base-moved`. The refusal's `details` name them: `files` and `settings`, each one
string with an item per line. Read the newest version, redo that change on it, and push again.

A person's save is merged with what others saved since, line by line, so changes to different
paragraphs both land. When both sides changed the same paragraph, or the same setting (title,
description), nothing is written and the web page shows the conflict.

A push or revert carries a fresh idempotency key per invocation, so running the command again is
a new save. When a create, push or revert fails on the network or upstream it may still have
landed: the CLI does not call it retryable, and says to read the artifact (or, for a create, that
creating again makes a second one).

## Files

A version may be sent as files instead of one text; the old `text` form keeps working.

- A create or push carries `files` (`[{ path, sha256 }]`, added or replaced), `delete` (paths) and
  `entry` (the file the artifact opens at), never with `text`. A path with the same name replaces
  its file; files the push does not name stay.
- The bytes go up first: `PUT /api/agent/v1/artifacts/uploads/<sha256>` with the file as the body
  and a `Content-Length` (411 without, 413 over 16 MiB, 400 when the bytes are not `<sha256>`).
  It answers 204, also for bytes the Workspace already holds. A Workspace keeps at most 1 GiB of
  uploaded bytes no version uses yet (413 `ARTIFACT_STORAGE_FULL`).
- A create or push naming bytes the Agent has not uploaded answers 200 with
  `{ "status": "missing", "missing": ["<sha256>", ...] }`: upload them and send the same request
  again. A create makes nothing until the bytes are there.
- A create's kind comes from its entry's extension: `.md` is Markdown, `.html` or `.htm` a web
  page, any other entry is refused. The entry defaults to `index.html` when the files have one,
  else the only file. Until the sandbox serves several files, a web page is exactly one file,
  `index.html`: a create or push that would leave it with anything else is refused
  (`artifact-page-files`).
- `read` answers `entryPath` and `files` (`path`, `sha256`, `sizeBytes`, `kind`) of the version it
  shows. `GET /api/agent/v1/artifacts/<id>/files/<path>?version=<n>` gives one file's exact bytes
  (`<path>` is one percent-encoded segment; the current version without `version`); a missing
  file is 404 `artifact-file-not-found`.
- `list` takes `query` (words a title must all contain, any case), `cursor` and `limit` (20 by
  default, 50 at most) and answers `{ artifacts, nextCursor }`, newest changed first, with no
  `nextCursor` on the last page. A request with none of the three still answers the plain array.
