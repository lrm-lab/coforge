import { expect, test } from "bun:test";
import {
  refreshLatestNoteKey,
  runtimeRefreshNote,
} from "#src/features/agents/runtime-refresh-note";

const catalog = (models: number) => ({
  provider: "pi" as const,
  models: Array.from({ length: models }, (_, index) => ({
    id: `model-${index}`,
    displayName: `Model ${index}`,
    modelProvider: "deepseek",
  })),
});

test("a refresh that finds only the models already listed says how many there are", () => {
  expect(runtimeRefreshNote({ status: "refreshed", catalog: catalog(2) } as never)).toEqual({
    kind: "latest",
    modelCount: 2,
  });
});

test("a failed refresh keeps the reason the Computer gave", () => {
  expect(
    runtimeRefreshNote({ status: "error", provider: "pi", code: "probe_failed" } as never),
  ).toEqual({ kind: "failed", code: "probe_failed", diagnostic: undefined });
});

test("a refresh that never answered is a plain failure, not a silent no-op", () => {
  expect(runtimeRefreshNote({ status: "timeout" })).toEqual({
    kind: "failed",
    code: undefined,
    diagnostic: undefined,
  });
});

test("only Pi's latest line says that Pi lists what this Computer is configured for", () => {
  expect(refreshLatestNoteKey("pi")).toBe("agent_form_model_refresh_latest_pi");
  expect(refreshLatestNoteKey("codex")).toBe("agent_form_model_refresh_latest");
});
