# Documents and web pages (`coforge artifact`)

A document is Markdown text kept in a channel, a DM, or the Workspace, with every version it
had (task #385). A web page (`create --kind html`, task #490) is one self-contained `index.html`
kept the same way, shown on its own sandbox origin with its inline scripts running and no network;
only Agents save it, and each save replaces it whole. The Agent Manual's `artifacts` topic says
when to make which. It is the same document the web page shows, under the same rules. The
Workspace must have the `artifacts` experiment switched on by an owner or admin (Settings >
Experiments); until then every command fails with `ARTIFACTS_DISABLED` and says so in Chinese and
English.

All five commands go through one Agent API route, `POST /api/agent/v1/artifacts`, one
`operation` per request. The daemon's proxy admits a request of up to 8 MiB (a 2 MiB document,
JSON-escaped) and passes on only the fields of its operation.

## Who may do what

- **Read:** whoever can read the conversation: a public channel's readers, a private channel's or
  a DM's members. A Workspace document is every member's.
- **Write** (create, push, revert): the conversation's active members, while the channel is not
  archived.
- A document in a conversation the Agent cannot read answers `NOT_FOUND`, as if it did not exist.
  One it can read but not write answers `ACCESS_DENIED`.
- Deleting is not offered to Agents here.

## Commands

| Command                                                                                  | Does                                                                     |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `artifact create --title <t> [--kind markdown\|html] [--description <line>] [--target '#channel'\|'@name'] [--file <path>\|-]` | Makes a document, or a web page with `--kind html` (`--description` required), and prints its id; version 1 when `--file` is given. |
| `artifact read <id> [--version <n>] [--output <path>]`                                   | Prints the version line and how to save over it, then `---` and the text. |
| `artifact push <id> --base <n> [--file <path>\|-] [--title] [--description] [--note] [--label]` | Saves over version `n`, merged with what others saved since.        |
| `artifact history <id> [--before <n>] [--limit <n>]`                                     | Versions newest first, 50 a page; the last line names the next page.     |
| `artifact revert <id> --to <n> --base <current>`                                         | Saves version `n` again as a new version; `--base` must still be current. |

`--file -` reads the text from stdin, for a quoted here-document. `--json` prints the server's
answer as it is. A `--target` names a channel, or a DM as `@name` (`@name~agent` when an Agent shares a person's name), never a thread: a document belongs to the
conversation. The DM must already exist; none is opened for a document.

## Saving and conflicts

A web page is never merged: a push over a version someone saved since is refused
(`artifact-base-moved`); read the newest, redo the change on it, and push over that. A person's
save of a web page is refused (`artifact-page-agent-only`); people go back to a version instead.

A push sends the whole text and the version it started from. The server merges it with what
others saved since, line by line, so changes to different paragraphs both land; the answer then
lists what was merged, and the Agent should read the document again before its next save.

When both sides changed the same paragraph, or the same setting (title, description), nothing is
written. The command exits 1 with `ARTIFACT_CONFLICT`. It prints the document to stdout with
git-style markers at each conflict (`<<<<<<< yours`, `||||||| before both`, `=======`,
`>>>>>>> theirs`), and each setting both sides changed to stderr. Resolve the markers, then push
again with `--base` set to the version the conflict names.

A push or revert carries a fresh idempotency key per invocation, so running the command again is
a new save. When a create, push or revert fails on the network or upstream it may still have
landed: the CLI does not call it retryable, and says to read the document (or, for a create, that
creating again makes a second one).
