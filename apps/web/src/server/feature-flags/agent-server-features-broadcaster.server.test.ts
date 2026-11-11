import { expect, test } from "bun:test";
import { decodeAgentServerFeatures } from "@lrm/coforge-sdk/internal";
import { AgentServerFeaturesBroadcaster } from "./agent-server-features-broadcaster.server";

test("publishes one explicit feature snapshot per supported Computer placement", async () => {
  const payloads: Uint8Array[] = [];
  const broadcaster = new AgentServerFeaturesBroadcaster({
    db: {
      agent: {
        findMany: async () => [
          { id: "a1", workspaceId: "w", computerId: "c" },
          { id: "a2", workspaceId: "w", computerId: "c" },
          { id: "a3", workspaceId: "w2", computerId: "c2" },
        ],
      },
    } as never,
    supports: async (workspaceId) => workspaceId === "w",
    enabled: async () => true,
    publish: async (_workspaceId, _computerId, payload) => {
      payloads.push(payload);
    },
  });
  await broadcaster.publishSnapshot();
  expect(payloads).toHaveLength(1);
  expect(decodeAgentServerFeatures(payloads[0]!)).toMatchObject({
    workspaceId: "w",
    computerId: "c",
    agentIds: ["a1", "a2"],
    agentContextView: true,
  });
});

test("a Computer ready republishes that Computer's snapshot, flag state included", async () => {
  const published: { workspaceId: string; computerId: string; payload: Uint8Array }[] = [];
  const broadcaster = new AgentServerFeaturesBroadcaster({
    db: {
      agent: {
        findMany: async (args: { where?: Record<string, unknown> }) => {
          expect(args.where).toMatchObject({ workspaceId: "w", computerId: "c" });
          return [
            { id: "a1", workspaceId: "w", computerId: "c" },
            { id: "a2", workspaceId: "w", computerId: "c" },
          ];
        },
      },
    } as never,
    supports: async () => true,
    enabled: async () => false,
    publish: async (workspaceId, computerId, payload) => {
      published.push({ workspaceId, computerId, payload });
    },
  });
  await broadcaster.publishComputer("w", "c");
  expect(published).toHaveLength(1);
  expect(decodeAgentServerFeatures(published[0]!.payload)).toMatchObject({
    workspaceId: "w",
    computerId: "c",
    agentIds: ["a1", "a2"],
    agentContextView: false,
  });
});

test("a Computer ready republishes nothing when unsupported or no Agent is placed", async () => {
  const published: unknown[] = [];
  const unsupported = new AgentServerFeaturesBroadcaster({
    db: {
      agent: {
        findMany: async () => [{ id: "a1", workspaceId: "w", computerId: "c" }],
      },
    } as never,
    supports: async () => false,
    enabled: async () => true,
    publish: async () => {
      published.push(1);
    },
  });
  await unsupported.publishComputer("w", "c");
  const empty = new AgentServerFeaturesBroadcaster({
    db: { agent: { findMany: async () => [] } } as never,
    supports: async () => {
      throw new Error("supports must not be read for an empty placement");
    },
    enabled: async () => true,
    publish: async () => {
      published.push(1);
    },
  });
  await empty.publishComputer("w", "c");
  expect(published).toHaveLength(0);
});

test("serializes overlapping snapshots so revisions follow reload order", async () => {
  let running = 0;
  let maximum = 0;
  const broadcaster = new AgentServerFeaturesBroadcaster({
    db: {
      agent: {
        findMany: async () => {
          running += 1;
          maximum = Math.max(maximum, running);
          await Bun.sleep(1);
          running -= 1;
          return [{ id: "a", workspaceId: "w", computerId: "c" }];
        },
      },
    } as never,
    supports: async () => true,
    enabled: async () => true,
    publish: async () => {},
  });
  await Promise.all([broadcaster.publishSnapshot(), broadcaster.publishSnapshot()]);
  expect(maximum).toBe(1);
});
