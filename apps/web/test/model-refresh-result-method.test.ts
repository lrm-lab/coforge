import { describe, expect, test } from "bun:test";
import { createDaemonRuntimeProviderModelRefreshResultMethod } from "#src/server/centrifugo/model-refresh-result-method.server";
import { encodeDaemonRuntimeProviderModelRefreshResponse } from "@lrm/coforge-sdk/internal";

const principal = (agentId?: string) => ({
  userId: "user-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId,
});

describe("Daemon model refresh result method", () => {
  test("accepts the Daemon's terminal reply for a refresh it performed", async () => {
    const accepted: unknown[] = [];
    const method = createDaemonRuntimeProviderModelRefreshResultMethod({
      async accept(result) {
        accepted.push(result);
      },
    });
    const payload = encodeDaemonRuntimeProviderModelRefreshResponse({
      protocolMajor: 1,
      requestId: "refresh-1",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      accepted: true,
      results: [
        {
          provider: "codex",
          status: "refreshed",
          catalog: { provider: "codex", models: [] },
        },
      ],
    });

    expect(await method(payload, { principal: principal() })).toBeInstanceOf(Uint8Array);
    expect(accepted).toEqual([
      expect.objectContaining({
        requestId: "refresh-1",
        results: [
          {
            provider: "codex",
            status: "refreshed",
            catalog: { provider: "codex", models: [] },
          },
        ],
      }),
    ]);
  });

  test("accepts a refresh error reply", async () => {
    const accepted: unknown[] = [];
    const method = createDaemonRuntimeProviderModelRefreshResultMethod({
      async accept(result) {
        accepted.push(result);
      },
    });
    const payload = encodeDaemonRuntimeProviderModelRefreshResponse({
      protocolMajor: 1,
      requestId: "refresh-2",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      accepted: false,
      results: [],
    });

    expect(await method(payload, { principal: principal() })).toBeInstanceOf(Uint8Array);
    expect(accepted).toEqual([
      expect.objectContaining({ requestId: "refresh-2", accepted: false, results: [] }),
    ]);
  });

  test("rejects a principal from another Computer", async () => {
    const method = createDaemonRuntimeProviderModelRefreshResultMethod();
    const payload = encodeDaemonRuntimeProviderModelRefreshResponse({
      protocolMajor: 1,
      requestId: "refresh-3",
      workspaceId: "workspace-1",
      computerId: "computer-2",
      accepted: true,
      results: [],
    });

    expect(await method(payload, { principal: principal() })).toEqual({
      code: 403,
      message: "daemon runtime identity is not authorized",
    });
  });

  test("rejects an invalid reply", async () => {
    const method = createDaemonRuntimeProviderModelRefreshResultMethod();
    const payload = encodeDaemonRuntimeProviderModelRefreshResponse({
      protocolMajor: 2,
      requestId: "",
      workspaceId: "workspace-1",
      computerId: "computer-1",
      accepted: true,
      results: [],
    });

    expect(await method(payload, { principal: principal() })).toEqual({
      code: 400,
      message: "invalid model refresh result",
    });
  });
});
