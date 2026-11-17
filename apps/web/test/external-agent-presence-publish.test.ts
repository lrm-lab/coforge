import { describe, expect, test } from "bun:test";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import {
  noteExternalSeen,
  syncExternalPresence,
  type ExternalDisplayPorts,
} from "#src/server/agents/external-agent-presence-publish.server";
import { EXTERNAL_ONLINE_WINDOW_MS } from "#src/server/agents/external-agent-presence.server";

const AGENT = { workspaceId: "ws", agentId: "agent" };
const snapshot = (kind: AgentDisplaySnapshot["activityKind"]): AgentDisplaySnapshot => ({
  protocolMajor: 1,
  workspaceId: "ws",
  computerId: "",
  agentId: "agent",
  revision: 5,
  activityKind: kind,
  detailKind: "",
  detail: "",
  entries: [],
  expiresAt: kind === "offline" ? null : 1_000,
});

function ports(visibility: string | undefined, changed?: AgentDisplaySnapshot) {
  const presence: { seenAtMs: number; windowMs: number }[] = [];
  const published: { channel: string; data: { type: string; statusOnly?: true } }[] = [];
  const value: ExternalDisplayPorts = {
    display: {
      observeExternalPresence: async (_scope, args) => {
        presence.push(args);
        return changed;
      },
      observeExternalStatus: async () => undefined,
    },
    publishJson: async (channel, data) => {
      published.push({ channel, data: data as { type: string; statusOnly?: true } });
    },
    visibility: async () => visibility,
  };
  return { value, presence, published };
}

describe("external Agent presence publication", () => {
  test("a seen report that changes nothing publishes nothing", async () => {
    const { value, presence, published } = ports("public");
    await noteExternalSeen(value, AGENT, 1_000);
    expect(presence).toEqual([{ seenAtMs: 1_000, windowMs: EXTERNAL_ONLINE_WINDOW_MS }]);
    expect(published).toEqual([]);
  });

  test("a changed display goes to the shared status channel of a public Agent", async () => {
    const { value, published } = ports("public", snapshot("online"));
    await noteExternalSeen(value, AGENT, 1_000);
    expect(published.map((entry) => entry.channel)).toEqual(["agentstatus:ws"]);
    expect(published[0]?.data.type).toBe("agent:display");
  });

  test("a private Agent's display goes to its own channel with the status floor on the shared one", async () => {
    const { value, published } = ports("private", snapshot("online"));
    await noteExternalSeen(value, AGENT, 1_000);
    expect(published.map((entry) => entry.channel)).toEqual([
      "agentstatus:ws:agent",
      "agentstatus:ws",
    ]);
    expect(published[1]?.data.statusOnly).toBe(true);
  });

  test("an Agent that cannot be found is not published", async () => {
    const { value, published } = ports(undefined, snapshot("offline"));
    await noteExternalSeen(value, AGENT, 0);
    expect(published).toEqual([]);
  });

  test("a sync reports the newest use among the live credentials, or none", async () => {
    const live = ports("public");
    await syncExternalPresence(
      live.value,
      async () => [{ liveLastUsedAt: new Date(7_000) }],
      AGENT,
    );
    expect(live.presence[0]?.seenAtMs).toBe(7_000);
    const none = ports("public", snapshot("offline"));
    await syncExternalPresence(none.value, async () => [{ liveLastUsedAt: null }], AGENT);
    await syncExternalPresence(none.value, async () => [], AGENT);
    expect(none.presence.map((entry) => entry.seenAtMs)).toEqual([0, 0]);
    expect(none.published).toHaveLength(2);
  });
});
