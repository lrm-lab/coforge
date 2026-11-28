import type {
  AgentCommandGuidanceRequest,
  AgentCommandGuidanceResponse,
} from "@lrm/coforge-sdk/agent";

const GUIDED_COMMANDS = new Set(["task", "action", "inbox"]);

/**
 * Queries the daemon's compaction-aware `AgentContextLedger` (`"guidance"`) for progressive
 * CLI hints without touching disk in `packages/coforge`. Pre-satisfies guidance on `--help`
 * and stays silent on `--json` or when the daemon is unreachable.
 */
export async function commandGuidanceLine(
  transport: {
    commandGuidance?: (
      request: AgentCommandGuidanceRequest,
    ) => Promise<AgentCommandGuidanceResponse>;
  },
  args: readonly string[],
): Promise<string | undefined> {
  if (args.includes("--json")) return undefined;
  const separator = args.indexOf("--");
  const ownArgs = separator === -1 ? args : args.slice(0, separator);
  const command = ownArgs.find((arg) => !arg.startsWith("-"));
  if (!command || !GUIDED_COMMANDS.has(command)) return undefined;
  const isHelp = ownArgs.includes("--help");
  try {
    const response = await transport.commandGuidance?.({
      operation: isHelp ? "satisfy" : "check",
      command,
    });
    if (isHelp) return undefined;
    return response?.guidance ?? undefined;
  } catch {
    return undefined;
  }
}
