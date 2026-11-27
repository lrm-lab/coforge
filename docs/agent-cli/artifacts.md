# Artifacts (`coforge artifact`)

An artifact is a versioned set of files with an entry file, kept in a channel or a DM, or
widened to the whole Workspace, with every version it had (task #385). Its type comes from its entry file, and no field
states it: `html`, `markdown`, `text`, `csv`, `image`, `pdf`, `video` or `other` (`entryKind`, in `read` and on a card). An
`.html` entry is a web page (the entry and the files it uses), shown on its own origin of its own with its scripts running and
no network requests but its own files and a few public hosts (task #490). It follows
the reference product, Raft: only Agents write artifacts, and only by pulling a directory and
pushing it back; people on the web view and comment. The Agent Manual's `artifacts` topic says when
to make which. It is the same artifact the web page shows, under the same rules.

The commands go through one Agent API route, `POST /api/agent/v1/artifacts`, one `operation` per
request (`list`, `read`, `push`, `move`, `delete`, `save`, the comment operations, `image`, `follow` and `unfollow`). The daemon's proxy admits a request of
up to 4 MiB (a manifest of 200 files, or a review of 50 comments at their limits) and passes on
only the fields of its operation. File bytes travel on two more routes the proxy forwards unchanged: `PUT
/api/agent/v1/artifacts/uploads/<sha256>` (raw bytes, `Content-Length` required, up to 16 MiB)
and `GET /api/agent/v1/artifacts/<id>/files/<path>[?version=<n>]` (exact bytes and content type).

## Who may do what

- **Read:** whoever can read the artifact's conversation: its active members, people and Agents
  (everyone in the Workspace for a public channel). Once it is moved to the Workspace, every
  member and Agent. An artifact the reader cannot see answers `NOT_FOUND`, as if it did not exist.
  When the conversation is hidden or deleted, only the author Agent, that Agent's owner and the
  Workspace's owners and admins still see it.
- **Push:** an Agent pushes to any artifact it can read, except while an artifact is pinned to an
  active channel — then only a channel admin of that channel or a Workspace owner/admin may push
  (`ACCESS_DENIED`, `channel-announcement-push-forbidden`). DM-pinned artifacts stay writable by DM
  participants. A push that makes one needs a
  `--target`, and the Agent must be an active member of that conversation, which must not be
  archived. A person writes nothing.
- **Move to the Workspace:** only the author Agent, and only while its owner can see the artifact
  and may widen it (`ACCESS_DENIED` with `details.reason` `owner-cannot-see`, `owner-cannot-move`
  or `no-owner` otherwise). An artifact already visible to the Workspace answers `CONFLICT`
  (`artifact-home-not-wider`). Only a person can take it back to its conversation, or turn on a
  public link.
- **Delete:** only the author Agent; deleting again answers `NOT_FOUND`.
- **Comment:** whoever can read it.

## Commands

| Command | Does |
| --- | --- |
| `artifact pull <id> [--dir <dir>] [--rev <n>]` | Writes every file of a version into a directory (by default a folder named after the title, or the id) and a hidden `.coforge-artifact.json` there. |
| `artifact push [<dir>] [--target '#channel'\|'@name'] [--title] [--description] [--entry <file>] [--note] [--label] [--delete <path>]... [--include-hidden] [--announcement]` | In a pulled directory, sends the files that changed as a new version; elsewhere, makes a new artifact from the directory in the home `--target` names, and prints its id. `--announcement` also pins the newly created artifact to that channel or DM (preflighting channel-admin authority before pushing). |
| `artifact download <id> <path> [--output <file>] [--rev <n>]` | Saves one file's exact bytes. `download <id> --image <image id>` saves a comment's image. |
| `artifact save <attachment-id>` | Makes an artifact from a message's attachment: [References, pushes and saves](artifact-references.md). |
| `artifact list [--target '#channel'\|'@name'] [--query <words>] [--after <c>] [--limit <n>]` | Lists one conversation's live artifacts (none named: every artifact you can see), newest first, a page at a time; the last line names the next page. |
| `artifact read <id> [--version <n>] [--files] [--output <path>]` | Prints the version line, the entry, the first few files (`--files` for all), what others pushed since you last looked, then `---` and the entry's text. |
| `artifact move <id> --to workspace` | Widens an artifact you made from its conversation to the whole Workspace, and prints who can now see it. `--to public` is refused: only a person turns on link sharing. |
| `artifact delete <id>` | Deletes an artifact you made. |
| `artifact comments\|comment\|review\|resolve\|reopen ...` | Comments on an artifact, and a push or comment held up by what others did since you last read: [Artifact comments](artifact-comments.md). |
| `artifact follow <id>`, `artifact unfollow <id>` | Whether you are told of what others do on the artifact; your own push, comment or review follows it for you: [Following and notices](artifact-follows.md). |

`--json` prints the server's answer as it is. A `--target` names a channel (`#channel`; `#channel:<thread>` homes it in that channel), or a DM as `@name` (`@name~agent` when an Agent
shares a person's name). A task reference such as `#channel:#7` is refused with the conversation to pass instead: an artifact belongs to the conversation. The DM must
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

A read of the current version also carries `unseenComments` and marks as seen the comments it
shows in full ([Artifact comments](artifact-comments.md#reading-comments)).

The position only moves forward. It moves on a read of the current version and on the Agent's own
push, a new artifact's first included (it has seen what it made); reading an older version moves nothing. People's reads
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
  date. A push that only changes the title answers `nothing` with `titleChanged`.

Without a state file, `push <dir> --target <t> --title <t>` makes a new artifact from the files
(`--target` is required: without it the push is refused with `artifact-target-required`) and the directory becomes its pull; its name is made from
the title. The entry is `--entry`, else `index.html`, else the only file. An artifact may be any
number of files (up to 200); any file may be the entry, and
`--description` (one line, shown on its card) is optional for any artifact.

## The file protocol

- `push` is the one write operation. Over an artifact it names the `artifact` and its `baseVersion`;
  with neither, it makes an artifact: a `title`, `files` and a required `target`, an optional `description` and
  `entry`, and an `idempotencyKey` that makes a retry replay the artifact already made (the same key
  with other inputs is `CONFLICT`, `artifact-idempotency-mismatch`). It carries `files`
  (`[{ path, sha256 }]`, added or replaced), `delete` (paths) and `entry` (the file the artifact
  opens at); files it does not name stay.
- A push naming bytes the Agent has not uploaded answers 200 with
  `{ "status": "missing", "missing": ["<sha256>", ...] }`; a push that makes an artifact makes
  nothing until the bytes are there. An upload answers 204, also for bytes the Workspace already holds; 411 without
  `Content-Length`, 413 over 16 MiB, 400 when the bytes are not `<sha256>`. A Workspace keeps at
  most 1 GiB of uploaded bytes no version uses yet (413 `ARTIFACT_STORAGE_FULL`).
- The entry may be any file and must stay a file of the version; a push may move it to another
  file, which changes the artifact's type with it. Only an `.html` or `.md` entry is read whole
  by the page, so only those are limited to 2 MiB.
- `read` answers `entryPath`, `entryKind` and `files` (`path`, `sha256`, `sizeBytes`, `kind`: `text` or
  `binary`). A download's `<path>` is one percent-encoded segment; a missing file is 404
  `artifact-file-not-found`.
- `list` with `query`, `after` (the `nextCursor` of the page before) or `limit` (20 by default, 50 at most) answers
  `{ artifacts, nextCursor }`, with no `nextCursor` on the last page; a request with none of them
  (an older Computer) still gets the plain array.

## Web pages, references and saves

What an `.html` entry may load is in [Artifact web pages](artifact-web-pages.md). Naming an
artifact by link or title, what a push answers, saving an attachment as an artifact and the write
limit are in [References, pushes and saves](artifact-references.md).

## Saving and conflicts

A push over an older version keeps what others changed in files it did not touch, and a setting
(title, description, entry) only one side changed. Nothing is merged inside a file: a file both
sides changed, a file one side deleted and the other changed, or a setting both changed to
different values refuses the whole push with `artifact-base-moved` (`BASE_MOVED` in Raft). Its
`details` name them: `files` and `settings`, each one string with an item per line, and the CLI
prints them. The same change on both sides is no clash. Pull the newest version (into a fresh
directory, to keep your edits beside it), redo the change, and push again. Retrying the same push
with the same idempotency key replays the original result.

A push carries a fresh idempotency key per invocation, so running the command again is a new push.
When a push fails on the network or upstream it may still have landed: the CLI does not call it
retryable, and says to read the artifact (or, for a push that made one, that pushing again makes a
second one). An upload or download only moves bytes named by their hash, so it is retryable.
