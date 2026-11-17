import { expect, test } from "bun:test";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { acpApplyRuntimeConfig } from "#src/acp/config-options";
import type { AcpConnection } from "#src/acp/connection";
import { RuntimeModelNotFoundError } from "#src/contract";

const select = (
  id: string,
  category: string,
  currentValue: string,
  values: string[],
): SessionConfigOption => ({
  id,
  name: id,
  category,
  type: "select",
  currentValue,
  options: values.map((value) => ({ value, name: value })),
});

const EFFORTS: Record<string, string[]> = { fast: [], deep: ["low", "high"], default: [] };

function server(model = "fast", effort?: string, applies = true, listsDefault = false) {
  const state = { model, effort };
  const calls: string[] = [];
  const options = () => [
    select("model", "model", state.model, ["fast", "deep", ...(listsDefault ? ["default"] : [])]),
    ...(EFFORTS[state.model]!.length
      ? [select("effort", "thought_level", state.effort ?? "low", EFFORTS[state.model]!)]
      : []),
  ];
  const transport = {
    connection: {
      agent: {
        request: async (method: string, params: { configId: string; value: string }) => {
          calls.push(`${params.configId}=${params.value}`);
          if (applies && params.configId === "model") state.model = params.value;
          if (applies && params.configId === "effort") state.effort = params.value;
          return { configOptions: options() };
        },
      },
    },
  } as unknown as AcpConnection;
  const target = {
    transport,
    sessionId: "s",
    timeoutMs: 1000,
    timedOut: "timed out",
    label: "Fake",
  };
  return { calls, options, target };
}

test("applies the model, then the effort the new model offers", async () => {
  const fake = server();
  const config = await acpApplyRuntimeConfig(fake.target, fake.options(), {
    model: "deep",
    reasoning: "high",
  });
  expect(fake.calls).toEqual(["model=deep", "effort=high"]);
  expect(config.find((entry) => entry.id === "effort")?.currentValue).toBe("high");
});

test("a value the session already holds is not sent again", async () => {
  const fake = server("deep", "high");
  await acpApplyRuntimeConfig(fake.target, fake.options(), { model: "deep", reasoning: "high" });
  expect(fake.calls).toEqual([]);
});

test("the default model and a model with no effort select leave the session alone", async () => {
  const fake = server();
  await acpApplyRuntimeConfig(fake.target, fake.options(), { model: "default", reasoning: "high" });
  expect(fake.calls).toEqual([]);
});

test("a server that lists a model named default gets it applied", async () => {
  const fake = server("fast", undefined, true, true);
  await acpApplyRuntimeConfig(fake.target, fake.options(), { model: "default" });
  expect(fake.calls).toEqual(["model=default"]);
});

test("an unoffered model is model-not-found, an unoffered effort fails the launch", async () => {
  const fake = server();
  await expect(
    acpApplyRuntimeConfig(fake.target, fake.options(), { model: "gone" }),
  ).rejects.toBeInstanceOf(RuntimeModelNotFoundError);
  await expect(
    acpApplyRuntimeConfig(fake.target, fake.options(), { model: "deep", reasoning: "max" }),
  ).rejects.toThrow("Fake does not offer effort max for this model");
});

test("a server with no model select gets the runtime's upgrade hint", async () => {
  const fake = server();
  await expect(
    acpApplyRuntimeConfig({ ...fake.target, missingModel: "upgrade fake" }, [], { model: "deep" }),
  ).rejects.toThrow("upgrade fake");
});

test("a value the server answers without applying fails the launch", async () => {
  const fake = server("fast", undefined, false);
  await expect(
    acpApplyRuntimeConfig(fake.target, fake.options(), { model: "deep" }),
  ).rejects.toThrow("Fake did not apply model deep");
});
