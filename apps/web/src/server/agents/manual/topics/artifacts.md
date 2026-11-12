# Artifacts (`coforge artifact`)

A conversation (a channel or a DM) or the Workspace keeps artifacts, each with every version it
had. An artifact is a set of files with an entry file, and the entry file gives its type. Whoever
can read the conversation reads it. The Workspace must have artifacts switched on (Settings >
Experiments); until then every command fails with `ARTIFACTS_DISABLED`.

## Which type to make

- **A document** (the entry is a `.md` file) is text to read: a plan, a report, notes, a spec.
- **A web page** (the entry is an `.html` file) is something to look at: a dashboard, several
  options side by side, an annotated diff, a timeline, a small interactive explainer.

Only Agents write an artifact, by pushing a directory of files. People view it and comment; to
change one they ask an Agent. When in doubt, make a document: anything that is mostly prose is one.

## Writing a web page

- A page is an entry `.html` file (`index.html` unless you name another with `--entry`) and, when
  it helps, files of its own: a stylesheet, scripts, images, fonts, other `.html` pages. Refer to
  them with relative paths (`css/site.css`, `img/chart.png`, `<a href="second.html">`); every file
  of the version is served beside the entry. An `.html` file is at most 2 MiB.
- Scripts and styles may also come from these public hosts, and nowhere else: cdnjs.cloudflare.com,
  cdn.jsdelivr.net, unpkg.com, esm.sh, cdn.tailwindcss.com, code.jquery.com and cdn.plot.ly; web
  fonts from fonts.googleapis.com (styles) and fonts.gstatic.com (font files); images and fonts
  from the same CDNs. Some readers cannot reach those hosts, so a page that must always work
  ships its libraries and fonts as its own files.
- Scripts run (tabs, toggles, sorting, drawing a chart on a `<canvas>`), but the page cannot make
  network requests: no `fetch`, XHR or WebSocket, no WebRTC, no form submission, no navigating
  away or pop-ups, no cookies or storage. Put the data in the page or in a file of its own and
  load it with a `<script>` or an `<img>`, not `fetch`.
- A page's link works for 30 minutes; reload the page to get a fresh one.
- It is shown as it is written in light and dark mode alike; give it its own background and text
  colours. `prefers-color-scheme` in your CSS is fine.
- `--description` is one line saying what it is, shown on its card in the conversation; give one.

```sh
mkdir funnel && cp index.html funnel/
coforge artifact push funnel --title 'Signup funnel, week 44' \
  --description 'Signups and activation by day, with a toggle per channel' --target '#growth'
```

## Working on files

Work on an artifact as a directory, and send only what you changed:

```sh
coforge artifact pull <id> --dir work     # every file of the newest version, plus a hidden state file
# edit files in work/
coforge artifact push work --note 'moved the date'
```

- `pull <id> [--dir <dir>] [--rev <n>]` needs a new, empty, or earlier-pulled directory (by default
  a folder named after the title). It writes `.coforge-artifact.json` there: leave it in place, it
  remembers the version you started from and each file's hash.
- `push [<dir>]` sends the files whose content differs from what was pulled, as a new version, and
  prints it. A file you removed is kept on the server; to delete one, remove it and add
  `--delete <path>`. Files starting with `.` stay out unless `--include-hidden`.
- Push in a directory with no state file makes a new artifact from it, and prints its id:
  `coforge artifact push dir --target '#channel' --title <t>` (`--description <line>` is its card
  line, `--entry <file>` picks the file it opens at, an `.md` or `.html` file; without `--target`
  it goes to the Workspace).
- `download <id> <path> [--output <file>] [--rev <n>]` saves one file's exact bytes.
- `read <id>` lists the version's files and entry (`--files` for all of them), prints the entry's
  text, and says what others pushed since you last looked (reading the newest version moves your
  place; an older `--version` does not); `list` takes `--query <words>`, and its last line names
  the next page when there is one.

If someone pushed since your pull, your push keeps what they changed in files you did not touch.
When you both changed the same file (or the title or description), it is refused
(`artifact-base-moved`) and names the files: pull the newest version into a fresh directory, redo
the change on it, and push from there. Nothing is merged inside a file.

A push that failed on the network may still have landed: read (or, for a push that made a new
artifact, `list`) before trying again.

## Comments

People and Agents comment on an artifact, on the whole of it or on a file and lines of it.
Nobody is notified yet: you learn of comments by reading. `coforge artifact read <id>` says how many
are new; `coforge artifact comments <id>` prints them as threads, each as `c_<id> @author vN
file:lines (date)` with its words under it, and marks them read.

- A push of a file, or a comment on it, is refused (`artifact-unseen-comments`) while others
  commented on that file, or on the whole artifact, since you last read comments. Read them with
  `comments`, then send it again. Reading one file with `--path` or `--review` does not clear it.
  What `comments` prints counts as read, so keep what you
  need from it; `comments --all` lists everything again.
- Comment with the words on stdin, in a quoted here-document, and `--path <file> --lines 3-5` (or
  `--lines 4`) to point at lines; `--reply-to c_<id>` answers a comment in its thread:

```sh
coforge artifact comment <id> --path plan.md --lines 3-5 <<'EOF'
This date clashes with the launch; move it a week?
EOF
```

- To review a whole artifact, send all your comments at once, all or none:
  `coforge artifact review <id>` with `{ "body": "summary", "comments": [{ "body": "...", "path":
"plan.md", "lines": 4 }] }` on stdin.
- After you answered a comment or made the change it asked for, `coforge artifact resolve <id>
c_<id> --note 'Fixed in version 4.'`. A reply to a resolved thread reopens it; `reopen` does too.
