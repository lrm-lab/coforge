import {
  RequestError,
  type SessionConfigOption,
  type SessionConfigSelectOption,
} from "@agentclientprotocol/sdk";
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
