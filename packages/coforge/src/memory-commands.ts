import {
  parseTeamMemoryArgs,
  runTeamMemoryCommand,
  type TeamMemoryInvocation,
} from "./team-memory-commands";
import {
  decodeLocalMemoryCommand,
  type LocalMemoryCommand,
  type LocalMemoryResult,
} from "@lrm/coforge-sdk/agent";

export type MemoryInvocation =
  | { command: "memory"; scope?: "local"; request: LocalMemoryCommand; json: boolean }
  | TeamMemoryInvocation;

export function parseMemoryArgs(args: readonly string[]): MemoryInvocation {
  const scopeAt = args.indexOf("--scope");
  if (scopeAt !== -1) {
    const scope = args[scopeAt + 1];
    if (scope !== "team" && scope !== "local")
      throw new Error("memory scope must be local or team");
    const rest = [...args.slice(0, scopeAt), ...args.slice(scopeAt + 2)];
    if (rest.includes("--scope")) throw new Error("repeated memory scope");
    if (scope === "team") return parseTeamMemoryArgs(rest);
    args = rest;
  }
  const operation = args[0];
  const row: Record<string, unknown> = { operation };
  let json = false;
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]!;
    if (flag === "--json") {
      json = true;
      continue;
    }
    if (!flag.startsWith("--") || args[index + 1] === undefined)
      throw new Error("Usage: coforge memory search|get|save|archive|history --key <key> ...");
    const key = flag.slice(2);
    if (key in row) throw new Error(`repeated flag: ${flag}`);
    row[key] = key === "offset" ? Number(args[++index]) : args[++index];
  }
  if (operation === "save") {
    row.revision ??= "new";
    row.kind ??= "fact";
    row.applicability ??= "";
  }
  return { command: "memory", request: decodeLocalMemoryCommand(row), json };
}

export async function runMemoryCommand(
  invocation: MemoryInvocation,
  transport: {
    memory?(request: LocalMemoryCommand): Promise<LocalMemoryResult>;
    teamMemory?: Parameters<typeof runTeamMemoryCommand>[1]["teamMemory"];
  },
): Promise<string> {
  if (invocation.scope === "team") return runTeamMemoryCommand(invocation, transport);
  if (!transport.memory) throw new Error("Local memory requires an updated Computer");
  const result = await transport.memory(invocation.request);
  if (invocation.json) return JSON.stringify(result);
  return [
    ...result.entries.map(
      (entry) =>
        `${entry.title} [${entry.key}]\n${entry.content}\nSource: ${entry.source}\nApplies to: ${entry.applicability || "unspecified"}\nRevision: ${entry.revision}\nState: ${entry.status}\nFile: ${entry.path}`,
    ),
    ...(result.incomplete
      ? [
          `Search is incomplete.${result.nextOffset === undefined ? " Narrow the notes being searched." : ` Continue with --offset ${result.nextOffset}.`}`,
        ]
      : []),
    ...(result.entries.length === 0 && !result.incomplete ? ["No matching local memory."] : []),
  ].join("\n\n");
}
