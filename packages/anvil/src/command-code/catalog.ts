import {
  RUNTIME_PROVIDER,
  type CodeAgentModelCatalog,
  diagnosticErrorCode,
} from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { catalogErrorMessage, within } from "#src/catalog-discovery";
import { CommandCodeConnection, commandCodeBounded } from "./connection";
import type { CommandCodeRuntimeHost } from "./host";

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.COMMAND_CODE]);

/** Same budget as Kiro's config wait. `cmd acp` plus `session/new` is not a text-command catalog,
 * so the shared 5-second command budget is too small for a cold CLI. */
export const COMMAND_CODE_CATALOG_TIMEOUT_MS = 30_000;

export async function discoverCommandCodeCatalog(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  host: CommandCodeRuntimeHost,
  timeoutMs = COMMAND_CODE_CATALOG_TIMEOUT_MS,
): Promise<CodeAgentModelCatalog | undefined> {
  let transport: CommandCodeConnection | undefined;
  let sessionId: string | undefined;
  // A CLI argument error is not a secret; still, only the first scrubbed, bounded line is kept.
  let stderrHint: string | undefined;
  try {
    transport = new CommandCodeConnection(
      command,
      undefined,
      cwd,
      { ...host.buildCatalogEnvironment(environment), PWD: cwd },
      host,
    );
    transport.process.onStderr((line) => {
      if (stderrHint === undefined && line.trim()) stderrHint = scrubStderrHint(line);
    });
    await transport.initialize(timeoutMs);
    const session = await within(
      transport.connection.agent.request("session/new", { cwd, mcpServers: [] }),
      timeoutMs,
    );
    sessionId = session.sessionId;
    if (!sessionId.trim()) throw new Error("Command Code model catalog unavailable");
    const config = await transport.waitForConfig(
      sessionId,
      session.configOptions ?? [],
      "model",
      timeoutMs,
    );
    const option = config.find((entry) => entry.category === "model");
    if (option?.type !== "select") throw new Error("Command Code model catalog unavailable");
    const entries = option.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
    const models = entries.flatMap((entry) => {
      if (!entry.value) return [];
      return [
        {
          id: entry.value,
          displayName: entry.name,
          description: entry.description ?? "",
          modelProvider: "",
          // Effort options change after a model switch and are not on these entries.
          reasoningEfforts: [],
          defaultReasoning: "",
          recommended: entry.value === option.currentValue,
        },
      ];
    });
    if (models.length === 0) throw new Error("Command Code model catalog unavailable");
    return { provider: RUNTIME_PROVIDER.COMMAND_CODE, models };
  } catch (error) {
    logger.warning("Command Code model discovery unavailable", {
      event: "command-code.catalog.unavailable",
      error_code: diagnosticErrorCode(error),
      error_message: catalogErrorMessage(error),
      ...(stderrHint ? { stderr_hint: stderrHint } : {}),
    });
    return undefined;
  } finally {
    // A process that already exited cannot answer session/close. Waiting on that RPC
    // would hold the whole inventory refresh for another full timeout.
    if (transport && sessionId && !transport.closed) {
      await commandCodeBounded(
        transport.connection.agent.request("session/close", { sessionId }),
        timeoutMs,
      ).catch(() => undefined);
    }
    await transport?.dispose();
  }
}

function scrubStderrHint(line: string): string {
  return line
    .trim()
    .replace(/(?:sk|pk|api|token|key|secret)[_-]?[A-Za-z0-9_-]{8,}/gi, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 200);
}
