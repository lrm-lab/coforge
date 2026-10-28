import {
  RUNTIME_PROVIDER,
  type CodeAgentModelCatalog,
  diagnosticErrorCode,
} from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { catalogErrorMessage, within } from "#src/catalog-discovery";
import { scrubStderrHint } from "#src/stderr-hint";
import { DevinConnection, devinBounded } from "./connection";
import type { DevinRuntimeHost } from "./host";

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.DEVIN]);

/** `devin acp` plus `session/new` is not a text-command catalog; a cold CLI can take a while. */
export const DEVIN_CATALOG_TIMEOUT_MS = 30_000;

/**
 * The model list is `session/new`'s `model` select, exactly as `devin acp` reports it: every
 * variant (the variant name already carries its effort and priority). Effort choices
 * (`thought_level`) depend on the selected model and are applied by a session, not listed here.
 */
export async function discoverDevinCatalog(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  host: DevinRuntimeHost,
  timeoutMs = DEVIN_CATALOG_TIMEOUT_MS,
): Promise<CodeAgentModelCatalog | undefined> {
  let transport: DevinConnection | undefined;
  let sessionId: string | undefined;
  // A CLI argument error is not a secret; still, only the first scrubbed, bounded line is kept.
  let stderrHint: string | undefined;
  try {
    transport = new DevinConnection(
      command,
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
    if (!sessionId.trim()) throw new Error("Devin model catalog unavailable");
    const config = await transport.waitForConfig(
      sessionId,
      session.configOptions ?? [],
      "model",
      timeoutMs,
    );
    const option = config.find((entry) => entry.category === "model");
    if (option?.type !== "select") throw new Error("Devin model catalog unavailable");
    const entries = option.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
    const models = entries.flatMap((entry) => {
      if (!entry.value) return [];
      return [
        {
          id: entry.value,
          displayName: entry.name,
          description: entry.description ?? "",
          modelProvider: "",
          reasoningEfforts: [],
          defaultReasoning: "",
          recommended: entry.value === option.currentValue,
        },
      ];
    });
    if (models.length === 0) throw new Error("Devin model catalog unavailable");
    return { provider: RUNTIME_PROVIDER.DEVIN, models };
  } catch (error) {
    logger.warning("Devin model discovery unavailable", {
      event: "devin.catalog.unavailable",
      error_code: diagnosticErrorCode(error),
      error_message: catalogErrorMessage(error),
      ...(stderrHint ? { stderr_hint: stderrHint } : {}),
    });
    return undefined;
  } finally {
    // A process that already exited cannot answer session/close. Waiting on that RPC
    // would hold the whole inventory refresh for another full timeout.
    if (transport && sessionId && !transport.closed) {
      await devinBounded(
        transport.connection.agent.request("session/close", { sessionId }),
        timeoutMs,
      ).catch(() => undefined);
    }
    // Discovery reports "unavailable", never a rejection, even when cleanup fails.
    await transport?.dispose().catch(() => undefined);
  }
}
