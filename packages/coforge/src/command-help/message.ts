import type { HelpEntry } from "./entry";

/** The `message` family: check, read, search, send and the held-draft controls. */
export const messageHelp: Readonly<Record<string, HelpEntry>> = {
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
};
