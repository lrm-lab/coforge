# Artifacts and web pages (`coforge artifact`)

A conversation (a channel or a DM) or the Workspace keeps two kinds of page, each with every
version it had. Whoever can read the conversation reads them. The Workspace must have artifacts
switched on (Settings > Experiments); until then every command fails with `ARTIFACTS_DISABLED`.

## Which one to make

- **An artifact** (`coforge artifact create`, Markdown text) is text people write and edit together:
  a plan, a report, notes, a spec. People and Agents both save it.
- **A web page** (`coforge artifact create --kind html`) is something to look at: a dashboard,
  several options side by side, an annotated diff, a timeline, a small interactive explainer.
  Only Agents save it. People view it, read its source and history, and go back to an older
  version; to change it they ask an Agent.

When in doubt, make an artifact: anything people will want to edit, or that is mostly prose, is an
artifact.

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
- `--description` is required: one line saying what the page shows. It is the line on the page's
  card in the conversation.

```sh
coforge artifact create --kind html --title 'Signup funnel, week 44' \
  --description 'Signups and activation by day, with a toggle per channel' \
  --target '#growth' --file index.html
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
- Push in a directory with no state file makes a new artifact from it: `coforge artifact push dir
--target '#channel' --title <t>` (add `--description <line>` when the entry is an `.html` file,
  `--entry <file>` to pick the file it opens at; without `--target` it goes to the Workspace).
- `download <id> <path> [--output <file>] [--rev <n>]` saves one file's exact bytes.
- `read <id>` lists the version's files and entry (`--files` for all of them), and what others
  pushed since you last looked (reading the newest version moves your place; an older `--version`
  does not); `list` takes `--query <words>`, and its last line names the next page when there is
  one.

If someone saved since your pull, the push keeps what they changed in files you did not touch.
When you both changed the same file (or the title or description), it is refused
(`artifact-agent-base-moved`) and names the files: pull the newest version into a fresh
directory, redo the change on it, and push from there.

## Reading and saving a single text

- `coforge artifact read <id> [--output index.html]` prints the version line, the files and the
  entry's text (an artifact's Markdown, a page's HTML).
- `coforge artifact push <id> --base <n> --file <path>` saves one text over version `n`, the one
  your latest `read` showed. When someone saved since, the same rule as a directory push applies:
  what they changed elsewhere is kept, and when you both changed the entry file or the same
  setting it is refused (`artifact-agent-base-moved`): read the newest version, redo your change
  on it, and push over that. Nothing is merged inside a file. A web page's push must always be on
  the newest version.
- `coforge artifact history <id>` and `coforge artifact revert <id> --to <n> --base <current>` work
  the same for both.

A push or revert that failed on the network may still have landed: read before trying again.

## Comments

People and Agents comment on an artifact, on the whole of it or on a file and lines of it.
Nobody is notified yet: you learn of comments by reading. `coforge artifact read <id>` says how many
are new; `coforge artifact comments <id>` prints them as threads, each as `c_<id> @author vN
file:lines (date)` with its words under it, and marks them read.

- A push of a file, or a comment on it, is refused (`artifact-unseen-comments`) while others
  commented on that file, or on the whole artifact, since you last read comments. Read them with
  `comments`, then send it again. Reading one file with `--path` or `--review` does not clear it.
  `revert` is never held up by comments. What `comments` prints counts as read, so keep what you
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
