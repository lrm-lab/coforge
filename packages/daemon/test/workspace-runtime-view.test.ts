import { describe, expect, test } from "bun:test";
import type { ManagedRuntimeIdentity } from "@lrm/coforge-sdk/internal";
import { workspaceRuntimeView, type ObservedBinding } from "#src/supervisor/workspace-runtime-view";

const binding = (overrides: Partial<ObservedBinding> = {}): ObservedBinding => ({
  workspaceId: "w1",
  computerId: "c1",
  enabled: true,
  instanceId: "os-1",
  inFlight: false,
  ...overrides,
});
const identity: ManagedRuntimeIdentity = {
  workspaceId: "w1",
  computerId: "c1",
  enabled: true,
  processId: 42,
  instanceId: "handshake-1",
  version: "1.2.3",
};
const child = { identity, osInstanceId: "os-1" };
const notParked = async () => undefined;

describe("workspaceRuntimeView", () => {
  test("reports the adopted child's handshake identity while its OS instance is still the live one", async () => {
    const asked: string[] = [];
    const view = await workspaceRuntimeView(binding({ enabled: false }), child, async (id) => {
      asked.push(id);
      return "workspace_deleted";
    });

    // The binding's enabled state wins over the identity's; a running Workspace is never parked.
    expect(view).toEqual({ ...identity, enabled: false });
    expect(asked).toEqual([]);
  });

  test("reports a Workspace whose child was replaced or never adopted as down", async () => {
    const down = {
      workspaceId: "w1",
      computerId: "c1",
      enabled: true,
      processId: 0,
      instanceId: "",
      version: "",
    };
    expect(await workspaceRuntimeView(binding({ instanceId: "os-2" }), child, notParked)).toEqual(
      down,
    );
    expect(await workspaceRuntimeView(binding({ instanceId: null }), undefined, notParked)).toEqual(
      down,
    );
  });

  test("names why a down Workspace is parked", async () => {
    const view = await workspaceRuntimeView(binding(), undefined, async (id) =>
      id === "w1" ? "computer_unlinked" : undefined,
    );
    expect(view.parkReason).toBe("computer_unlinked");
  });

  test("marks a Workspace whose lifecycle step is queued or running, up or down", async () => {
    const underWay = binding({ inFlight: true });
    expect((await workspaceRuntimeView(underWay, child, notParked)).lifecycleUnderWay).toBe(true);
    expect((await workspaceRuntimeView(underWay, undefined, notParked)).lifecycleUnderWay).toBe(
      true,
    );
    expect(await workspaceRuntimeView(binding(), child, notParked)).not.toHaveProperty(
      "lifecycleUnderWay",
    );
  });
});
