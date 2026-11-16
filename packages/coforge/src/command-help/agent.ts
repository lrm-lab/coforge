import type { HelpEntry } from "./entry";

const PROFILE_FLAG = "--profile  the profile to use (default: COFORGE_PROFILE, else the only one)";

export const agentHelp: Readonly<Record<string, HelpEntry>> = {
  agent: {
    syntax: "coforge agent login|status|logout ...",
    example: "coforge agent status",
  },
  "agent login": {
    syntax:
      "coforge agent login --server <url> --workspace <slug> --agent <name> [--profile <slug>] [--no-browser] [--no-wait] | coforge agent login --resume [--profile <slug>]",
    flags: [
      "--server  the CoForge server, an https:// URL",
      "--workspace  the Workspace slug",
      "--agent  the external Agent's name",
      "--profile  where to save the key (default: <workspace>-<agent>)",
      "--no-browser  do not offer to open the approval page",
      "--no-wait  print the approval link and code, save the sign-in, and exit",
      "--resume  continue a sign-in saved by --no-wait",
    ],
    guidance:
      "A signed-in owner or admin approves the printed code in the browser. Signing in again for the same Agent replaces the profile's key and revokes the old one.",
    example:
      "coforge agent login --server https://coforge.example --workspace acme --agent builder",
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
