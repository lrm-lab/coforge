import { describe, expect, test } from "bun:test";

import {
  buildGroupChatCandidates,
  canCreateGroupChat,
  filterGroupChatCandidates,
  selectedGroupChatCandidates,
  splitGroupChatKeys,
  toggleGroupChatKey,
} from "#src/features/conversations/group-chat-picker";

const directory = {
  viewerId: "viewer",
  people: [
    { id: "viewer", name: "Me", avatarUrl: null },
    { id: "ada", name: "Ada", avatarUrl: null },
    { id: "bob", name: "Bob", avatarUrl: "https://cdn.example/bob.png" },
  ],
  agents: [
    {
      id: "atlas",
      handle: "atlas",
      name: "Atlas Bot",
      avatarUrl: null,
      visibility: "public",
      weeklyReportAssistant: false,
    },
    {
      id: "scout",
      handle: "scout",
      name: "Scout",
      avatarUrl: null,
      visibility: "public",
      weeklyReportAssistant: false,
    },
  ],
};

describe("buildGroupChatCandidates", () => {
  test("lists the Agents first, then the people, in the order the directory gives them", () => {
    const candidates = buildGroupChatCandidates(directory);
    expect(candidates.map((entry) => entry.key)).toEqual([
      "agent:atlas",
      "agent:scout",
      "user:ada",
      "user:bob",
    ]);
  });

  test("never lists the viewer, who is the creator", () => {
    const keys = buildGroupChatCandidates(directory).map((entry) => entry.key);
    expect(keys).not.toContain("user:viewer");
  });

  test("names a person by the label they are shown by and an Agent by its display name", () => {
    const byKey = new Map(
      buildGroupChatCandidates(directory).map((entry) => [entry.key, entry.name]),
    );
    expect(byKey.get("user:ada")).toBe("Ada");
    expect(byKey.get("agent:atlas")).toBe("Atlas Bot");
  });

  test("keeps the avatar of each candidate", () => {
    const bob = buildGroupChatCandidates(directory).find((entry) => entry.key === "user:bob");
    expect(bob?.avatarUrl).toBe("https://cdn.example/bob.png");
  });
});

describe("buildGroupChatCandidates offers only the Agents a channel can take", () => {
  test("a private Agent never appears, even one the viewer may see", () => {
    const keys = buildGroupChatCandidates({
      ...directory,
      agents: [
        ...directory.agents,
        {
          id: "vault",
          handle: "vault",
          name: "Vault",
          avatarUrl: null,
          visibility: "private",
          weeklyReportAssistant: false,
        },
      ],
    }).map((entry) => entry.key);
    expect(keys).not.toContain("agent:vault");
    expect(keys).toContain("agent:atlas");
  });

  test("a weekly-report assistant never appears, even when public", () => {
    const keys = buildGroupChatCandidates({
      ...directory,
      agents: [
        ...directory.agents,
        {
          id: "weekly",
          handle: "weekly",
          name: "Weekly",
          avatarUrl: null,
          visibility: "public",
          weeklyReportAssistant: true,
        },
      ],
    }).map((entry) => entry.key);
    expect(keys).not.toContain("agent:weekly");
    expect(keys).toContain("agent:scout");
  });
});

describe("filterGroupChatCandidates", () => {
  const candidates = buildGroupChatCandidates(directory);

  test("an empty search keeps every candidate", () => {
    expect(filterGroupChatCandidates(candidates, "  ")).toHaveLength(4);
  });

  test("matches a person by name and an Agent by its @handle", () => {
    expect(filterGroupChatCandidates(candidates, "ada").map((entry) => entry.key)).toEqual([
      "user:ada",
    ]);
    expect(filterGroupChatCandidates(candidates, "@scout").map((entry) => entry.key)).toEqual([
      "agent:scout",
    ]);
  });

  test("ignores the case of the search", () => {
    expect(filterGroupChatCandidates(candidates, "ATLAS").map((entry) => entry.key)).toEqual([
      "agent:atlas",
    ]);
  });
});

describe("toggleGroupChatKey", () => {
  test("adds a key when it is ticked and removes it when it is unticked", () => {
    const ticked = toggleGroupChatKey(new Set(), "user:ada", true);
    expect([...ticked]).toEqual(["user:ada"]);
    expect([...toggleGroupChatKey(ticked, "user:ada", false)]).toEqual([]);
  });

  test("leaves the set it was given untouched", () => {
    const before = new Set(["agent:atlas"]);
    toggleGroupChatKey(before, "user:ada", true);
    expect([...before]).toEqual(["agent:atlas"]);
  });
});

describe("selectedGroupChatCandidates and splitGroupChatKeys", () => {
  const candidates = buildGroupChatCandidates(directory);

  test("the selected rows follow the candidate order, whatever order they were ticked in", () => {
    const selected = selectedGroupChatCandidates(candidates, new Set(["user:bob", "agent:atlas"]));
    expect(selected.map((entry) => entry.key)).toEqual(["agent:atlas", "user:bob"]);
  });

  test("splits the selected keys into the human and Agent ids the server takes", () => {
    expect(splitGroupChatKeys(["user:bob", "agent:atlas", "user:ada"])).toEqual({
      userIds: ["bob", "ada"],
      agentIds: ["atlas"],
    });
  });
});

describe("canCreateGroupChat", () => {
  test("needs at least the minimum number of people besides the creator", () => {
    expect(canCreateGroupChat(1, 2)).toBeFalse();
    expect(canCreateGroupChat(2, 2)).toBeTrue();
    expect(canCreateGroupChat(3, 2)).toBeTrue();
  });

  test("a zero minimum, as the other channel-creating callers use, needs no one", () => {
    expect(canCreateGroupChat(0, 0)).toBeTrue();
  });
});
