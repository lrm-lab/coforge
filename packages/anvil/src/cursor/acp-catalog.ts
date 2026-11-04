import {
  RUNTIME_PROVIDER,
  type CodeAgentModelCatalog,
  diagnosticErrorCode,
} from "@lrm/coforge-sdk/internal";
import { getLogger } from "@logtape/logtape";
import { catalogErrorMessage, within } from "#src/catalog-discovery";
import { acpBounded, acpProcess, type AcpConnection } from "#src/acp/connection";
import { scrubStderrHint } from "#src/stderr-hint";
import { asRecord } from "#src/json-record";
import { CURSOR_ACP_PROFILE } from "./acp-session";
import type { CursorAcpRuntimeHost } from "./acp-host";
import { assertCursorAcpVersionSupported } from "./acp-version";
import { cursorModelCatalog } from "./model-variants";

const logger = getLogger(["coforge", "daemon", "code-agent", RUNTIME_PROVIDER.CURSOR]);

/** A probe session is a full launch: process spawn, `initialize`, `session/new`. */
export const CURSOR_ACP_CATALOG_TIMEOUT_MS = 60_000;

/** The model catalog the server itself offers: `session/new`'s `models.availableModels` list —
 * base names become catalog ids and each variant's effort parameter fills `reasoningEfforts`.
 * Verified on cursor-agent 2026.10.22. */
export async function discoverCursorAcpCatalog(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  host: CursorAcpRuntimeHost,
  timeoutMs = CURSOR_ACP_CATALOG_TIMEOUT_MS,
): Promise<CodeAgentModelCatalog | undefined> {
  let transport: AcpConnection | undefined;
  let sessionId: string | undefined;
  let stderrHint: string | undefined;
  try {
    // The version gate runs before the server spawns: a below-floor cursor-agent is an upgrade
    // prompt, not a failed ACP launch.
    await assertCursorAcpVersionSupported(command, host.versionReader);
    transport = acpProcess(CURSOR_ACP_PROFILE, {
      command,
      cwd,
      environment: { ...environment, PWD: cwd },
      clientInfo: host.clientInfo,
      processTreeSpawner: host.processTreeSpawner,
      onStderr: (line) => {
        if (stderrHint === undefined && line.trim()) stderrHint = scrubStderrHint(line);
      },
    });
    await transport.initialize(timeoutMs);
    const session = await within(
      transport.connection.agent.request("session/new", { cwd, mcpServers: [] }),
      timeoutMs,
    );
    sessionId = session.sessionId;
    // `models` is cursor's own block on the session envelope, beyond the SDK type.
    const modelsRecord = asRecord(asRecord(session)?.models);
    const available = modelsRecord?.availableModels;
    const currentModelId = modelsRecord?.currentModelId;
    const models = cursorModelCatalog(
      Array.isArray(available) ? available : [],
      typeof currentModelId === "string" ? currentModelId : undefined,
    );
    if (models.length === 0) throw new Error("cursor-agent acp model catalog unavailable");
    return { provider: RUNTIME_PROVIDER.CURSOR, models };
  } catch (error) {
    logger.warn("code_agent_catalog:discovery_failed", {
      provider: RUNTIME_PROVIDER.CURSOR,
      error_code: diagnosticErrorCode(error),
      error_message: catalogErrorMessage(error),
      ...(stderrHint ? { stderr_hint: stderrHint } : {}),
    });
    return undefined;
  } finally {
    if (transport && sessionId && !transport.closed) {
      // Try to delete the probe's untitled session: a plain close may leave it in the user's
      // history. Unverified whether 2026.10.22 implements it — a `-32601` is caught.
      await acpBounded(
        transport.connection.agent.request("session/delete", { sessionId }),
        timeoutMs,
        "cursor-agent acp session/delete timed out",
      ).catch(() => undefined);
    }
    if (transport) await transport.dispose().catch(() => {});
  }
}
