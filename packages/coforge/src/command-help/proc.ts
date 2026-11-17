import type { HelpEntry } from "./entry";

export const procHelp: Readonly<Record<string, HelpEntry>> = {
  proc: {
    syntax: "coforge proc start|list|logs|stop ...",
    example: "coforge proc start --name dev -- bun run dev",
  },
  "proc start": {
    syntax:
      "coforge proc start [--name <name>] [--cwd <dir>] [--env KEY=VALUE]... [--json] [--] <command> [args...]",
    guidance:
      "Starts a detached background process managed per Agent (limit: 8 running jobs per Agent). Logs go to proc-logs/<name>.log inside the Agent workspace with 20 MiB rotation; transient CoForge launch tokens are stripped.",
    example: "coforge proc start --name api --cwd apps/api --env PORT=3000 -- bun run dev",
  },
  "proc list": {
    syntax: "coforge proc list [--json]",
    example: "coforge proc list --json",
  },
  "proc logs": {
    syntax: "coforge proc logs <name> [--tail <lines>] [--follow] [--json]",
    example: "coforge proc logs api --tail 100",
  },
  "proc stop": {
    syntax: "coforge proc stop (<name> | --all) [--force] [--json]",
    example: "coforge proc stop api",
  },
};
