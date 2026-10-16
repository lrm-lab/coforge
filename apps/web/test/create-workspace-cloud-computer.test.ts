import { describe, expect, test } from "bun:test";

import { HostDirectoryError } from "#src/server/hosts/host-directory.server";
import { createWorkspaceAndStartCloudComputer } from "#src/server/workspaces/create-workspace.server";

const now = new Date("2026-10-16T01:00:00.000Z");
const input = { userId: "user-a", name: "Alpha", slug: "alpha", now };

describe("createWorkspaceAndStartCloudComputer", () => {
  test("a created workspace starts the account's default cloud computer for that workspace", async () => {
    const started: Array<{ userId: string; workspaceId: string }> = [];
    const workspace = await createWorkspaceAndStartCloudComputer(
      {
        createWorkspace: async () => ({ id: "ws-1", slug: "alpha", name: "Alpha", iconUrl: null }),
        startCloudComputer: async (request) => {
          started.push({ userId: request.userId, workspaceId: request.workspaceId });
        },
      },
      input,
    );

    expect(workspace).toMatchObject({ id: "ws-1", slug: "alpha" });
    expect(started).toEqual([{ userId: "user-a", workspaceId: "ws-1" }]);
  });

  test("a deployment without a cluster still returns the new workspace", async () => {
    const workspace = await createWorkspaceAndStartCloudComputer(
      {
        createWorkspace: async () => ({ id: "ws-1", slug: "alpha", name: "Alpha", iconUrl: null }),
        startCloudComputer: async () => {
          throw new HostDirectoryError(503, "cloud cluster is not configured");
        },
      },
      input,
    );

    expect(workspace.id).toBe("ws-1");
  });
});
