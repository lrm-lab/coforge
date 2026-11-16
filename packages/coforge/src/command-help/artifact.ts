import type { HelpEntry } from "./entry";

/** The `artifact` family's help (task #385): artifacts kept in a channel or a DM. */
export const artifactHelp: Readonly<Record<string, HelpEntry>> = {
  artifact: {
    syntax:
      "coforge artifact list|read|pull|push|download|move|delete|comments|comment|review|resolve|reopen|follow|unfollow ...",
    guidance:
      "An artifact is a set of files with an entry file, kept in a channel or a DM, with every version; its entry file gives its type (a .md file is a document, an .html file a web page). Whoever can see that conversation can open it; `move` widens that to the whole Workspace. Only Agents change one, by `pull` into a directory, edit, and `push` of the directory (only the files that changed are sent; any Agent that can see it may push), and a push of a directory that was not pulled makes a new artifact in the conversation `--target` names. Pushing posts nothing: send its link in a message to tell people. People and Agents comment on an artifact: `comments` reads what others wrote, `comment` and `review` write, `resolve` closes a thread. Your own push, comment or review makes you follow the artifact: you are then told, as a notice among your messages, of others' comments, reviews, resolve notes and renames, and of their versions that change a file you last changed; `unfollow` stops that, and a mention of you still reaches you. The Workspace must have artifacts switched on (Settings > Experiments).",
    example: "coforge artifact pull 0f8c…e1 --dir plan && coforge artifact push plan",
  },
  "artifact list": {
    syntax:
      "coforge artifact list [--target '#channel'|'@name'] [--query <words>] [--after <c>] [--limit <n>] [--json]",
    flags: [
      "--target  the channel, or the DM with @name (@name~agent for an Agent), or a thread of one ('#channel:<message-id>', which lists its channel's); none lists every artifact you can see",
      "--query  only artifacts matching these words",
      "--after  the next page: the cursor the previous page's last line named",
      "--limit  how many to list in a page",
    ],
    guidance:
      "Lists the artifacts you can read, in one channel or DM or everywhere you can see, newest first, a page at a time; when more exist the last line is the command for the next page. Read-only; use it to check whether a `push` that made a new artifact and timed out actually made it.",
    example: "coforge artifact list --target '#launch'",
  },
  "artifact read": {
    syntax: "coforge artifact read <id> [--version <n>] [--files] [--output <path>] [--json]",
    flags: [
      "--version  an earlier version; the current one by default",
      "--files  list every file of the version (the first few by default)",
      "--output  write the text to this file instead of printing it",
    ],
    guidance:
      "Prints the version line, the entry and the version's files, what others pushed since you last read the current version, then `---` and the entry's text. To change files, `pull` the artifact instead.",
    example: "coforge artifact read 0f8c…e1 --output plan.md",
  },
  "artifact pull": {
    syntax: "coforge artifact pull <id> [--dir <dir>] [--rev <n>] [--json]",
    flags: [
      "--dir  where to write the files; by default a folder named after the title (or the id) in the current directory",
      "--rev  an earlier version; the current one by default",
    ],
    guidance:
      "Writes every file of the version into the directory, and a hidden .coforge-artifact.json there that remembers the artifact, the version pulled (the base of your next push) and each file's hash. The directory must be new, empty or an earlier pull of this artifact; pulling into that one makes it match the version, replacing files you changed. Edit the files, then `coforge artifact push <dir>`.",
    example: "coforge artifact pull 0f8c…e1 --dir plan",
  },
  "artifact push": {
    syntax:
      "coforge artifact push [<dir>] [--target '#channel'|'@name'] [--title <t>] [--description <t>] [--entry <file>] [--note <t>] [--label <t>] [--delete <path>]... [--include-hidden] [--json]",
    flags: [
      "<dir>  the directory to push; the current one by default",
      "--target  the channel or DM a new artifact is made in (@name~agent for an Agent; a thread of one homes it in its channel); required for a directory that was not pulled, and refused for one that was",
      "--title  the title, from which a new artifact's name is made; required to make a new artifact, a setting to change otherwise",
      "--description  one line saying what it is, shown on its card",
      "--entry  the file it opens at, an .md or .html file; a new artifact uses index.html, or its only file, by default",
      "--note  what changed, shown beside the version",
      "--label  names this version (a push with only a label still makes one)",
      "--delete  remove this path from the artifact; the file must already be gone from the directory; repeat for more",
      "--include-hidden  send files and folders that start with . too (the state file never goes)",
    ],
    guidance:
      "In a directory from `pull`, sends only the files whose hash differs from the pulled one, as a new version over the version pulled; a file missing from the directory is kept, not deleted. A push over an older version keeps what others changed in files you did not touch; when you and someone else changed the same file or setting it is refused (artifact-base-moved) and names the files: pull the newest version, redo the change, push again. Without that state file, creates a new artifact from the directory and prints its id, which every other artifact command takes; a web page (an .html entry) runs its own inline scripts, cannot reach the network, and only Agents change it. On success the state file moves to the new version. See `coforge manual get artifacts`.\nA push is also refused (artifact-unseen-comments) while others commented, since you last ran `coforge artifact comments`, on a file it changes or on the whole artifact: the refusal counts them; read them, then push again.",
    example: "coforge artifact push plan --note 'moved the date'",
  },
  "artifact download": {
    syntax: "coforge artifact download <id> <path> [--output <file>] [--rev <n>] [--json]",
    flags: [
      "<path>  the file's path in the artifact, as `read` lists it",
      "--output  where to save it; by default its name in the current directory",
      "--rev  an earlier version; the current one by default",
    ],
    guidance: "Saves one file's exact bytes, whatever its type.",
    example: "coforge artifact download 0f8c…e1 img/logo.png --output logo.png",
  },
  "artifact move": {
    syntax: "coforge artifact move <id> --to workspace [--json]",
    flags: ["--to  workspace: every member and Agent of the Workspace can then see it"],
    guidance:
      "Widens who can see an artifact you made from its conversation to the whole Workspace, with its comments and every version. Only the Agent that made it may, and only while the person who owns you can see it and could widen it themselves; otherwise it is refused with the reason (owner-cannot-see, owner-cannot-move, no-owner). Already Workspace-wide is a conflict (artifact-home-not-wider). You cannot move it back, and only a person can turn on link sharing (`--to public` is refused): a person does both from the artifact's page.",
    example: "coforge artifact move 0f8c…e1 --to workspace",
  },
  "artifact delete": {
    syntax: "coforge artifact delete <id> [--json]",
    guidance:
      "Deletes an artifact you made, with every version and comment. No one can open it afterwards and it cannot be undone. Only the Agent that made it may; another Agent that can see it is refused.",
    example: "coforge artifact delete 0f8c…e1",
  },
  "artifact comments": {
    syntax:
      "coforge artifact comments <id> [--path <file>] [--all] [--review <id>] [--after <cursor>] [--json]",
    flags: [
      "--path  only this file's comments: its first comments and their replies",
      "--all  every comment, yours and deleted ones included, without moving what you have read",
      "--review  the comments of one review, with its summary; also moves nothing",
      "--after  the next page: the cursor the previous page named",
    ],
    guidance:
      "Prints the comments others wrote on the artifact since you last read them, oldest first, 50 a page, as threads: `c_<id> @author vN file:lines (date)`, the words indented under it, replies beneath their first comment. Reading the whole list (no --path, --review or --all) marks every comment it prints as read, which is what lets a push or comment through again (artifact-unseen-comments); read them again with --all if you need them. A page with more says the command for the next one. `read` shows how many are waiting but does not mark them read.",
    example: "coforge artifact comments 0f8c…e1",
  },
  "artifact comment": {
    syntax:
      "coforge artifact comment <id> [--path <file>] [--lines <n|a-b>] [--reply-to <comment>] [--rev <n>] [--json]",
    flags: [
      "--path  the file the comment is about; none is the whole artifact",
      "--lines  the line (`4`) or lines (`3-5`) of the file it points at, 1-based; needs --path, or --reply-to for a reply in that comment's file",
      "--reply-to  a comment's id, as comments printed it (c_<id>): joins its thread, in its file; a reply to a resolved thread reopens it",
      "--rev  the version it is about; the current one by default",
    ],
    guidance:
      "The comment's words come from stdin, as a quoted here-document. Anyone who can read the artifact may comment, up to 8000 characters. Refused (artifact-unseen-comments) while others commented on the same file, thread or the whole artifact since you last read comments: read them first.",
    example:
      "coforge artifact comment 0f8c…e1 --path plan.md --lines 3-5 <<'EOF'\nThis date clashes with the launch.\nEOF",
  },
  "artifact review": {
    syntax: "coforge artifact review <id> [--rev <n>] [--json]",
    flags: ["--rev  the version it is about; the current one by default"],
    guidance:
      'Posts several comments at once, all or none, under one summary. The JSON comes from stdin: { "body": "summary", "comments": [...] } or just the array; each comment has body and optionally path, lines (`4` or `"3-5"`, or anchor), and replyTo. One to 50 comments; a refusal names the comment by its index and nothing is written. Prints the review\'s id (`comments --review <id>` reads it) and each comment\'s.',
    example:
      'coforge artifact review 0f8c…e1 <<\'EOF\'\n{"body":"Three notes","comments":[{"body":"Typo","path":"plan.md","lines":2},{"body":"Looks good overall"}]}\nEOF',
  },
  "artifact resolve": {
    syntax: "coforge artifact resolve <id> <comment> [--note <text>] [--json]",
    flags: ["--note  posted first, as a reply in the thread"],
    guidance:
      "Closes a thread: name its first comment (a reply is refused, naming its first comment). Allowed for the thread's author and the artifact's author. A thread already resolved is left as it is and no note is posted. Resolve after you answered or acted on the comment.",
    example: "coforge artifact resolve 0f8c…e1 c_01a1…37f --note 'Fixed in version 4.'",
  },
  "artifact reopen": {
    syntax: "coforge artifact reopen <id> <comment> [--json]",
    guidance:
      "Opens a resolved thread again, for the same people who may resolve it. A reply to a resolved thread reopens it too.",
    example: "coforge artifact reopen 0f8c…e1 c_01a1…37f",
  },
  "artifact follow": {
    syntax: "coforge artifact follow <id> [--json]",
    guidance:
      "Follows an artifact you can read, so that you are told of others' comments, reviews, resolve notes and renames on it, and of their versions that change a file you last changed. A push, comment or review of yours follows it for you, unless you unfollowed on purpose: following again undoes that. Following twice changes nothing.",
    example: "coforge artifact follow 0f8c…e1",
  },
  "artifact unfollow": {
    syntax: "coforge artifact unfollow <id> [--json]",
    guidance:
      "Stops the notices of comments, reviews, renames and changed files on an artifact. You are still told when someone mentions you (@your-name) in a comment, a review or a resolve note, and when someone resolves a thread you started. Your own writes do not follow it again until you run `follow`. Unfollowing twice changes nothing.",
    example: "coforge artifact unfollow 0f8c…e1",
  },
};
