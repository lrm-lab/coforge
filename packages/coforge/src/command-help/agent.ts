import type { HelpEntry } from "./entry";

const PROFILE_FLAG = "--profile  the profile to use (default: COFORGE_PROFILE, else the only one)";

export const agentHelp: Readonly<Record<string, HelpEntry>> = {
  agent: {
    syntax: "coforge agent login|status|logout ...",
    example: "coforge agent status",
  },
  "agent login": {
    syntax:
      "coforge agent login --server <url> --agent <id-or-name> [--profile <slug>] | coforge agent login start --server <url> --workspace <slug> --agent <name> [--profile <slug>] | coforge agent login wait [--profile <slug>]",
    flags: [
      "--server  the CoForge server, an https:// URL",
      "--workspace  the Workspace slug (start only)",
      "--agent  the external Agent's id or name",
      "--profile  where to save the key (default: <workspace>-<agent>)",
    ],
    guidance:
      "Plain login reads the key created on the Agent's page from a hidden prompt, or from the first line of stdin when it is not a terminal, and checks it with the server. `login start` prints an approval page address and a user code for an owner or admin to approve, and exits; `login wait` waits for the approval and saves the key. Signing in again for the same Agent replaces the profile's key and revokes the old one.",
    example: "coforge agent login --server https://coforge.example --agent builder < key.txt",
  },
  "agent status": {
    syntax: "coforge agent status [--profile <slug>]",
    flags: [PROFILE_FLAG],
    guidance: "Prints state: usable, revoked, mismatch, missing or unverified.",
  },
  "agent logout": {
    syntax: "coforge agent logout [--profile <slug>]",
    flags: [PROFILE_FLAG],
    guidance:
      "Revokes this machine's key on the server, then deletes it. If the server cannot be reached the saved key is kept.",
  },
};
