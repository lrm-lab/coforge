import { describe, expect, test } from "bun:test";

import { matchSearchEntities, type SearchEntity } from "#src/features/search/search-entities";

const dm = (fields: { name: string }): SearchEntity => ({
  kind: "dm",
  id: "dm-1",
  peerId: "user-1",
  avatarUrl: null,
  ...fields,
});

const agent: SearchEntity = {
  kind: "agent",
  id: "agent-1",
  name: "Atlas Bot",
  handle: "atlas",
  avatarUrl: null,
  ownedByCurrentUser: true,
  dmId: null,
};

describe("matchSearchEntities", () => {
  test("a direct message is found by the name shown for the person", () => {
    const entity = dm({ name: "Amazing Grace" });
    expect(matchSearchEntities([entity], "amazing")).toEqual([entity]);
    expect(matchSearchEntities([entity], "grace")).toEqual([entity]);
  });

  test("a person matches by the name shown alone", () => {
    const entity = dm({ name: "Ada" });
    expect(matchSearchEntities([entity], "ada")).toEqual([entity]);
    expect(matchSearchEntities([entity], "lovelace")).toEqual([]);
  });

  test("an Agent is still found by its @handle", () => {
    expect(matchSearchEntities([agent], "atl")).toEqual([agent]);
    expect(matchSearchEntities([agent], "@atlas")).toEqual([agent]);
  });

  test("later better matches replace earlier candidates before the five-result limit", () => {
    const entities: SearchEntity[] = [
      ...Array.from({ length: 10 }, (_, index) => ({
        ...agent,
        id: `filler-${index}`,
        name: `Atlas Z${index}`,
        handle: `atlas-z${index}`,
      })),
      ...["C", "A", "B"].map((suffix) => ({
        ...agent,
        id: suffix,
        name: `Atlas ${suffix}`,
        handle: `atlas-${suffix.toLowerCase()}`,
      })),
    ];
    expect(matchSearchEntities(entities, "atlas").map(({ id }) => id)).toEqual([
      "A",
      "B",
      "C",
      "filler-0",
      "filler-1",
    ]);
    expect(entities.map(({ id }) => id)).toEqual([
      ...Array.from({ length: 10 }, (_, index) => `filler-${index}`),
      "C",
      "A",
      "B",
    ]);
  });

  test("equal matches keep their input order across the five-result cutoff", () => {
    const ids = ["z", "y", "x", "w", "v", "u", "t"];
    const entities = ids.map((id) => ({ ...agent, id }));
    expect(matchSearchEntities(entities, "atlas").map(({ id }) => id)).toEqual(ids.slice(0, 5));
  });

  test("match quality precedes kind, and kinds break exact-name ties", () => {
    const entities: SearchEntity[] = [
      { kind: "channel", id: "description", name: "Notes", description: "Atlas", archived: false },
      { ...agent, id: "prefix", handle: "atlas-helper" },
      { ...dm({ name: "Atlas" }), id: "exact-dm" },
      { ...agent, id: "exact-agent", name: "Atlas" },
      {
        kind: "computer",
        id: "exact-computer",
        name: "Atlas",
        hostname: "host",
        computerKind: "personal",
      },
      { kind: "channel", id: "exact-channel", name: "Atlas", description: "", archived: false },
    ];
    expect(matchSearchEntities(entities, "atlas").map(({ id }) => id)).toEqual([
      "exact-channel",
      "exact-computer",
      "exact-agent",
      "exact-dm",
      "prefix",
    ]);
    expect(matchSearchEntities(entities, "#atlas").map(({ id }) => id)).toEqual([
      "exact-channel",
      "description",
    ]);
  });
});
