import { describe, expect, test } from "bun:test";

import { directorySenders } from "#src/features/search/search-senders";

const directory = {
  viewerId: "user-1",
  people: [
    { id: "user-2", name: "Amazing Grace", avatarUrl: null, dmId: null },
    { id: "user-1", name: "Dee", avatarUrl: null, dmId: null },
    { id: "user-3", name: "ada-9d3", avatarUrl: null, dmId: null },
  ],
  agents: [
    {
      id: "agent-1",
      name: "Atlas Bot",
      handle: "atlas",
      avatarUrl: null,
      ownedByCurrentUser: true,
      visibility: "public",
      weeklyReportAssistant: false,
      dmId: null,
    },
    {
      id: "agent-2",
      name: "Long",
      handle: "a-very-long-generated-agent-handle-name",
      avatarUrl: null,
      ownedByCurrentUser: false,
      visibility: "public",
      weeklyReportAssistant: false,
      dmId: null,
    },
  ],
};

describe("directorySenders", () => {
  const senders = directorySenders(directory, "Me");
  const byId = (id: string) => senders.find((sender) => sender.id === id)!;

  test("lists the viewer first, as Me, then the other people, then the Agents", () => {
    expect(senders.map((sender) => [sender.id, sender.label])).toEqual([
      ["user-1", "Me"],
      ["user-2", "Amazing Grace"],
      ["user-3", "ada-9d3"],
      ["agent-1", "Atlas Bot"],
      ["agent-2", "Long"],
    ]);
  });

  test("a person has no @ addon, and is found by their name", () => {
    expect(byId("user-2").addon).toBeUndefined();
    expect(byId("user-2").textValue).toBe("Amazing Grace");
    expect(byId("user-3").textValue).toBe("ada-9d3");
  });

  test("an Agent is told by its @handle, cut short when it is long, and found by it", () => {
    expect(byId("agent-1").addon).toBe("@atlas");
    expect(byId("agent-1").textValue).toBe("Atlas Bot Atlas Bot atlas");
    expect(byId("agent-2").addon).toBe("@a-very-long-generated-a…");
  });
});
