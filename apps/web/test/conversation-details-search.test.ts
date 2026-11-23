import { describe, expect, test } from "bun:test";

import {
  conversationSearchWithDetails,
  conversationSearchWithoutDetails,
  detailsMembersView,
  detailsParamSchema,
} from "#src/features/conversations/conversation-details-search";
import { pickConversationPageSearch } from "#src/features/conversations/conversation-page-search";

describe("detailsParamSchema", () => {
  test("parses valid details views and catches invalid values to undefined", () => {
    expect(detailsParamSchema.parse(undefined)).toBeUndefined();
    expect(detailsParamSchema.parse("panel")).toBe("panel");
    expect(detailsParamSchema.parse("members")).toBe("members");
    expect(detailsParamSchema.parse("add")).toBe("add");
    expect(detailsParamSchema.parse("invalid")).toBeUndefined();
    expect(detailsParamSchema.parse(42)).toBeUndefined();
  });
});

describe("detailsMembersView", () => {
  test("maps panel and undefined to null and preserves members/add", () => {
    expect(detailsMembersView(undefined)).toBeNull();
    expect(detailsMembersView("panel")).toBeNull();
    expect(detailsMembersView("members")).toBe("members");
    expect(detailsMembersView("add")).toBe("add");
  });
});

describe("conversationSearchWithDetails", () => {
  test("strips thread, profile and open document params while preserving view and task filters", () => {
    expect(
      conversationSearchWithDetails(
        {
          view: "tasks",
          status: ["open"],
          threadRootId: "root-1",
          profile: "agent:a1",
          agentTab: "activity",
          doc: "doc-1",
          docFull: true,
        },
        "members",
      ),
    ).toEqual({
      view: "tasks",
      status: ["open"],
      details: "members",
    });
  });

  test("defaults details view to panel", () => {
    expect(conversationSearchWithDetails({ view: "chat" })).toEqual({
      view: "chat",
      details: "panel",
    });
  });
});

describe("conversationSearchWithoutDetails", () => {
  test("removes details while preserving other search params", () => {
    expect(
      conversationSearchWithoutDetails({
        view: "files",
        details: "panel",
      }),
    ).toEqual({
      view: "files",
    });
  });
});

describe("pickConversationPageSearch", () => {
  test("preserves details", () => {
    expect(
      pickConversationPageSearch({
        view: "chat",
        details: "add",
      }),
    ).toEqual({
      view: "chat",
      status: undefined,
      layout: undefined,
      owners: undefined,
      labels: undefined,
      projects: undefined,
      completed: undefined,
      threadRootId: undefined,
      task: undefined,
      file: undefined,
      comment: undefined,
      profile: undefined,
      agentTab: undefined,
      doc: undefined,
      docFull: undefined,
      details: "add",
    });
  });
});
