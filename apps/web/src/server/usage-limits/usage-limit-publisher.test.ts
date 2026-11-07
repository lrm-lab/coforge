import { describe, expect, test } from "bun:test";
import type { UsageLimitChangedEvent } from "#src/features/usage-limits/usage-limit-events";
import { createUsageLimitAnnouncer } from "./usage-limit-publisher.server";

const changes: UsageLimitChangedEvent[] = [
  {
    type: "usage.limit.changed.v1",
    workspaceId: "workspace-a",
    eventId: "event-a-1",
    status: "open",
    affectedCount: 1,
    resetsAt: null,
  },
  {
    type: "usage.limit.changed.v1",
    workspaceId: "workspace-a",
    eventId: "event-a-2",
    status: "open",
    affectedCount: 2,
    resetsAt: null,
  },
  {
    type: "usage.limit.changed.v1",
    workspaceId: "workspace-b",
    eventId: "event-b-1",
    status: "open",
    affectedCount: 1,
    resetsAt: null,
  },
  {
    type: "usage.limit.changed.v1",
    workspaceId: "workspace-b",
    eventId: "event-b-2",
    status: "open",
    affectedCount: 2,
    resetsAt: null,
  },
];

describe("createUsageLimitAnnouncer", () => {
  test("keeps each Workspace ordered while announcing Workspaces concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const eventIdsByWorkspace = new Map<string, string[]>();
    const db = {
      workspaceMembership: {
        findMany: async () => [{ userId: "admin" }],
      },
    } as any;
    const announcer = createUsageLimitAnnouncer(
      {
        broadcast: async (_channels: string[], event: UsageLimitChangedEvent) => {
          active++;
          maxActive = Math.max(maxActive, active);
          const events = eventIdsByWorkspace.get(event.workspaceId) ?? [];
          events.push(event.eventId);
          eventIdsByWorkspace.set(event.workspaceId, events);
          await Promise.resolve();
          active--;
        },
      } as any,
      db,
    );

    await announcer(changes);

    expect(maxActive).toBeGreaterThan(1);
    expect(eventIdsByWorkspace).toEqual(
      new Map([
        ["workspace-a", ["event-a-1", "event-a-2"]],
        ["workspace-b", ["event-b-1", "event-b-2"]],
      ]),
    );
  });
});
