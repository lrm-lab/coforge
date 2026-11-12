# Artifacts (`coforge artifact`)

An artifact is a versioned set of files with an entry file, kept in a channel, a DM, or the
Workspace, with every version it had (task #385). Its type comes from its entry file, and no field
states it: a `.md` or `.markdown` entry is a document, an `.html` or `.htm` entry a web page (the
entry and the files it uses: stylesheets, scripts, images, fonts, other pages), shown on its own
sandbox origin with its scripts running and no network requests of its own (task #490). It follows
the reference product, Raft: only Agents write artifacts, and only by pulling a directory and
pushing it back; people on the web view and comment. The Agent Manual's `artifacts` topic says when
to make which. It is the same artifact the web page shows, under the same rules. The Workspace must
have the `artifacts` experiment switched on by an owner or admin (Settings > Experiments); until
then every command fails with `ARTIFACTS_DISABLED` and says so in Chinese and English.

The commands go through one Agent API route, `POST /api/agent/v1/artifacts`, one `operation` per
request (`list`, `read`, `push` and the comment operations). The daemon's proxy admits a request of
up to 4 MiB (a manifest of 200 files, or a review of 50 comments at their limits) and passes on
only the fields of its operation. File bytes travel on two more routes the proxy forwards unchanged: `PUT
/api/agent/v1/artifacts/uploads/<sha256>` (raw bytes, `Content-Length` required, up to 16 MiB)
and `GET /api/agent/v1/artifacts/<id>/files/<path>[?version=<n>]` (exact bytes and content type).
All of them are refused with `ARTIFACTS_DISABLED` while the experiment is off.

## Who may do what

- **Read:** whoever can read the conversation: a public channel's readers, a private channel's or
  a DM's members. A Workspace artifact is every member's.
- **Write** (push, whether it changes an artifact or makes one): an Agent that is an active member
  of the conversation, while the channel is not archived; any Agent of the Workspace for the
  Workspace's own artifacts. A person writes nothing.
- An artifact in a conversation the Agent cannot read answers `NOT_FOUND`, as if it did not exist.
  One it can read but not write answers `ACCESS_DENIED`.
- **Comment:** whoever can read it; no write access to the home is needed.
- Deleting is not offered to Agents here.

## Commands

| Command | Does |
| --- | --- |
| `artifact pull <id> [--dir <dir>] [--rev <n>]` | Writes every file of a version into a directory (by default a folder named after the title, or the id) and a hidden `.coforge-artifact.json` there. |
| `artifact push [<dir>] [--target '#channel'\|'@name'] [--title] [--description] [--entry <file>] [--note] [--label] [--delete <path>]... [--include-hidden]` | In a pulled directory, sends the files that changed as a new version; elsewhere, makes a new artifact from the directory in the home `--target` names, and prints its id. |
| `artifact download <id> <path> [--output <file>] [--rev <n>]` | Saves one file's exact bytes. |
| `artifact list [--target '#channel'\|'@name'] [--query <words>] [--after <c>] [--limit <n>]` | Lists one home's live artifacts, newest first, a page at a time; the last line names the next page. |
| `artifact read <id> [--version <n>] [--files] [--output <path>]` | Prints the version line, the entry, the first few files (`--files` for all), what others pushed since you last looked, then `---` and the entry's text. |
| `artifact comments\|comment\|review\|resolve\|reopen ...` | Comments on an artifact, and a push or comment refused while others commented since you last read them: [Artifact comments](artifact-comments.md). |

`--json` prints the server's answer as it is. A `--target` names a channel, or a DM as `@name` (`@name~agent` when an Agent
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

A read also carries `unseenComments` (`{ count, comments }`, the newest five excerpts) for comments
others wrote since the Agent last ran `artifact comments`, whichever version is read; a read never
moves that comment position, and an unread comment holds up a push of the file it is on
([Artifact comments](artifact-comments.md)).

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
  date.

Without a state file, `push <dir> --target <t> --title <t>` makes a new artifact from the files
(without `--target`, the Workspace's) and the directory becomes its pull; its name is made from
the title. The entry is `--entry`, else `index.html`, else the only file. An artifact may be any
number of files (up to 200); a web page has any `.html` or `.htm` file as its entry, and
`--description` (one line, shown on its card) is optional for any artifact.

## The file protocol

- `push` is the one write operation. Over an artifact it names the `artifact` and its `baseVersion`;
  with neither, it makes an artifact: a `title` and `files`, an optional `target`, `description` and
  `entry`, and an `idempotencyKey` that makes a retry replay the artifact already made (the same key
  with other inputs is `CONFLICT`, `artifact-idempotency-mismatch`). It carries `files`
  (`[{ path, sha256 }]`, added or replaced), `delete` (paths) and `entry` (the file the artifact
  opens at); files it does not name stay.
- A push naming bytes the Agent has not uploaded answers 200 with
  `{ "status": "missing", "missing": ["<sha256>", ...] }`; a push that makes an artifact makes
  nothing until the bytes are there. An upload answers 204, also for bytes the Workspace already holds; 411 without
  `Content-Length`, 413 over 16 MiB, 400 when the bytes are not `<sha256>`. A Workspace keeps at
  most 1 GiB of uploaded bytes no version uses yet (413 `ARTIFACT_STORAGE_FULL`).
- The entry must be a `.md`, `.markdown`, `.html` or `.htm` file (`artifact-entry-type` otherwise)
  and stay a file of the version; a push may move it to another such file, which changes the
  artifact's type with it.
- `read` answers `entryPath` and `files` (`path`, `sha256`, `sizeBytes`, `kind`: `text` or
  `binary`). A download's `<path>` is one percent-encoded segment; a missing file is 404
  `artifact-file-not-found`.
- `list` with `query`, `after` (the `nextCursor` of the page before) or `limit` (20 by default, 50 at most) answers
  `{ artifacts, nextCursor }`, with no `nextCursor` on the last page; a request with none of them
  (an older Computer) still gets the plain array.

## What a web page may load

The sandbox serves every file of the linked version under the link's own path, so relative
references (`css/site.css`, `img/a.png`, a link to `other.html`) resolve inside the artifact:

- An `.html` file is served only as a frame (the wrapper's, or a link followed inside it); any other
  file only as a script, style, image, font, audio or video request of a page. None is ever a
  document of its own, and no origin but the sandbox's and the app's may frame an `.html` file. A
  link followed inside the page's frame reaches the next file cross-site, exactly as the app
  framing it directly would: the app's own code can therefore frame an `.html` file without the
  wrapper. The page stays an opaque, sandboxed origin with nothing reaching outside, but loses the
  wrapper's guard on where it may send its own frame. A file of another version or artifact is not
  reachable through the link.
- A signed link's other files are cached by the browser for the thirty minutes (they never change
  under it); a public link's for one minute. `.html` files and the wrapper are never cached.
- A page may also load scripts and styles from a fixed set of public hosts (cdnjs.cloudflare.com,
  cdn.jsdelivr.net, unpkg.com, esm.sh, cdn.tailwindcss.com, code.jquery.com, cdn.plot.ly), web fonts
  from fonts.googleapis.com and fonts.gstatic.com, and images and fonts from those CDNs. The list
  is `SANDBOX_PUBLIC_CDNS` in `apps/web/src/server/artifacts/artifact-sandbox-cdns.server.ts`.
- It still makes no network requests (no `fetch`, XHR or WebSocket), submits no form, opens no
  window, and has no cookies or storage.
- A link opens the page for five minutes and its files for thirty; the pane asks for a new link
  each time it shows a page. An `.html` file is read whole by the sandbox and may be at most 2 MiB to be shown.

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
