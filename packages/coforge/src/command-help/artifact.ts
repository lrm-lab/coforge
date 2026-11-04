import type { HelpEntry } from "./entry";

const FILE = "--file <path>  the document's text; `-` reads it from stdin (a quoted here-document)";

/** The `artifact` family's help (task #385): documents a channel, a DM or the Workspace keeps. */
export const artifactHelp: Readonly<Record<string, HelpEntry>> = {
  artifact: {
    syntax: "coforge artifact create|list|read|push|history|revert ...",
    guidance:
      "A document is Markdown text kept in a channel, a DM, or the Workspace, with every version. Whoever can read the conversation reads it; its members write it. The Workspace must have documents switched on (Settings > Experiments).",
    example: "coforge artifact create --title 'Launch plan' --target '#launch' --file plan.md",
  },
  "artifact list": {
    syntax: "coforge artifact list [--target '#channel'|'@name'] [--json]",
    flags: [
      "--target  the channel, or the DM with @name (@name~agent for an Agent); none lists the Workspace's",
    ],
    guidance:
      "Lists the documents you can read in a channel, a DM, or the Workspace, newest first. Read-only; use it to check whether a `create` that timed out actually made the document.",
    example: "coforge artifact list --target '#launch'",
  },
  "artifact create": {
    syntax:
      "coforge artifact create --title <title> [--target '#channel'|'@name'] [--file <path>|-] [--json]",
    flags: [
      "--title  the document's title; its name is made from it",
      "--target  the channel, or the DM with @name (@name~agent for an Agent), it belongs to; no thread; none is the Workspace",
      FILE,
    ],
    guidance: "Prints the new document's id, which every other artifact command takes.",
    example: "coforge artifact create --title 'Launch plan' --target '#launch' --file plan.md",
  },
  "artifact read": {
    syntax: "coforge artifact read <id> [--version <n>] [--output <path>] [--json]",
    flags: [
      "--version  an earlier version; the current one by default",
      "--output  write the text to this file instead of printing it",
    ],
    guidance: "Prints the version line, then `---` and the text. Save over the version you read.",
    example: "coforge artifact read 0f8c…e1 --output plan.md",
  },
  "artifact push": {
    syntax:
      "coforge artifact push <id> --base <version> [--file <path>|-] [--title <t>] [--description <t>] [--note <t>] [--label <t>] [--json]",
    flags: [
      "--base  the version your text started from, as read printed it",
      FILE,
      "--note  what changed, shown in history",
      "--label  names this version (a save with only a label still makes one)",
    ],
    guidance:
      "Changes others saved since --base are merged in. When both changed the same paragraph nothing is written: the document is printed to stdout with <<<<<<< yours / ======= / >>>>>>> theirs markers and the command exits 1 with ARTIFACT_CONFLICT. Resolve the markers and push again over the version it names.",
    example: "coforge artifact push 0f8c…e1 --base 3 --file plan.md --note 'moved the date'",
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
};
