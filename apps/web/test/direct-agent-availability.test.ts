import { expect, test } from "bun:test";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { resolveDirectAgentGuidance } from "#src/features/conversations/direct-agent-availability";

function snapshot(
  overrides: Partial<AgentDisplaySnapshot> & Pick<AgentDisplaySnapshot, "activityKind">,
): AgentDisplaySnapshot {
  const isOffline = overrides.activityKind === "offline";
  return {
    protocolMajor: 1,
    workspaceId: "ws-1",
    computerId: "comp-1",
    agentId: "agent-1",
    revision: 1,
    detailKind: "",
    detail: "",
    entries: [],
    expiresAt: isOffline ? null : Date.now() + 60_000,
    ...overrides,
  };
}

const baseAgent = {
  id: "agent-1",
  name: "echo",
  displayName: "Echo",
  deletedAt: null,
};

test("deleted, read-only, and app-bot DMs show no offline guidance", () => {
  expect(
    resolveDirectAgentGuidance({
      agent: { ...baseAgent, computerId: null, deletedAt: new Date("2026-11-28T00:00:00Z") },
      dmWritable: true,
      display: snapshot({ activityKind: "offline", computerId: "" }),
    }),
  ).toBeNull();

  expect(
    resolveDirectAgentGuidance({
      agent: { ...baseAgent, computerId: null },
      dmWritable: false,
      display: undefined,
    }),
  ).toBeNull();

  expect(
    resolveDirectAgentGuidance({
      agent: { ...baseAgent, computerId: null, isAppBot: true },
      dmWritable: true,
      display: undefined,
    }),
  ).toBeNull();
});

test("online, thinking, working, or unhydrated bound agents show no guidance", () => {
  for (const activityKind of ["online", "thinking", "working"] as const) {
    expect(
      resolveDirectAgentGuidance({
        agent: { ...baseAgent, computerId: "comp-1" },
        dmWritable: true,
        display: snapshot({ activityKind }),
      }),
    ).toBeNull();
  }

  // Initial paint before live status hydrates never flashes false offline on a bound agent.
  expect(
    resolveDirectAgentGuidance({
      agent: { ...baseAgent, computerId: "comp-1" },
      dmWritable: true,
      display: undefined,
    }),
  ).toBeNull();
});

test("managed agent without a computer always resolves to no_computer guidance", () => {
  expect(
    resolveDirectAgentGuidance({
      agent: { ...baseAgent, computerId: null },
      dmWritable: true,
      display: undefined,
    }),
  ).toEqual({
    kind: "no_computer",
    agentName: "Echo",
  });

  expect(
    resolveDirectAgentGuidance({
      agent: { ...baseAgent, computerId: null },
      dmWritable: true,
      display: snapshot({ activityKind: "offline", computerId: "" }),
    }),
  ).toEqual({
    kind: "no_computer",
    agentName: "Echo",
  });
});

test("offline managed agent resolves to offline guidance with computerId and stop alert details", () => {
  expect(
    resolveDirectAgentGuidance({
      agent: { ...baseAgent, computerId: "comp-1" },
      dmWritable: true,
      display: snapshot({ activityKind: "offline", computerId: "comp-1" }),
    }),
  ).toEqual({
    kind: "offline",
    agentName: "Echo",
    computerId: "comp-1",
  });

  // Older cached DM shape without agent.computerId falls back to display.computerId.
  expect(
    resolveDirectAgentGuidance({
      agent: { ...baseAgent },
      dmWritable: true,
      display: snapshot({ activityKind: "offline", computerId: "comp-2" }),
    }),
  ).toEqual({
    kind: "offline",
    agentName: "Echo",
    computerId: "comp-2",
  });

  const quota = resolveDirectAgentGuidance({
    agent: { ...baseAgent, computerId: "comp-1" },
    dmWritable: true,
    display: snapshot({
      activityKind: "offline",
      computerId: "comp-1",
      stopReason: "billing_exhausted",
      stopDetail: "Insufficient credit balance",
    }),
  });
  expect(quota).toMatchObject({
    kind: "offline",
    agentName: "Echo",
    computerId: "comp-1",
    alertText: "Insufficient credit balance",
  });
  expect(quota && "alertDetail" in quota ? quota.alertDetail : undefined).toBeTruthy();
});

test("external agents resolve to external_offline when offline and null before display hydrates", () => {
  expect(
    resolveDirectAgentGuidance({
      agent: { ...baseAgent, computerId: null, hosting: "external" },
      dmWritable: true,
      display: undefined,
    }),
  ).toBeNull();

  expect(
    resolveDirectAgentGuidance({
      agent: { ...baseAgent, computerId: null, hosting: "external" },
      dmWritable: true,
      display: snapshot({ activityKind: "offline", computerId: "" }),
    }),
  ).toEqual({
    kind: "external_offline",
    agentName: "Echo",
  });
});

test("agentName trims displayName and falls back to handle name when blank", () => {
  expect(
    resolveDirectAgentGuidance({
      agent: {
        id: "agent-1",
        name: "assistant-slug",
        displayName: "  小云的助手  ",
        computerId: null,
      },
      dmWritable: true,
      display: undefined,
    }),
  ).toEqual({
    kind: "no_computer",
    agentName: "小云的助手",
  });

  expect(
    resolveDirectAgentGuidance({
      agent: { id: "agent-1", name: "assistant-slug", displayName: "   ", computerId: null },
      dmWritable: true,
      display: undefined,
    }),
  ).toEqual({
    kind: "no_computer",
    agentName: "assistant-slug",
  });
});
