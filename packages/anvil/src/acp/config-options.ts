import {
  RequestError,
  type SessionConfigOption,
  type SessionConfigSelectOption,
} from "@agentclientprotocol/sdk";
import { RuntimeModelNotFoundError } from "#src/contract";
import { asRecord, nonEmptyString } from "#src/json-record";
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

function hasConfigState(option: SessionConfigOption): boolean {
  const state = asRecord(option);
  if (!nonEmptyString(state?.id) || !nonEmptyString(state?.name)) return false;
  if (state?.id === "thought_level" && state.category !== "thought_level") return false;
  if (option.type === "boolean") return typeof option.currentValue === "boolean";
  if (option.type !== "select") return false;
  const values = acpSelectValues(option);
  return (
    values.every((value) => typeof value === "string" && value.length > 0) &&
    values.includes(option.currentValue)
  );
}

export function acpModelEfforts(
  config: readonly SessionConfigOption[],
  configId: string,
  modelId: string,
): AcpModelEfforts | undefined {
  const selected = config.find((entry) => asRecord(entry)?.id === configId);
  if (selected?.type !== "select" || selected.currentValue !== modelId) return undefined;
  const effort = config.find((entry) => asRecord(entry)?.category === "thought_level");
  try {
    if (!effort) return config.every(hasConfigState) ? { values: [], current: "" } : undefined;
    if (effort.type !== "select") return undefined;
    const values = acpSelectValues(effort);
    if (
      !values.includes(effort.currentValue) ||
      !values.every((value) => typeof value === "string" && value.length > 0)
    )
      return undefined;
    return { values, current: effort.currentValue };
  } catch {
    return undefined;
  }
}

export async function acpReadModelEfforts(
  transport: AcpConnection,
  sessionId: string,
  model: SessionConfigOption,
  modelId: string,
  timeoutMs: number,
  timedOut: string,
): Promise<AcpModelEfforts | undefined> {
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
    if (error instanceof RequestError) return undefined;
    throw error;
  }
  return acpModelEfforts(config, model.id, modelId);
}

export type AcpRuntimeConfigTarget = Readonly<{
  transport: AcpConnection;
  sessionId: string;
  timeoutMs: number;
  timedOut: string;
  label: string;
  missingModel?: string;
  verifyModelAfterEffort?: boolean;
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
  const modelOption = (entry: SessionConfigOption) =>
    entry.id === "model" || entry.category === "model";
  const model = runtime?.model;
  const option = config.find(modelOption);
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
  const selectedModel = target.verifyModelAfterEffort ? config.find(modelOption) : undefined;
  await apply(effort, reasoning);
  if (
    selectedModel?.type === "select" &&
    config.find(modelOption)?.currentValue !== selectedModel.currentValue
  )
    throw new Error(`${target.label} changed the model while applying ${effort.id}`);
  return config;
}
