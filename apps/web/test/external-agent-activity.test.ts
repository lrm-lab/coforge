import { describe, expect, test } from "bun:test";
import type { AgentActivityKind, AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import {
  type ExternalActivityPorts,
  type ExternalActivityRow,
  ingestExternalActivity,
} from "#src/server/agents/external-agent-activity.server";
import {
  EXTERNAL_ACTIVITY_SCHEMA,
  parseExternalActivityIngest,
} from "#src/server/agents/external-agent-activity-ingest.server";
import { EXTERNAL_ONLINE_WINDOW_MS } from "#src/server/agents/external-agent-presence.server";
import {
  EXTERNAL_ACTIVITY_EVENTS_PER_WINDOW,
  EXTERNAL_ACTIVITY_WINDOW_MS,
  handleExternalActivityPost,
} from "#src/server/agents/external-agent-activity-http.server";
import { NO_RATE_LIMIT } from "#src/server/app-rate-limits/app-rate-limit.server";

const NOW = Date.parse("2026-11-18T10:00:00Z");
const AGENT = { workspaceId: "ws", agentId: "agent" };
const PRINCIPAL = {
  ...AGENT,
  external: true as const,
  userId: "u",
  computerId: "",
  credentialId: "c",
};

type Observed = {
  kind: AgentActivityKind;
  detail: string;
  occurredAtMs: number;
  reported: boolean;
};

function fixture(options: { reported?: boolean; failRecord?: boolean } = {}) {
  const claimed = new Set<string>();
  const observed: Observed[] = [];
  const rows: ExternalActivityRow[] = [];
  const published: AgentDisplaySnapshot[] = [];
  const flagWrites: Date[] = [];
  let reported = options.reported ?? false;
  const ports: ExternalActivityPorts = {
    claimEventIds: async (_agent, ids) => {
      const fresh = ids.filter((id) => !claimed.has(id));
      for (const id of fresh) claimed.add(id);
      return new Set(fresh);
    },
    releaseEventIds: async (_agent, ids) => {
      for (const id of ids) claimed.delete(id);
    },
    display: {
      observeExternalStatus: async (_scope, args) => {
        observed.push({
          kind: args.kind,
          detail: args.detail,
          occurredAtMs: args.occurredAtMs,
          reported: args.reported,
        });
        return {
          protocolMajor: 1,
          workspaceId: "ws",
          computerId: "",
          agentId: "agent",
          revision: observed.length,
          activityKind: args.kind,
          detailKind: "",
          detail: args.detail,
          entries: [],
          expiresAt: args.kind === "offline" ? null : NOW + EXTERNAL_ONLINE_WINDOW_MS,
        };
      },
    },
    rateLimit: NO_RATE_LIMIT,
    statusReported: {
      isSet: async () => reported,
      set: async (_agentId, at) => {
        reported = true;
        flagWrites.push(at);
      },
    },
    record: async (batch) => {
      if (options.failRecord) throw new Error("database down");
      rows.push(...batch);
    },
    publishDisplay: async (snapshot) => {
      published.push(snapshot);
    },
    publishActivity: async () => {},
  };
  return { ports, claimed, observed, rows, published, flagWrites };
}

async function ingest(ports: ExternalActivityPorts, events: unknown[]) {
  const parsed = parseExternalActivityIngest({ schema: EXTERNAL_ACTIVITY_SCHEMA, events }, NOW);
  if (!parsed.ok) throw new Error(parsed.code);
  return ingestExternalActivity(ports, AGENT, parsed.events, NOW);
}

const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();
const report = (eventId: string, status: string, secondsAgo = 1, extra = {}) => ({
  eventId,
  status,
  occurredAt: at(secondsAgo),
  ...extra,
});

describe("ingesting an external Agent's activity", () => {
  test("only the newest report of a request reaches the display, whatever the list order", async () => {
    const { ports, observed } = fixture();
    const result = await ingest(ports, [
      report("b", "online", 1),
      report("a", "working", 5, { detail: "tests" }),
    ]);
    expect(result).toEqual({ acceptedCount: 2, rejectedCount: 0 });
    expect(observed.map((entry) => entry.kind)).toEqual(["online"]);
    expect(observed.every((entry) => entry.reported)).toBe(true);
  });

  test("a repeated event id is skipped and counted, in the request and across retries", async () => {
    const { ports, observed } = fixture();
    expect(await ingest(ports, [report("a", "working"), report("a", "online")])).toEqual({
      acceptedCount: 1,
      rejectedCount: 1,
    });
    expect(await ingest(ports, [report("a", "online"), report("b", "online", 0)])).toEqual({
      acceptedCount: 1,
      rejectedCount: 1,
    });
    expect(observed).toHaveLength(2);
  });

  test("a status event without an id or a time is counted as rejected", async () => {
    const { ports, observed } = fixture();
    expect(
      await ingest(ports, [
        { status: "working", occurredAt: at(1) },
        { eventId: "x", status: "error" },
      ]),
    ).toEqual({ acceptedCount: 0, rejectedCount: 2 });
    expect(observed).toEqual([]);
  });

  test("the first report sets the durable flag once", async () => {
    const { ports, flagWrites } = fixture();
    await ingest(ports, [report("a", "working", 3), report("b", "online", 2)]);
    expect(flagWrites).toEqual([new Date(NOW)]);
  });

  test("a legacy outcome neither reports nor sets the flag", async () => {
    const { ports, observed, flagWrites } = fixture();
    await ingest(ports, [report("a", "completed")]);
    expect(observed).toEqual([]);
    expect(flagWrites).toEqual([]);
  });

  test("hook events guess the dot until a status is reported, then only log", async () => {
    const guessing = fixture();
    await ingest(guessing.ports, [
      { eventId: "h1", occurredAt: at(3), hookEventName: "PreToolUse", toolName: "Bash" },
      { eventId: "h2", occurredAt: at(2), hookEventName: "Stop" },
    ]);
    expect(guessing.observed.map((entry) => [entry.kind, entry.reported])).toEqual([
      ["online", false],
    ]);
    expect(guessing.rows.map((row) => row.detailKind)).toEqual(["tool_started", "idle"]);

    const settled = fixture({ reported: true });
    await ingest(settled.ports, [
      { eventId: "h1", occurredAt: at(3), hookEventName: "PreToolUse", toolName: "Bash" },
    ]);
    expect(settled.observed).toEqual([]);
    expect(settled.rows).toHaveLength(1);
  });

  test("a hook event in the same request after a report does not move the dot", async () => {
    const { ports, observed } = fixture();
    await ingest(ports, [
      report("a", "online", 5),
      { eventId: "h1", occurredAt: at(1), hookEventName: "PreToolUse", toolName: "Bash" },
    ]);
    expect(observed.map((entry) => entry.reported)).toEqual([true]);
  });

  test("a tool hook is logged as a tool row; its end as a tool end", async () => {
    const { ports, rows } = fixture({ reported: true });
    await ingest(ports, [
      {
        eventId: "h1",
        occurredAt: at(2),
        hookEventName: "PreToolUse",
        toolName: "Bash",
        toolInput: "ls",
        callId: "call-1",
      },
      { eventId: "h2", occurredAt: at(1), hookEventName: "PostToolUse", toolName: "Bash" },
    ]);
    expect(rows[0]).toMatchObject({
      detailKind: "tool_started",
      computerId: null,
      launchId: "external:h1",
      clientSeq: 1,
      observedAtMs: NOW - 2000,
      entries: [{ kind: "tool_start", toolName: "Bash", toolInput: "ls", callId: "call-1" }],
    });
    expect(rows[1]).toMatchObject({ detailKind: "tool_end", entries: [] });
  });

  test("a subagent event is logged with its lineage and never moves the dot", async () => {
    const { ports, observed, rows, flagWrites } = fixture();
    await ingest(ports, [
      {
        eventId: "s1",
        occurredAt: at(2),
        status: "error",
        hookEventName: "PreToolUse",
        toolName: "Grep",
        subagent: {
          parentToolUseId: "tool-9",
          subagentType: "Explore",
          taskId: "t",
          phase: "running",
        },
      },
      {
        eventId: "s2",
        occurredAt: at(1),
        hookEventName: "SubagentStop",
        subagent: { parentToolUseId: "tool-9", subagentType: "Explore", phase: "finished" },
      },
    ]);
    expect(observed).toEqual([]);
    expect(flagWrites).toEqual([]);
    expect(rows[0]).toMatchObject({
      detailKind: "subagent_activity",
      entries: [
        {
          kind: "tool_start",
          toolName: "Grep",
          subagent: { parentToolUseId: "tool-9", subagentType: "Explore" },
        },
      ],
    });
    expect(rows[1]).toMatchObject({
      detailKind: "subagent_activity",
      detail: "Subagent finished (Explore)",
      entries: [],
    });
  });

  test("a future time counts as the receive time", async () => {
    const { ports, observed } = fixture();
    await ingest(ports, [{ eventId: "a", status: "working", occurredAt: "2027-01-01T00:00:00Z" }]);
    expect(observed[0]?.occurredAtMs).toBe(NOW);
  });

  test("the last display change is published", async () => {
    const { ports, published } = fixture();
    await ingest(ports, [
      report("a", "working", 3, { detail: "x" }),
      report("b", "error", 2, { detail: "y" }),
    ]);
    expect(published.map((snapshot) => snapshot.activityKind)).toEqual(["error"]);
  });

  test("a failed write releases the event ids so the retry is not skipped", async () => {
    const { ports, claimed } = fixture({ failRecord: true });
    await expect(
      ingest(ports, [
        { eventId: "h1", occurredAt: at(1), hookEventName: "PreToolUse", toolName: "Bash" },
      ]),
    ).rejects.toThrow("database down");
    expect(claimed.size).toBe(0);
  });
});

describe("the activity endpoint", () => {
  const post = (body: unknown) =>
    new Request("https://example.test/api/agent/v1/activity", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  test("a managed Agent is refused with external_agents_only", async () => {
    const { ports } = fixture();
    const response = await handleExternalActivityPost(
      post({ schema: EXTERNAL_ACTIVITY_SCHEMA, events: [] }),
      AGENT,
      () => ports,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "external_agents_only" });
  });

  test("answers the accepted and rejected counts", async () => {
    const { ports } = fixture();
    const response = await handleExternalActivityPost(
      post({
        schema: EXTERNAL_ACTIVITY_SCHEMA,
        events: [report("a", "working"), { status: "online" }],
      }),
      PRINCIPAL,
      () => ports,
      () => NOW,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ acceptedCount: 1, rejectedCount: 1 });
  });

  test.each([
    ["status_invalid", { status: "busy" }],
    ["detail_invalid", { status: "working", detail: 3 }],
    ["detail_too_long", { status: "working", detail: "x".repeat(201) }],
  ])("%s refuses the whole request and leaves nothing behind", async (code, bad) => {
    const { ports, observed, rows, claimed, flagWrites } = fixture();
    const response = await handleExternalActivityPost(
      post({
        schema: EXTERNAL_ACTIVITY_SCHEMA,
        events: [report("a", "working"), { eventId: "b", occurredAt: at(1), ...bad }],
      }),
      PRINCIPAL,
      () => ports,
      () => NOW,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code, retryable: false });
    expect([observed.length, rows.length, claimed.size, flagWrites.length]).toEqual([0, 0, 0, 0]);
  });

  test("an Agent over its event budget gets 429 activity_rate_limited with Retry-After and nothing is written", async () => {
    const { ports, observed, rows, claimed, flagWrites } = fixture();
    const admitted: [string, number | undefined][] = [];
    const refusing = {
      admit: async (id: string, cost?: number) => {
        admitted.push([id, cost]);
        return { allowed: false as const, retryAfterSeconds: 17 };
      },
    };
    const response = await handleExternalActivityPost(
      post({
        schema: EXTERNAL_ACTIVITY_SCHEMA,
        events: [report("a", "working"), report("b", "online")],
      }),
      PRINCIPAL,
      () => ({ ...ports, rateLimit: refusing }),
      () => NOW,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(await response.json()).toMatchObject({ code: "activity_rate_limited", retryable: true });
    expect(admitted).toEqual([[PRINCIPAL.agentId, 2]]);
    expect([observed.length, rows.length, claimed.size, flagWrites.length]).toEqual([0, 0, 0, 0]);
  });

  test("an invalid request spends none of the budget", async () => {
    const { ports } = fixture();
    let admits = 0;
    const counting = {
      admit: async () => {
        admits++;
        return { allowed: true as const };
      },
    };
    const response = await handleExternalActivityPost(
      post({ schema: EXTERNAL_ACTIVITY_SCHEMA, events: [{ status: "busy" }] }),
      PRINCIPAL,
      () => ({ ...ports, rateLimit: counting }),
      () => NOW,
    );
    expect(response.status).toBe(400);
    expect(admits).toBe(0);
  });

  test("the budget is 600 events a minute for each Agent", () => {
    expect(EXTERNAL_ACTIVITY_EVENTS_PER_WINDOW).toBe(600);
    expect(EXTERNAL_ACTIVITY_WINDOW_MS).toBe(60_000);
  });

  test("a body that is not JSON is a 400", async () => {
    const { ports } = fixture();
    const response = await handleExternalActivityPost(post("{"), PRINCIPAL, () => ports);
    expect(response.status).toBe(400);
  });
});
