import { type RuntimeMetadata } from "@lrm/coforge-sdk/internal";
import { processSpawner } from "#src/code-agent/process-host";
import { agentEnvironment } from "./environment";
import { JsonlProcess } from "@lrm/coforge-anvil/execution";
import { JsonlRequestError, catalogErrorMessage, asRecord } from "@lrm/coforge-anvil";
import { getLogger } from "@logtape/logtape";
import { diagnosticErrorCode } from "@lrm/coforge-sdk/internal";

const logger = getLogger(["coforge", "daemon", "runtime-inventory"]);

export type CatalogProgress = {
  stage:
    | "spawn"
    | "initialize"
    | "initialized"
    | "model/list"
    | "get_available_models"
    | "decode_catalog";
};

export async function withJsonlProcess<T>(
  provider: RuntimeMetadata["provider"],
  command: readonly string[],
  cwd: string,
  discover: (process: JsonlProcess, progress: CatalogProgress) => Promise<T>,
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): Promise<T | undefined> {
  const startedAt = performance.now();
  const discoveryId = crypto.randomUUID();
  const progress: CatalogProgress = { stage: "spawn" };
  let process: JsonlProcess | undefined;
  logger.info("Code Agent model catalog discovery started", {
    event: "code_agent_catalog:discovery_started",
    discovery_id: discoveryId,
    provider,
    stage: progress.stage,
    outcome: "started",
  });
  try {
    process = new JsonlProcess(
      command,
      cwd,
      agentEnvironment(undefined, environment),
      processSpawner,
    );
    const catalog = await discover(process, progress);
    logger.info("Code Agent model catalog discovery completed", {
      event: "code_agent_catalog:discovery_completed",
      discovery_id: discoveryId,
      provider,
      elapsed_ms: Math.round(performance.now() - startedAt),
      outcome: "ok",
    });
    return catalog;
  } catch (error) {
    logger.warning("Code Agent model catalog discovery failed", {
      event: "code_agent_catalog:discovery_failed",
      provider,
      discovery_id: discoveryId,
      stage: progress.stage,
      elapsed_ms: Math.round(performance.now() - startedAt),
      error_code: diagnosticErrorCode(error),
      error_message: catalogErrorMessage(error),
      provider_error_code:
        error instanceof JsonlRequestError &&
        typeof asRecord(error.responseError)?.code === "number"
          ? asRecord(error.responseError)?.code
          : undefined,
      outcome: "unavailable",
    });
    // Preserve spawn failures reaching the caller; only an established probe
    // may fall back to an unavailable catalog.
    if (!process) throw error;
    return undefined;
  } finally {
    if (process) {
      const cleanupStartedAt = performance.now();
      logger.info("Code Agent model catalog cleanup started", {
        event: "code_agent_catalog:cleanup_started",
        discovery_id: discoveryId,
        provider,
        outcome: "started",
      });
      try {
        await process.dispose();
        logger.info("Code Agent model catalog cleanup completed", {
          event: "code_agent_catalog:cleanup_completed",
          discovery_id: discoveryId,
          provider,
          elapsed_ms: Math.round(performance.now() - cleanupStartedAt),
          outcome: "ok",
        });
      } catch (error) {
        logger.warning("Code Agent model catalog cleanup failed", {
          event: "code_agent_catalog:cleanup_failed",
          discovery_id: discoveryId,
          provider,
          elapsed_ms: Math.round(performance.now() - cleanupStartedAt),
          error_code: diagnosticErrorCode(error),
          error_message: catalogErrorMessage(error),
          outcome: "failed",
        });
      }
    }
  }
}
