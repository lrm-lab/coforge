import { describe, expect, test } from "bun:test";
import { createComputerUpgradeResultMethod } from "#src/server/centrifugo/computer-upgrade-result-method.server";
import { encodeComputerUpgradeResult } from "@lrm/coforge-sdk/internal";

const principal = (agentId?: string) => ({
  userId: "user-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId,
});

const upgradeResultPayload = (
  value: Partial<Parameters<typeof encodeComputerUpgradeResult>[0]> = {},
) =>
  encodeComputerUpgradeResult({
    protocolMajor: 1,
    requestId: "operation-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    status: "failed",
    completedAtMs: 1_700_000_000_000,
    error: "candidate failed",
    ...value,
  });

describe("Computer upgrade result method", () => {
  test("records the Daemon's terminal report and answers with the acknowledgement", async () => {
    const reported: unknown[] = [];
    const method = createComputerUpgradeResultMethod({
      reported: async (scope, result) => {
        reported.push([scope, result]);
      },
    });

    const reply = await method(upgradeResultPayload(), { principal: principal() });

    expect(reply).toBeInstanceOf(Uint8Array);
    expect(reported).toEqual([
      [
        { workspaceId: "workspace-1", computerId: "computer-1" },
        {
          requestId: "operation-1",
          status: "failed",
          completedAtMs: 1_700_000_000_000,
          error: "candidate failed",
        },
      ],
    ]);
  });

  test("carries the Daemon's error code through to the store", async () => {
    const reported: unknown[] = [];
    const method = createComputerUpgradeResultMethod({
      reported: async (scope, result) => {
        reported.push([scope, result]);
      },
    });

    await method(upgradeResultPayload({ errorCode: "UPGRADE_OPERATION_PENDING" }), {
      principal: principal(),
    });

    expect(reported).toEqual([
      [
        { workspaceId: "workspace-1", computerId: "computer-1" },
        {
          requestId: "operation-1",
          status: "failed",
          completedAtMs: 1_700_000_000_000,
          error: "candidate failed",
          errorCode: "UPGRADE_OPERATION_PENDING",
        },
      ],
    ]);
  });

  test("refuses a report for another Computer and an undecodable payload", async () => {
    const method = createComputerUpgradeResultMethod({
      reported: async () => {
        throw new Error("must not be called");
      },
    });

    expect(
      await method(upgradeResultPayload(), {
        principal: { ...principal(), computerId: "computer-2" },
      }),
    ).toMatchObject({ code: 403 });
    expect(await method(new Uint8Array([1, 2, 3]), { principal: principal() })).toEqual({
      code: 400,
      message: "invalid Computer upgrade result",
    });
  });

  test("a store failure is a retryable error, never a silent acknowledgement", async () => {
    const method = createComputerUpgradeResultMethod({
      reported: async () => {
        throw new Error("redis unavailable");
      },
    });

    expect(await method(upgradeResultPayload(), { principal: principal() })).toMatchObject({
      code: 503,
    });
  });
});
