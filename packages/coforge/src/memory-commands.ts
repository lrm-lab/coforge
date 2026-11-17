import {
  decodeLocalMemoryCommand,
  type LocalMemoryCommand,
  type LocalMemoryResult,
} from "@lrm/coforge-sdk/agent";

export type MemoryInvocation = { command: "memory"; request: LocalMemoryCommand; json: boolean };

export function parseMemoryArgs(args: readonly string[]): MemoryInvocation {
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
  transport: { memory?(request: LocalMemoryCommand): Promise<LocalMemoryResult> },
): Promise<string> {
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
