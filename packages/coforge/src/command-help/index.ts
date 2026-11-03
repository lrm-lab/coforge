import { CliError } from "../cli-error";
import type { HelpEntry } from "./entry";
import { artifactHelp } from "./artifact";
import { taskHelp } from "./task";

/**
 * Every command `parseArgs` accepts, keyed by the words that name it. The longest matching key
 * wins, so `message read --help` finds its own entry and `message --help` the family's.
 */
const COMMANDS: Readonly<Record<string, HelpEntry>> = {
  ...taskHelp,
  ...artifactHelp,
  message: {
    syntax: "coforge message check|read|search|send|resolve|react ...",
    example: "coforge message check --target '#general'",
  },
  "message check": {
    syntax: "coforge message check [--target @user|#channel]",
    flags: ["--target  drain one conversation only"],
    example: "coforge message check --target '#general'",
  },
  "message read": {
    syntax:
      "coforge message read --target <target> [--unread | --before|--after|--around <seq>] [--limit <n>]",
    flags: [
      "--target  the conversation to read",
      "--unread  messages after your read position (no anchor combines with it)",
      "--before | --after | --around  one history window",
      "--limit  page size, 1-100",
    ],
    example: "coforge message read --unread --target '#general'",
  },
  "message search": {
    syntax:
      "coforge message search --query <text> [--target <target>] [--sender <handle>] [--sort relevance|recent] [--before <iso>] [--after <iso>] [--limit <n>] [--offset <n>] [--cursor <cursor>]",
    example: "coforge message search --query 'release plan' --limit 10",
  },
  "message send": {
    syntax: "coforge message send --target <target> [options] < message body on stdin",
    flags: [
      "--attachment-id <uuid>  attach an uploaded file (repeatable)",
      "--mention human:<uuid>:<handle>|agent:<uuid>:<handle>  mention someone (repeatable)",
      "--send-draft  resend the saved draft unchanged",
      "--anyway  force a held draft the server asked about more than once",
      "--reviewer-isolation  withhold newer context from a reviewer",
    ],
    guidance:
      "The message body is read from stdin, never from arguments. Use a quoted here-document:\n  coforge message send --target '#general' <<'COFORGE_MESSAGE'\n  Shipped the fix.\n  COFORGE_MESSAGE\nA mention that was not delivered still exits 0: do not resend the message.",
    example:
      "coforge message send --target '#general' <<'COFORGE_MESSAGE'\nShipped the fix.\nCOFORGE_MESSAGE",
  },
  "message continue": {
    syntax: "coforge message continue <continuation-id> <a|b|c|d>",
    flags: [
      "a  send the held draft unchanged",
      "b  replace the body — reads the new body from stdin; the held draft's idempotency key is reused",
      "c  do not send; discard the held draft",
      "d  send the held draft anyway, despite the freshness warning (only when offered)",
    ],
    example: "coforge message continue 9f47ac10-… a",
  },
  "message resolve": {
    syntax: "coforge message resolve <message-id>",
    example: "coforge message resolve 12345678",
  },
  "message react": {
    syntax: "coforge message react --message-id <id> --emoji <emoji> [--remove]",
    example: "coforge message react --message-id 12345678 --emoji 👍",
  },
  channel: {
    syntax:
      "coforge channel info|members|join|leave|create|update|archive|unarchive|add-member|remove-member|mute|unmute ...",
    example: "coforge channel info --target '#general'",
  },
  "channel info": {
    syntax: "coforge channel info --target '#channel' [--json]",
    example: "coforge channel info --target '#general'",
  },
  "channel members": {
    syntax: "coforge channel members --target '#channel' [--json]",
    example: "coforge channel members --target '#general'",
  },
  "channel join": {
    syntax: "coforge channel join --target '#channel' [--json]",
  },
  "channel leave": {
    syntax: "coforge channel leave --target '#channel' [--json]",
  },
  "channel create": {
    syntax: "coforge channel create --name <name> [--description <text>] [--private] [--json]",
    example: "coforge channel create --name release-notes",
  },
  "channel update": {
    syntax:
      "coforge channel update --target '#channel' [--name <name>] [--description <text>] [--public|--private] [--json]",
  },
  "channel archive": {
    syntax: "coforge channel archive --target '#channel' [--json]",
    example: "coforge channel archive --target '#old-project'",
  },
  "channel unarchive": {
    syntax: "coforge channel unarchive --target '#channel' [--json]",
  },
  "channel add-member": {
    syntax:
      "coforge channel add-member --target '#channel' (--user @handle | --agent @handle) [--json]",
  },
  "channel remove-member": {
    syntax:
      "coforge channel remove-member --target '#channel' (--user @handle | --agent @handle) [--json]",
  },
  "channel mute": {
    syntax: "coforge channel mute [<target>]",
    example: "coforge channel mute --target '#general'",
  },
  "channel unmute": {
    syntax: "coforge channel unmute [<target>]",
  },
  inbox: {
    syntax: "coforge inbox check [--view unread|mentions] [--before <n>] [--json]",
    example: "coforge inbox check --view mentions",
  },
  thread: {
    syntax:
      "coforge thread list | coforge thread unfollow --target '#channel:message-id' [--reason <text>]",
    example: "coforge thread unfollow --target '#general:12345678'",
  },
  reminder: {
    syntax: "coforge reminder schedule|list|cancel|update|snooze|seal|unseal ...",
    example: "coforge reminder list",
  },
  "reminder schedule": {
    syntax:
      "coforge reminder schedule --title <title> --at <iso> [--repeat <rule>] [--target <target>] [--json]",
    example: "coforge reminder schedule --title 'Check the deploy' --at 2026-10-30T09:00:00Z",
  },
  "reminder list": {
    syntax: "coforge reminder list [--status scheduled|...] [--all] [--json]",
  },
  "reminder cancel": {
    syntax: "coforge reminder cancel --id <id> [--json]",
  },
  "reminder update": {
    syntax: "coforge reminder update --id <id> [--title <title>] [--at <iso>] [--json]",
  },
  "reminder snooze": {
    syntax: "coforge reminder snooze --id <id> --until <iso> [--json]",
  },
  "reminder seal": {
    syntax:
      "coforge reminder seal --id <id> [--revision <n>|--all-pending] --owner <who> --until <condition> [--json]",
    example:
      "coforge reminder seal --id 123e4567 --all-pending --owner @ada --until 'the deploy lands'",
  },
  "reminder unseal": {
    syntax: "coforge reminder unseal --id <id> [--revision <n>|--all-pending] [--json]",
  },
  attachment: {
    syntax: "coforge attachment view|comments|upload ...",
    example: "coforge attachment view --id <uuid> --output ./file.png",
  },
  "attachment view": {
    syntax: "coforge attachment view [--id] <id> --output <path> [--json]",
  },
  "attachment comments": {
    syntax: "coforge attachment comments [--id] <id> [--limit <n>] [--before <sequence>] [--json]",
  },
  "attachment upload": {
    syntax:
      "coforge attachment upload --path <file> (--target <target>|--channel <target>) [--mime-type <type>] [--json]",
    example: "coforge attachment upload --path ./report.pdf --target '#general'",
  },
  mention: {
    syntax: "coforge mention pending|notify|add|delivery ...",
    example: "coforge mention pending",
  },
  "mention pending": {
    syntax: "coforge mention pending [--limit <n>] [--json]",
  },
  manual: {
    syntax: 'coforge manual get <topic> | coforge manual search "<keywords>"',
    example: "coforge manual get channels",
  },
  "manual get": {
    syntax: "coforge manual get <topic> [--intent <text>] [--reason <text>]",
    example: "coforge manual get tasks",
  },
  "manual search": {
    syntax: 'coforge manual search "<keywords>" [--intent <text>] [--reason <text>]',
  },
  user: {
    syntax: "coforge user info <name> [--limit <n>] [--offset <n>] [--json]",
  },
  "user info": {
    syntax: "coforge user info <name> [--limit <n>] [--offset <n>] [--json]",
    example: "coforge user info ada",
  },
  profile: {
    syntax:
      "coforge profile show [<target>] | coforge profile update [--display-name <text>] [--description <text>]",
  },
  "profile show": {
    syntax: "coforge profile show [<target>] [--json]",
  },
  "profile update": {
    syntax: "coforge profile update [--display-name <text>] [--description <text>] [--json]",
  },
  workspace: {
    syntax: "coforge workspace info [--limit <n>] [--offset <n>] [--json]",
  },
  "workspace info": {
    syntax: "coforge workspace info [--limit <n>] [--offset <n>] [--json]",
  },
  action: {
    syntax: "coforge action prepare --target <target>",
  },
  "action prepare": {
    syntax: "coforge action prepare --target <target>",
  },
  app: {
    syntax: "coforge app list|config|token|invoke ...",
    example: "coforge app list",
  },
  "app config": {
    syntax:
      "coforge app config --app <app-id> [--set <key>=<value>]... [--unset <key>]... [--json]",
  },
  "app list": {
    syntax: "coforge app list [--all] [--json]",
  },
  whoami: {
    syntax: "coforge whoami [--json]",
  },
  version: {
    syntax: "coforge version [--json]",
  },
  "weekly-report": {
    syntax: "coforge weekly-report templates|inbox|members|workflow|context|list|read ...",
  },
  "inbox check": {
    syntax: "coforge inbox check [--view unread|mentions] [--before <n>] [--json]",
    example: "coforge inbox check --view mentions",
  },
  "thread list": {
    syntax: "coforge thread list [--json]",
  },
  "thread unfollow": {
    syntax: "coforge thread unfollow --target '#channel:message-id' [--reason <text>]",
    example: "coforge thread unfollow --target '#general:12345678'",
  },
  "task unclaim": {
    syntax:
      "coforge task unclaim --target <channel> [--peer-kind human|agent] --number <n> [--expected-revision <n>] [--json]",
  },
  "task convert": {
    syntax:
      "coforge task convert --target <channel> [--peer-kind human|agent] --message-id <id> [--json]",
  },
  "task amend": {
    syntax:
      "coforge task amend --target <channel> [--peer-kind human|agent] --number <n> [--title <title>] [--description <text>|--clear-description] [--blocked-by <task>,...|''] [--parent <task>|''] [--label <name>]... [--project <slug>|--clear-project] [--reviewer-isolation] [--json]",
    flags: [
      "--blocked-by  replaces the whole set ('' clears it); --parent  the new parent ('' makes it top level)",
      "--project  file the Task under this Project by slug, kept when its channel changes Project; --clear-project  let it follow its channel's Project again",
    ],
  },
  "task history": {
    syntax:
      "coforge task history --target <channel> [--peer-kind human|agent] --number <n> [--json]",
  },
  "task receipt": {
    syntax:
      "coforge task receipt --target <channel> [--peer-kind human|agent] --number <n> [--json]",
  },
  "task delete": {
    syntax:
      "coforge task delete --target <channel> [--peer-kind human|agent] --number <n> [--json]",
  },
  "reminder log": {
    syntax: "coforge reminder log --id <id> [--json]",
  },
  "reminder ack": {
    syntax: "coforge reminder ack --id <id> --revision <n> [--json]",
  },
  "reminder dismiss": {
    syntax: "coforge reminder dismiss --id <id> --revision <n> [--json]",
  },
  "mention notify": {
    syntax: "coforge mention notify <resolution-id>... [--json]",
  },
  "mention add": {
    syntax: "coforge mention add <resolution-id>... [--json]",
  },
  "mention delivery": {
    syntax: "coforge mention delivery --message <message-id> [--json]",
  },
  "app token": {
    syntax:
      "coforge app token --app <key> [--target <target>] [--timeout <seconds>] --exec <program> [-- <args>...]",
  },
  "app invoke": {
    syntax: "coforge app invoke <app> <action> [--input <json>] [--json]",
  },
  "app prepare": {
    syntax: "coforge app prepare --target <target>",
  },
  "app status": {
    syntax: "coforge app status --app <key> [--json]",
  },
  "app rotate-secret": {
    syntax: "coforge app rotate-secret --app <key> [--json]",
  },
  "weekly-report-collect": {
    syntax:
      "coforge weekly-report-collect submit-pack|submit-empty|submit-failure --run-id <uuid> --idempotency-key <uuid> [--markdown <path>] [--reason <text>]",
  },
  "weekly-report-collect submit-pack": {
    syntax:
      "coforge weekly-report-collect submit-pack --run-id <uuid> --idempotency-key <uuid> --markdown <path>",
  },
  "weekly-report-collect submit-empty": {
    syntax: "coforge weekly-report-collect submit-empty --run-id <uuid> --idempotency-key <uuid>",
  },
  "weekly-report-collect submit-failure": {
    syntax:
      "coforge weekly-report-collect submit-failure --run-id <uuid> --idempotency-key <uuid> --reason <text>",
  },
  "weekly-report templates": {
    syntax: "coforge weekly-report templates [--json]",
  },
  "weekly-report inbox": {
    syntax: "coforge weekly-report inbox [--json]",
  },
  "weekly-report members": {
    syntax: "coforge weekly-report members [--json]",
  },
  "weekly-report workflow": {
    syntax: "coforge weekly-report workflow --input <json-file>",
  },
  "weekly-report context": {
    syntax: "coforge weekly-report context --subject-type report|cycle --subject-id <uuid>",
  },
  "weekly-report list": {
    syntax: "coforge weekly-report list [--cycle-id <uuid>] [--cursor <uuid>] [--limit <n>]",
  },
  "weekly-report read": {
    syntax: "coforge weekly-report read --report-id <uuid> --section <name> [--max-characters <n>]",
  },
};

function renderHelp(name: string, entry: HelpEntry): string {
  const lines = [`coforge ${name}`, "", `  ${entry.syntax}`];
  if (entry.flags?.length) lines.push("", ...entry.flags.map((flag) => `  ${flag}`));
  if (entry.guidance) lines.push("", entry.guidance);
  if (entry.example) lines.push("", `Example: ${entry.example}`);
  return lines.join("\n");
}

/** The help for the longest command named in `argv`, or undefined when it names none. */
export function commandHelp(argv: readonly string[]): string | undefined {
  const words = argv.filter((arg) => !arg.startsWith("-"));
  for (let length = Math.min(words.length, 2); length > 0; length--) {
    const name = words.slice(0, length).join(" ");
    const entry = COMMANDS[name];
    if (entry) return renderHelp(name, entry);
  }
  return undefined;
}

/** An argument the command cannot accept: what was wrong, and the help that lists the accepted
 * form — never a bare `Usage:` line. */
export function invalidArgument(command: string, reason: string): CliError {
  return new CliError({
    code: "INVALID_ARG",
    message: reason,
    retryable: false,
    suggestedNextAction: `Run \`coforge ${command} --help\` for the accepted form.`,
  });
}
