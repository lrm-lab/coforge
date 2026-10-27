import { RequestError, type SessionConfigOption } from "@agentclientprotocol/sdk";
import { RuntimeModelNotFoundError } from "#src/contract";
import { within } from "#src/catalog-discovery";
import { JsonlRequestError } from "#src/jsonl-error";
import { COMMAND_CODE_CATALOG_TIMEOUT_MS } from "./catalog";
import { CommandCodeConnection, commandCodeBounded } from "./connection";
import type { CommandCodeRuntimeHost } from "./host";

/** Command Code's own `default` is the provider default. Callers store that as an empty string. */
const PROVIDER_DEFAULT_EFFORT = "default";
const EFFORT_VALUE_LIMIT = 16;
const EFFORT_VALUE_MAX_LENGTH = 64;

export type CommandCodeEffortFailureCode =
  | "model_missing"
  | "timeout"
  | "process_closed"
  | "rpc_error"
  | "unavailable";

/** `ready` with an empty list means this model has no effort control. `failed` is not that. */
export type CommandCodeEffortRead =
  | { status: "ready"; efforts: string[] }
  | { status: "failed"; code: CommandCodeEffortFailureCode };

/** Values of the current `thought_level` select, in CLI order, without `default`. */
export function commandCodeEffortValues(config: readonly SessionConfigOption[]): string[] {
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

function modelListed(config: readonly SessionConfigOption[], modelId: string): boolean {
  const option = config.find((entry) => entry.id === "model" || entry.category === "model");
  if (option?.type !== "select") return false;
  return option.options.some((entry) =>
    "value" in entry
      ? entry.value === modelId
      : entry.options.some((choice) => choice.value === modelId),
  );
}

function failureCode(error: unknown): CommandCodeEffortFailureCode {
  if (error instanceof RuntimeModelNotFoundError) return "model_missing";
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
 * Reads one model's effort choices. Opens `cmd acp` the way catalog discovery does (no `--mod`),
 * switches to that model once, and returns the `thought_level` values except `default`.
 * A model with no `thought_level` select is ready and empty. A missing model, a timeout, a closed
 * process, or an RPC error is a failure.
 */
export async function readCommandCodeReasoningEfforts(
  command: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string | undefined>>,
  host: CommandCodeRuntimeHost,
  modelId: string,
  timeoutMs = COMMAND_CODE_CATALOG_TIMEOUT_MS,
): Promise<CommandCodeEffortRead> {
  const selected = modelId.trim();
  if (
    !selected ||
    selected === "__proto__" ||
    selected === "constructor" ||
    selected === "prototype"
  )
    return { status: "failed", code: "model_missing" };
  let transport: CommandCodeConnection | undefined;
  let sessionId: string | undefined;
  try {
    transport = new CommandCodeConnection(
      command,
      undefined,
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
    if (!sessionId.trim()) return { status: "failed", code: "unavailable" };
    const config = await transport.waitForConfig(
      sessionId,
      session.configOptions ?? [],
      "model",
      timeoutMs,
    );
    if (!modelListed(config, selected)) return { status: "failed", code: "model_missing" };
    const configured = await commandCodeBounded(
      transport.connection.agent.request("session/set_config_option", {
        sessionId,
        configId: "model",
        value: selected,
      }),
      timeoutMs,
    );
    const next = configured.configOptions ?? [];
    if (!next.some((entry) => entry.id === "model" && entry.currentValue === selected))
      return { status: "failed", code: "unavailable" };
    return { status: "ready", efforts: commandCodeEffortValues(next) };
  } catch (error) {
    return { status: "failed", code: failureCode(error) };
  } finally {
    if (transport && sessionId && !transport.closed) {
      await commandCodeBounded(
        transport.connection.agent.request("session/close", { sessionId }),
        timeoutMs,
      ).catch(() => undefined);
    }
    await transport?.dispose();
  }
}
