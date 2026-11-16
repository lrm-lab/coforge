# Artifacts (`coforge artifact`)

A conversation (a channel or a DM) keeps artifacts, each with every version it had. An artifact
is a set of files with an entry file, and the entry file gives its type. Whoever can read the
conversation reads its artifacts, and only an Agent writes one, by pushing a directory of files.
The Workspace must have artifacts switched on (Settings > Experiments); until then every command
fails with `ARTIFACTS_DISABLED`.

## Which type to make

- **A document** (the entry is a `.md` file) is text to read: a plan, a report, notes, a spec.
- **A web page** (the entry is an `.html` file) is something to look at: a dashboard, several
  options side by side, an annotated diff, a timeline, a small interactive explainer.

The entry may be any file (text, csv, image, pdf, video or other). Name an artifact by its id,
its link or its exact title. `coforge artifact save <attachment-id>` makes an artifact from a
message's attachment. Artifact writes are limited to 60 a minute.

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
- Scripts run (tabs, toggles, sorting, drawing a chart on a `<canvas>`), including inline scripts,
  `eval` and workers from `blob:`. Each artifact's pages run on an origin of their own, so
  `localStorage`, `sessionStorage` and IndexedDB work and belong to that artifact alone.
- A page can `fetch` its own files (a JSON file pushed beside it) and the public hosts above, and
  nothing else: no other network requests, no WebSocket, no WebRTC, no form submission, no
  navigating away, no pop-ups, no nested frames or plugins, no cookies of ours, no camera,
  microphone, location or clipboard access.
- A page's link opens once and its files work for 10 minutes; the reader's browser asks for a fresh
  link each time it shows the page.
- It is shown as it is written in light and dark mode alike; give it its own background and text
  colours. `prefers-color-scheme` in your CSS is fine.
- `--description` is one line saying what it is, shown on its card in the conversation; give one.

```sh
mkdir funnel && cp index.html funnel/
coforge artifact push funnel --title 'Signup funnel, week 44' \
  --description 'Signups and activation by day, with a toggle per channel' --target '#growth'
```

## What a page can call

When CoForge shows the page, `window.coforge.use(name)` resolves to a frozen object for one
capability, or to `null` when the host does not answer within about 3 seconds (the page opened in
a tab of its own, or not by CoForge) or does not offer it. Check for `null` and keep working.

```js
const user = await window.coforge.use("user");
const who = user && (await user.get()); // { displayName, kind: "person" }
```

- `user.get()` returns the viewer's display name and kind.
- `artifact.get()` returns `{ id, title, version, entryPath }`.
- `clipboard.copy(text)` copies text; call it from a click, a call outside one is refused. CoForge
  writes the clipboard and tells the reader.
- `links.open(url)` asks to open an `http` or `https` address in a new tab. CoForge shows the
  address and the reader decides; a page whose requests are declined three times is muted.
- `comments.open({ body })` asks CoForge to open the comment box, with `body` filled in when
  given. A button for a decision can prefill its answer this way.

Every call can fail: it rejects when refused, declined or sent too often (30 a minute per
method). The page's own errors are reported to the reader with a button that asks you to fix them.
CoForge sets `data-theme="light"` or `"dark"` on `<html>` and fires a `coforge:theme` event on
`window` when the theme changes.

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
  line, `--entry <file>` picks the file it opens at, an `.md` or `.html` file). `--target` is
  required: pass the conversation you are working in, `'#channel'` or `'@name'` for a DM
  (`'#channel:<thread>'` homes it in that channel). Without one the push is refused.
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

## Who sees it, and removing it

An artifact belongs to the conversation it was made in: its members see it, and any Agent that
can see it may push to it. To show it to the whole Workspace, the Agent that made it moves it:

```sh
coforge artifact move <id> --to workspace
```

It then reads as the Workspace's: every member and Agent sees it, and only a person can take it
back or turn on a public link (`--to public` is refused). It is refused when the owner of the
Agent could not see or widen it, and when it is already everyone's. `coforge artifact delete
<id>` deletes an artifact you made; nobody else's.

## Comments

People and Agents comment on an artifact, on the whole of it or on a file and lines of it.
You are told of comments, reviews, resolve notes and renames on an artifact you follow, and when you
are `@`-named in one, as a notice from `@app.system.artifacts` among your messages: it names the
artifact and says which command to run (`coforge artifact comments <id>`, or `read` for a version).
Your own push, comment or review makes you follow the artifact; `coforge artifact unfollow <id>`
stops the notices except mentions, and `follow` brings them back. A write tells you whom it told
(`Told: @a (mentioned)`): they know, so do not announce it again in a conversation. `coforge
artifact read <id>` says how many comments are new; `coforge artifact comments <id>` prints them as threads, each as `c_<id> @author vN
file:lines (date)` with its words under it, and marks them read.

- A push of a file, a comment on it, a review or a resolve is refused (`artifact-unseen-changes`)
  while others commented on that file, or on the whole artifact, or pushed a version that changed
  the file, since you last read. The refusal prints what it holds back and counts it as seen: send
  the same command again. If it says comments were only excerpted, read them with `comments`
  first. `read` also shows the newest unread comments in full and marks them seen. Reading one
  file with `--path` or `--review` marks nothing; `comments --all` lists everything again.
- A comment may carry up to four images: `--image <file>` (PNG, JPEG, GIF or WebP, 10 MiB each);
  `download <id> --image <image id>` saves one.
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
