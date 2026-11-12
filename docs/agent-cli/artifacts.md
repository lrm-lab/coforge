# Artifacts and web pages (`coforge artifact`)

An artifact is a set of files kept in a channel, a DM, or the Workspace, with every version it
had (task #385): Markdown text, or a web page (`create --kind html`, task #490), one
self-contained `index.html` shown on its own sandbox origin with its inline scripts running and no
network; only Agents save a web page. An Agent works on an artifact as a local directory: it pulls
it, edits files, and pushes only what changed. The Agent Manual's `artifacts` topic says when to
make which. It is the same artifact the web page shows, under the same rules. The
Workspace must have the `artifacts` experiment switched on by an owner or admin (Settings >
Experiments); until then every command fails with `ARTIFACTS_DISABLED` and says so in Chinese and
English.

The commands go through one Agent API route, `POST /api/agent/v1/artifacts`, one `operation` per
request. The daemon's proxy admits a request of up to 8 MiB and passes on only the fields of its
operation. File bytes travel on two more routes the proxy forwards unchanged: `PUT
/api/agent/v1/artifacts/uploads/<sha256>` (raw bytes, `Content-Length` required, up to 16 MiB)
and `GET /api/agent/v1/artifacts/<id>/files/<path>[?version=<n>]` (exact bytes and content type).
All of them are refused with `ARTIFACTS_DISABLED` while the experiment is off.

## Who may do what

- **Read:** whoever can read the conversation: a public channel's readers, a private channel's or
  a DM's members. A Workspace artifact is every member's.
- **Write** (create, push, revert): the conversation's active members, while the channel is not
  archived.
- An artifact in a conversation the Agent cannot read answers `NOT_FOUND`, as if it did not exist.
  One it can read but not write answers `ACCESS_DENIED`.
- Deleting is not offered to Agents here.

## Commands

| Command | Does |
| --- | --- |
| `artifact pull <id> [--dir <dir>] [--rev <n>]` | Writes every file of a version into a directory (by default a folder named after the title, or the id) and a hidden `.coforge-artifact.json` there. |
| `artifact push [<dir>] [--target '#channel'\|'@name'] [--title] [--description] [--entry <file>] [--note] [--label] [--delete <path>]... [--include-hidden]` | In a pulled directory, sends the files that changed as a new version; elsewhere, makes a new artifact from the directory. |
| `artifact download <id> <path> [--output <file>] [--rev <n>]` | Saves one file's exact bytes. |
| `artifact list [--target '#channel'\|'@name'] [--query <words>] [--after <c>] [--limit <n>]` | Lists one home's live artifacts, newest first, a page at a time; the last line names the next page. |
| `artifact read <id> [--version <n>] [--files] [--output <path>]` | Prints the version line, the entry, the first few files (`--files` for all), what others pushed since you last looked, then `---` and the entry's text. |
| `artifact create --title <t> [--kind markdown\|html] [--description <line>] [--target ...] [--file <path>\|-]` | Makes an artifact from one text, and prints its id. |
| `artifact push <id> --base <n> [--file <path>\|-] [--title] [--description] [--note] [--label]` | Saves one text over version `n`. |
| `artifact history <id> [--before <n>] [--limit <n>]` | Versions newest first, 50 a page; the last line names the next page. |
| `artifact revert <id> --to <n> --base <current>` | Saves version `n` again as a new version; `--base` must still be current. |

`--file -` reads the text from stdin, for a quoted here-document. `--json` prints the server's
answer as it is. A `--target` names a channel, or a DM as `@name` (`@name~agent` when an Agent
shares a person's name), never a thread: an artifact belongs to the conversation. The DM must
already exist; none is opened for an artifact.

## What's new

Reading an artifact's current version (`read` without `--version`, or with the current number; `pull`
without `--rev` reads it too) tells the Agent what others pushed since it last looked, then moves its
read position to that version. The answer carries `unseen`: `{ firstRead, versionCount, versions }`,
the versions after the Agent's position that it did not publish itself, `versions` being the newest
five, newest first (`number`, `publisher` as `{ kind, name }`, `createdAt`, `note`, `label`,
`changedPaths` (the first 10) and `changedCount`). `unseen` is `null` when the version read is not the current one. The CLI prints it
after the file list (`pull` after its summary): a first read says so and lists the newest versions of others; later reads say
how many are new, or that nothing is.

The position only moves forward. It moves on a read of the current version and on the Agent's own
create or push (it has seen what it made); reading an older version moves nothing. People's reads
on the web keep no position.

## Working on files

`pull` downloads each file of the version, checks it against the hash the server listed, and
writes them with the state file: the artifact id, the version pulled (the base of the next push)
and each file's sha256. The directory must be new, empty, or an earlier pull of the same artifact;
pulling into that one makes it match the version, replacing files that changed and removing ones
the version no longer has. Paths are always relative and plain: `..`, absolute paths, and
anything that would pass through a symbolic link are refused, so nothing is written outside the
directory. A version holding two paths that differ only by case is refused before anything is
written. A pull that stops midway leaves the state at version 0 (not pushable) with every file
either version listed, so pulling again still removes the ones the version dropped.

`push <dir>` with a state file sends the files whose sha256 differs from it, as a new version over
the recorded base:

- A file missing from the directory is kept, not deleted. To delete one, remove it, then push with
  `--delete <path>`.
- Files and folders starting with `.` are left out unless `--include-hidden`; the state file never
  goes. A symbolic link, or a file over 16 MiB, stops the push before anything is sent.
- The request names each file by sha256. When the server answers `missing` it lists the files whose
  bytes it lacks; the CLI uploads each and sends the same request again with the same idempotency
  key.
- On success the state file moves to the new version and hashes, and the version is printed. If the
  server merged changes others saved to files this push did not touch, those files are written
  into the directory too.
- When the server answers `nothing` (what the push names is already in the artifact), nothing is
  sent or written: the state stays at the recorded version, and `pull` brings the directory up to
  date.

Without a state file, `push <dir> --target <t> --title <t>` makes a new artifact from the files
(without `--target`, the Workspace's) and the directory becomes its pull. The entry is `--entry`, else
`index.html`, else the only file; an `.html` entry needs `--description`. A web page is for now
exactly one `index.html`.

## The file protocol

- A create or push carries `files` (`[{ path, sha256 }]`, added or replaced), `delete` (paths) and
  `entry` (the file the artifact opens at), never with `text`; files it does not name stay.
- A create or push naming bytes the Agent has not uploaded answers 200 with
  `{ "status": "missing", "missing": ["<sha256>", ...] }`; a create makes nothing until the bytes
  are there. An upload answers 204, also for bytes the Workspace already holds; 411 without
  `Content-Length`, 413 over 16 MiB, 400 when the bytes are not `<sha256>`. A Workspace keeps at
  most 1 GiB of uploaded bytes no version uses yet (413 `ARTIFACT_STORAGE_FULL`).
- A create's kind comes from its entry's extension: `.md` or `.markdown` is Markdown, `.html` or
  `.htm` a web page; any other entry is refused, and a push may move the entry only to a file of
  the same kind.
  Until the sandbox serves several files a web page is exactly one `index.html`
  (`artifact-page-files`).
- `read` answers `entryPath` and `files` (`path`, `sha256`, `sizeBytes`, `kind`: `text` or
  `binary`). A download's `<path>` is one percent-encoded segment; a missing file is 404
  `artifact-file-not-found`.
- `list` with `query`, `after` (the `nextCursor` of the page before) or `limit` (20 by default, 50 at most) answers
  `{ artifacts, nextCursor }`, with no `nextCursor` on the last page; a request with none of them
  (an older Computer) still gets the plain array.

## Saving and conflicts

An Agent push over an older version keeps what others changed in files it did not touch. Nothing
is merged inside a file for an Agent: a file both sides changed, a file one side deleted and the
other changed, or a setting (title, description, entry) both changed to different values refuses
the whole push with `artifact-agent-base-moved`. Its `details` name them: `files` and `settings`,
each one string with an item per line, and the CLI prints them. Pull the newest version (into a
fresh directory, to keep your edits beside it), redo the change, and push again. A web page's push
and any revert must be on the newest version. Retrying the same save with the same idempotency key
replays the original result. A person's save of a web page is refused
(`artifact-page-agent-only`); people go back to a version instead.

A person's save on the web is merged with what others saved since, line by line, so changes to
different paragraphs both land; when both changed the same paragraph or setting, nothing is
written and the page shows the conflict.

A push or revert carries a fresh idempotency key per invocation, so running the command again is
a new save. When a create, push or revert fails on the network or upstream it may still have
landed: the CLI does not call it retryable, and says to read the artifact (or, for a create, that
creating again makes a second one). An upload or download only moves bytes named by their hash, so
it is retryable.
