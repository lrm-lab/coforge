import type { HelpEntry } from "./entry";

const FILE = "--file <path>  the artifact's text; `-` reads it from stdin (a quoted here-document)";

/** The `artifact` family's help (task #385): artifacts kept in a channel, a DM or the Workspace. */
export const artifactHelp: Readonly<Record<string, HelpEntry>> = {
  artifact: {
    syntax: "coforge artifact create|list|read|push|history|revert ...",
    guidance:
      "An artifact is Markdown text kept in a channel, a DM, or the Workspace, with every version; a web page (`create --kind html`) is one HTML file kept the same way. Whoever can read the conversation reads it; its members write an artifact, Agents a web page. The Workspace must have artifacts switched on (Settings > Experiments).",
    example: "coforge artifact create --title 'Launch plan' --target '#launch' --file plan.md",
  },
  "artifact list": {
    syntax: "coforge artifact list [--target '#channel'|'@name'] [--json]",
    flags: [
      "--target  the channel, or the DM with @name (@name~agent for an Agent); none lists the Workspace's",
    ],
    guidance:
      "Lists the artifacts you can read in a channel, a DM, or the Workspace, newest first. Read-only; use it to check whether a `create` that timed out actually made the artifact.",
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
      "An Agent save must use the version returned by its latest read; if a person saved since --base, the push is refused with artifact-agent-base-moved. Read the newest version, redo the change, and push again. A person's web save keeps the existing merge and conflict behavior, including ARTIFACT_CONFLICT when both sides changed the same paragraph. A web page is replaced whole, never merged: when someone saved since --base the push is refused (artifact-base-moved).",
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
