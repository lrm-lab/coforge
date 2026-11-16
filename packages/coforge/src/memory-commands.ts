import {
  decodePlatformMemoryCommand,
  type PlatformMemoryCommand,
  type PlatformMemoryResult,
} from "@lrm/coforge-sdk/agent";

export const MEMORY_COMMAND_HELP = `coforge memory status
coforge memory list [--scope agent|team] [--page 1] [--index]
coforge memory search --query <question> [--scope agent|team] [--index]
coforge memory get --id <uuid>
coforge memory create --title <title> --content <text> [--kind fact|experience|preference] [--scope agent|team]
coforge memory update --id <uuid> --revision <number> --title <title> --content <text> [--kind fact|experience|preference]
coforge memory delete|share --id <uuid> --revision <number>
Writes accept --request-id <uuid> for identical retries and --source-message-id <uuid> for provenance.
--index omits memory bodies and shows their character counts; use get --id <uuid> to read one in full.
Agent memory is private. Use share only when explicitly publishing it to the team.`;

export function parseMemoryArgs(args: readonly string[]): {
  request: PlatformMemoryCommand;
  index?: true;
} {
  const operation = args[0];
  let index = false;
  const flags = new Map<string, string>();
  const allowed = new Set([
    "scope",
    "page",
    "query",
    "id",
    "revision",
    "title",
    "content",
    "kind",
    "request-id",
    "source-message-id",
    "expires-at",
  ]);
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--json") continue;
    if (flag === "--index" && (operation === "list" || operation === "search")) {
      index = true;
      continue;
    }
    const key = flag.slice(2);
    if (!flag.startsWith("--") || !allowed.has(key) || flags.has(key) || args[i + 1] === undefined)
      throw new Error(MEMORY_COMMAND_HELP);
    flags.set(key, args[++i]!);
  }
  const row: Record<string, unknown> = { operation };
  for (const [key, value] of flags) {
    const name = key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    row[name] = key === "revision" || key === "page" ? Number(value) : value;
  }
  if (operation === "create") row.scope ??= "agent";
  if (operation === "create" || operation === "update") row.kind ??= "fact";
  if (["create", "update", "delete", "share"].includes(operation ?? ""))
    row.requestId ??= crypto.randomUUID();
  return { request: decodePlatformMemoryCommand(row), ...(index ? { index: true } : {}) };
}

export async function runMemoryCommand(
  args: readonly string[],
  call?: (request: PlatformMemoryCommand) => Promise<PlatformMemoryResult>,
): Promise<string> {
  if (args.includes("--help")) return MEMORY_COMMAND_HELP;
  if (!call) throw new Error("Memory transport is unavailable; upgrade this Computer");
  const { request, index } = parseMemoryArgs(args);
  const result = await call(request);
  return JSON.stringify(
    index
      ? {
          ...result,
          entries: result.entries.map(({ content, ...entry }) => ({
            ...entry,
            contentChars: content.length,
          })),
        }
      : result,
    null,
    2,
  );
}
