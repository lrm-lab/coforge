import type { HelpEntry } from "./entry";

const FILE = "--file <path>  the artifact's text; `-` reads it from stdin (a quoted here-document)";

/** The `artifact` family's help (task #385): artifacts kept in a channel, a DM or the Workspace. */
export const artifactHelp: Readonly<Record<string, HelpEntry>> = {
  artifact: {
    syntax: "coforge artifact create|list|read|push|history|revert|pull|download ...",
    guidance:
      "An artifact is Markdown text kept in a channel, a DM, or the Workspace, with every version; a web page (`create --kind html`) is one HTML file kept the same way. Whoever can read the conversation reads it; its members write an artifact, Agents a web page. To work on one as files, `pull` it into a directory, edit, and `push` the directory: only the files that changed are sent. The Workspace must have artifacts switched on (Settings > Experiments).",
    example: "coforge artifact pull 0f8c…e1 --dir plan && coforge artifact push plan",
  },
  "artifact list": {
    syntax:
      "coforge artifact list [--target '#channel'|'@name'] [--query <words>] [--after <c>] [--limit <n>] [--json]",
    flags: [
      "--target  the channel, or the DM with @name (@name~agent for an Agent); none lists the Workspace's",
      "--query  only artifacts matching these words",
      "--after  the next page: the cursor the previous page's last line named",
      "--limit  how many to list in a page",
    ],
    guidance:
      "Lists the artifacts you can read in a channel, a DM, or the Workspace, newest first, a page at a time; when more exist the last line is the command for the next page. Read-only; use it to check whether a `create` that timed out actually made the artifact.",
    example: "coforge artifact list --target '#launch'",
  },
  "artifact create": {
    syntax:
      "coforge artifact create --title <title> [--kind markdown|html] [--description <line>] [--target '#channel'|'@name'] [--file <path>|-] [--json]",
    flags: [
      "--title  the artifact's title; its name is made from it",
      "--kind  markdown (Markdown text, the default) or html (a web page: one self-contained index.html)",
      "--description  one line saying what it is, shown on its card; required for --kind html",
      "--target  the channel, or the DM with @name (@name~agent for an Agent), it belongs to; no thread; none is the Workspace",
      FILE,
    ],
    guidance:
      "Prints the new id, which every other artifact command takes. An artifact is text people write together; a web page is something to look at (a dashboard, options side by side, an annotated diff), runs its own inline scripts, cannot reach the network, and only Agents change it. See `coforge manual get artifacts`.",
    example: "coforge artifact create --title 'Launch plan' --target '#launch' --file plan.md",
  },
  "artifact read": {
    syntax: "coforge artifact read <id> [--version <n>] [--files] [--output <path>] [--json]",
    flags: [
      "--version  an earlier version; the current one by default",
      "--files  list every file of the version (the first few by default)",
      "--output  write the text to this file instead of printing it",
    ],
    guidance:
      "Prints the version line, the entry and the version's files, then `---` and the entry's text. To change files, `pull` the artifact instead.",
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
      "--target  make a new artifact in this channel or DM (none: the Workspace); only for a directory that was not pulled",
      "--title  the title; required to make a new artifact, a setting to change otherwise",
      "--description  one line saying what it is; required when the entry is an .html file",
      "--entry  the file it opens at; a new artifact uses index.html, or its only file, by default",
      "--note  what changed, shown in history",
      "--label  names this version (a push with only a label still makes one)",
      "--delete  remove this path from the artifact; the file must already be gone from the directory; repeat for more",
      "--include-hidden  send files and folders that start with . too (the state file never goes)",
    ],
    guidance:
      "In a directory from `pull`, sends only the files whose hash differs from the pulled one, as a new version over the version pulled; a file missing from the directory is kept, not deleted. A push over an older version keeps what others changed in files you did not touch; when you and someone else changed the same file or setting it is refused (artifact-agent-base-moved) and names the files: pull the newest version, redo the change, push again. Without that state file, creates a new artifact from the directory. On success the state file moves to the new version.\nOlder form: `coforge artifact push <id> --base <version> [--file <path>|-]` saves one text over version --base (--title, --description, --note, --label also apply); the same refusal applies.",
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
  "artifact history": {
    syntax: "coforge artifact history <id> [--before <version>] [--limit <n>] [--json]",
    flags: ["--before  the next page: the version the previous page named", "--limit  1-50"],
    example: "coforge artifact history 0f8c…e1",
  },
  "artifact revert": {
    syntax: "coforge artifact revert <id> --to <version> --base <current version> [--json]",
    flags: [
      "--to  the version to go back to",
      "--base  the current version, which must still be current",
    ],
    guidance: "Saves version --to's text and settings as a new version; nothing is rewritten.",
    example: "coforge artifact revert 0f8c…e1 --to 2 --base 5",
  },
  "artifact share": {
    syntax: "coforge artifact share <id>... --to <target>... [--note <text>] [--json]",
    flags: [
      "<id>...  one or more artifact ids",
      "--to  the channel or DM target; repeat for more targets",
      "--note  an optional note above the live artifact links",
    ],
    guidance:
      "Posts an ordinary message containing live artifact links. Sharing does not grant access; each reader is checked against the artifact's existing access tier.",
  },
};
