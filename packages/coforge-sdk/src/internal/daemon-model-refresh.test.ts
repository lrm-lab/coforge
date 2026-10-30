import { expect, test } from "bun:test";
import {
  encodeDaemonRuntimeProviderModelRefreshRequest,
  decodeDaemonRuntimeProviderModelRefreshRequest,
  encodeDaemonRuntimeProviderModelRefreshResponse,
  decodeDaemonRuntimeProviderModelRefreshResponse,
} from "./codec";
import { MODEL_REFRESH_MESSAGE_TYPE, MODEL_REFRESH_RESPONSE_MESSAGE_TYPE } from "./index";

function refreshRequest() {
  return {
    protocolMajor: 1,
    requestId: "refresh-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    provider: "dsh" as const,
    messageType: MODEL_REFRESH_MESSAGE_TYPE,
  };
}

test("model refresh request round-trips with its provider", () => {
  expect(
    decodeDaemonRuntimeProviderModelRefreshRequest(
      encodeDaemonRuntimeProviderModelRefreshRequest(refreshRequest()),
    ),
  ).toEqual(refreshRequest());
});

test("a refresh request naming an unknown provider is refused at the codec", () => {
  expect(() =>
    decodeDaemonRuntimeProviderModelRefreshRequest(
      encodeDaemonRuntimeProviderModelRefreshRequest({
        ...refreshRequest(),
        provider: "not-a-runtime" as never,
      }),
    ),
  ).toThrow();
});

test("model refresh response round-trips one outcome per provider", () => {
  const { provider: _requestedProvider, ...envelope } = refreshRequest();
  const message = {
    ...envelope,
    accepted: true,
    results: [
      {
        provider: "dsh" as const,
        status: "refreshed" as const,
        catalog: {
          provider: "dsh" as const,
          models: [
            {
              id: '["deepseek-official","deepseek-v4-flash"]',
              displayName: "deepseek-v4-flash",
              description: "",
              modelProvider: "",
              reasoningEfforts: ["low", "high"],
              defaultReasoning: "high",
              recommended: true,
            },
          ],
        },
      },
      {
        provider: "codex" as const,
        status: "error" as const,
        code: "start_failed" as const,
        diagnostic: "missing shim",
      },
    ],
    messageType: MODEL_REFRESH_RESPONSE_MESSAGE_TYPE,
  };
  expect(
    decodeDaemonRuntimeProviderModelRefreshResponse(
      encodeDaemonRuntimeProviderModelRefreshResponse(message),
    ),
  ).toEqual(message);
});

test("an unaccepted refresh answer still carries the per-provider failure", () => {
  const { provider: _requestedProvider, ...envelope } = refreshRequest();
  const decoded = decodeDaemonRuntimeProviderModelRefreshResponse(
    encodeDaemonRuntimeProviderModelRefreshResponse({
      ...envelope,
      accepted: false,
      results: [{ provider: "dsh" as const, status: "error" as const, code: "unknown" as const }],
    }),
  );
  expect(decoded).toMatchObject({
    accepted: false,
    results: [{ provider: "dsh", status: "error", code: "unknown" }],
  });
});
