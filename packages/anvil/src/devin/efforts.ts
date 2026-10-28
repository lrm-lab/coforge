import { RequestError, type SessionConfigOption } from "@agentclientprotocol/sdk";
import { within } from "#src/catalog-discovery";
import { JsonlRequestError } from "#src/jsonl-error";
import { DEVIN_CATALOG_TIMEOUT_MS } from "./catalog";
import { DevinConnection, devinBounded } from "./connection";
import type { DevinRuntimeHost } from "./host";

/** Devin's own `default` is the provider default. Callers store that as an empty string. */
const PROVIDER_DEFAULT_EFFORT = "default";
const EFFORT_VALUE_LIMIT = 16;
const EFFORT_VALUE_MAX_LENGTH = 64;

export type DevinEffortFailureCode = "timeout" | "process_closed" | "rpc_error" | "unavailable";

/** `ready` with an empty list means this model has no effort control. `failed` is not that. */
export type DevinEffortRead =
  | { status: "ready"; efforts: string[] }
  | { status: "failed"; code: DevinEffortFailureCode };

/** Values of the current `thought_level` select, in CLI order, without `default`. */
export function devinEffortValues(config: readonly SessionConfigOption[]): string[] {
  const effort = config.find((entry) => entry.category === "thought_level");
  if (effort?.type !== "select") return [];
  const values: string[] = [];
  for (const entry of effort.options) {
    const choices = "value" in entry ? [entry] : entry.options;
    for (const choice of choices) {
      const value = choice.value;
      if (!value || value === PROVIDER_DEFAULT_EFFORT || values.includes(value)) continue;
      if (value.length > EFFORT_VALUE_MAX_LENGTH) continue;
      if (values.length >= EFFORT_VALUE_LIMIT) return values;
      values.push(value);
    }
  }
  return values;
}

function failureCode(error: unknown): DevinEffortFailureCode {
  const message = error instanceof Error ? error.message : "";
  if (message.toLowerCase().includes("timed out")) return "timeout";
  if (
    message.includes("closed") ||
    message.includes("exited") ||
    message.includes("invalid output")
  )
    return "process_closed";
  if (error instanceof RequestError || error instanceof JsonlRequestError) return "rpc_error";
  return "unavailable";
}

/**
 * Reads each model's `thought_level` choices in one `devin acp` session: the model select comes
 * back with a `thought_level` select whose options depend on the model just applied, so one
 * `session/set_config_option model` per model returns every model's list. A model with no
 * `thought_level` select is ready and empty; a model the session refuses is a failure for that
 * model only. A dead process fails the models still unread.
 */
export async function readDevinModelEfforts(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  host: DevinRuntimeHost,
  modelIds: readonly string[],
  timeoutMs = DEVIN_CATALOG_TIMEOUT_MS,
): Promise<ReadonlyMap<string, DevinEffortRead>> {
  const reads = new Map<string, DevinEffortRead>();
  let transport: DevinConnection | undefined;
  let sessionId: string | undefined;
  try {
    transport = new DevinConnection(
      command,
      cwd,
      { ...host.buildCatalogEnvironment(environment), PWD: cwd },
      host,
    );
    await transport.initialize(timeoutMs);
    const session = await within(
      transport.connection.agent.request("session/new", { cwd, mcpServers: [] }),
      timeoutMs,
    );
    sessionId = session.sessionId;
    if (!sessionId.trim()) throw new Error("Devin effort discovery unavailable");
    for (const modelId of modelIds) {
      if (reads.has(modelId)) continue;
      try {
        const configured = await devinBounded(
          transport.connection.agent.request("session/set_config_option", {
            sessionId,
            configId: "model",
            value: modelId,
          }),
          timeoutMs,
        );
        const next = configured.configOptions ?? [];
        const applied = next.some(
          (entry) => entry.category === "model" && entry.currentValue === modelId,
        );
        reads.set(
          modelId,
          applied
            ? { status: "ready", efforts: devinEffortValues(next) }
            : { status: "failed", code: "unavailable" },
        );
      } catch (error) {
        if (transport.closed) throw error;
        reads.set(modelId, { status: "failed", code: failureCode(error) });
      }
    }
    return reads;
  } catch (error) {
    const failed: DevinEffortRead = { status: "failed", code: failureCode(error) };
    for (const modelId of modelIds) if (!reads.has(modelId)) reads.set(modelId, failed);
    return reads;
  } finally {
    if (transport && sessionId && !transport.closed) {
      await devinBounded(
        transport.connection.agent.request("session/close", { sessionId }),
        timeoutMs,
      ).catch(() => undefined);
    }
    await transport?.dispose();
  }
}
