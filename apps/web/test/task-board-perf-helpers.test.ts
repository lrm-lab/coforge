import { describe, expect, test } from "bun:test";
import { indexChannelNames } from "#src/features/conversations/channel-members";
import {
  formatTaskHref,
  overviewTaskParam,
  TASK_HREF_PLACEHOLDER,
} from "#src/features/tasks/task-overview-search";
import { indexWorkspaceLabels } from "#src/features/tasks/workspace-labels";

describe("task board lookup indexes", () => {
  test("indexChannelNames builds cached byId and byName maps", () => {
    const entries = [
      {
        id: "c1",
        name: "general",
        description: "",
        visibility: "public" as const,
        archived: false,
        members: [],
      },
      {
        id: "c2",
        name: "ops",
        description: "",
        visibility: "private" as const,
        archived: false,
        members: [],
      },
    ];
    const first = indexChannelNames(entries);
    const second = indexChannelNames(entries);
    expect(first).toBe(second);
    expect(first.byId.get("c1")?.name).toBe("general");
    expect(first.byName.get("ops")?.visibility).toBe("private");
    expect(indexChannelNames(undefined).byId.size).toBe(0);
  });

  test("indexWorkspaceLabels builds cached color and archive lookup", () => {
    const labels = [
      {
        id: "l1",
        name: "Bug",
        color: "error",
        groupId: null,
        archivedAt: null,
        taskCount: 3,
      },
      {
        id: "l2",
        name: "Old",
        color: "gray",
        groupId: null,
        archivedAt: new Date("2026-01-01T00:00:00Z"),
        taskCount: 0,
      },
    ];
    const first = indexWorkspaceLabels(labels as never);
    const second = indexWorkspaceLabels(labels as never);
    expect(first).toBe(second);
    expect(first.get("l1")).toEqual({ color: "error", archived: false });
    expect(first.get("l2")).toEqual({ color: "gray", archived: true });
    expect(indexWorkspaceLabels(undefined).size).toBe(0);
  });

  test("formatTaskHref substitutes encoded conversationId:number into route template", () => {
    const ref = { conversationId: "019a0000-0000-7000-8000-000000000001", number: 42 };
    const template = `/w/coforge/projects/main?layout=list&task=${TASK_HREF_PLACEHOLDER}`;
    expect(formatTaskHref(template, ref)).toBe(
      `/w/coforge/projects/main?layout=list&task=${encodeURIComponent(overviewTaskParam(ref))}`,
    );
  });
});
