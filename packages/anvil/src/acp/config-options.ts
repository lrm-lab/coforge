import {
  RequestError,
  type SessionConfigOption,
  type SessionConfigSelectOption,
} from "@agentclientprotocol/sdk";
import { RuntimeModelNotFoundError } from "#src/contract";
import { asRecord } from "#src/json-record";
import { acpBounded, type AcpConnection } from "./connection";

export function acpConfigOptions(response: unknown): SessionConfigOption[] {
  const config = asRecord(response)?.configOptions;
  return Array.isArray(config) ? (config as SessionConfigOption[]) : [];
}

export function acpSelectEntries(
  option: SessionConfigOption | undefined,
): SessionConfigSelectOption[] {
  if (option?.type !== "select") return [];
  return option.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
}

export function acpSelectValues(option: SessionConfigOption | undefined): string[] {
  return acpSelectEntries(option).map((entry) => entry.value);
}

export type AcpModelEfforts = { values: string[]; current: string };

export async function acpReadModelEfforts(
  transport: AcpConnection,
  sessionId: string,
  model: SessionConfigOption,
  modelId: string,
  timeoutMs: number,
  timedOut: string,
): Promise<AcpModelEfforts> {
  let config: SessionConfigOption[];
  try {
    config = acpConfigOptions(
      await acpBounded(
        transport.connection.agent.request("session/set_config_option", {
          sessionId,
          configId: model.id,
          value: modelId,
        }),
        timeoutMs,
        timedOut,
      ),
    );
  } catch (error) {
    if (error instanceof RequestError) return { values: [], current: "" };
    throw error;
  }
  if (!config.some((entry) => entry.id === model.id && entry.currentValue === modelId))
    return { values: [], current: "" };
  const effort = config.find((entry) => entry.category === "thought_level");
  const values = acpSelectValues(effort);
  const current = typeof effort?.currentValue === "string" ? effort.currentValue : "";
  return { values, current: values.includes(current) ? current : "" };
}

export type AcpRuntimeConfigTarget = Readonly<{
  transport: AcpConnection;
  sessionId: string;
  timeoutMs: number;
  timedOut: string;
  label: string;
  missingModel?: string;
}>;

export async function acpApplyRuntimeConfig(
  target: AcpRuntimeConfigTarget,
  initial: readonly SessionConfigOption[],
  runtime: Readonly<{ model?: string; reasoning?: string }> | undefined,
): Promise<SessionConfigOption[]> {
  let config = [...initial];
  const apply = async (option: SessionConfigOption, value: string) => {
    if (option.currentValue === value) return;
    config = acpConfigOptions(
      await acpBounded(
        target.transport.connection.agent.request("session/set_config_option", {
          sessionId: target.sessionId,
          configId: option.id,
          value,
        }),
        target.timeoutMs,
        target.timedOut,
      ),
    );
    if (!config.some((entry) => entry.id === option.id && entry.currentValue === value))
      throw new Error(`${target.label} did not apply ${option.id} ${value}`);
  };
  const model = runtime?.model;
  const option = config.find((entry) => entry.id === "model" || entry.category === "model");
  const offered = acpSelectValues(option);
  if (model && (model !== "default" || offered.includes(model))) {
    if (!option) {
      if (target.missingModel) throw new Error(target.missingModel);
      throw new RuntimeModelNotFoundError(model);
    }
    if (!offered.includes(model)) throw new RuntimeModelNotFoundError(model);
    await apply(option, model);
  }
  const reasoning = runtime?.reasoning;
  const effort = config.find((entry) => entry.category === "thought_level");
  if (!reasoning || !effort) return config;
  if (!acpSelectValues(effort).includes(reasoning))
    throw new Error(`${target.label} does not offer ${effort.id} ${reasoning} for this model`);
  await apply(effort, reasoning);
  return config;
}
