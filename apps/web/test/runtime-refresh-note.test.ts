import { expect, test } from "bun:test";
import { RUNTIME_CATALOG_AUTH_REQUIRED_DIAGNOSTIC } from "@lrm/coforge-sdk/internal";
import { runtimeUnavailableReason } from "#src/features/computers/runtime-unavailable-reason";
import { paraglideMiddleware } from "#src/paraglide/server";
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

test.each([
  [
    "en",
    "Sign in on this Computer or check your Devin account permissions",
    "Could not read its version",
  ],
  ["zh-CN", "请在这台电脑上登录 Devin，或检查账号权限", "无法读取版本"],
] as const)(
  "Devin's refresh distinguishes login failures from version failures in %s",
  async (locale, auth, version) => {
    const result = await paraglideMiddleware(
      new Request(`http://localhost/${locale}/settings`),
      () =>
        Response.json({
          auth: runtimeUnavailableReason("probe_failed", RUNTIME_CATALOG_AUTH_REQUIRED_DIAGNOSTIC),
          version: runtimeUnavailableReason("probe_failed", "version probe diagnostic"),
        }),
    );
    expect(await result.json()).toEqual({ auth, version: `${version} (version probe diagnostic)` });
  },
);
