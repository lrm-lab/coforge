import { expect, test } from "bun:test";
import {
  departureImpactLines,
  type DepartingComputer,
  type DepartureCopy,
} from "#src/features/workspaces/departure-impact";

// English wording with the plural rules the messages apply, so the sentence building is tested
// without a locale.
const plural = (count: number, one: string, other: string) => (count === 1 ? one : other);
const copy: DepartureCopy = {
  removeComputers: ({ name, count, names }) =>
    `Removing ${name} disconnects ${count} ${plural(count, "Computer", "Computers")}: ${names}.`,
  leaveComputers: ({ count, names }) =>
    `Leaving disconnects the ${count} ${plural(count, "Computer", "Computers")}: ${names}.`,
  agentsOffline: ({ count }) => `${count} ${plural(count, "Agent", "Agents")} offline.`,
  agentsOfflineNamed: ({ count, names }) =>
    `${count} ${plural(count, "Agent", "Agents")} offline: ${names}.`,
  computersMore: ({ names, count }) => `${names} and ${count} ${plural(count, "other", "others")}`,
  agentsMore: ({ names, count }) => `${names} and ${count} more`,
  separator: ", ",
  list: (names) => names.join(" & "),
};

function computer(
  name: string,
  agents: string[] = [],
  hidden = 0,
  displayName = "",
): DepartingComputer {
  return {
    id: name,
    name,
    displayName,
    agentCount: agents.length + hidden,
    agents: agents.map((agent) => ({
      id: agent,
      name: agent,
      displayName: "",
    })),
  };
}
const remove = { kind: "remove", name: "Bob" } as const;

test("no Computers says nothing, not even about Agents", () => {
  expect(departureImpactLines([], remove, copy)).toBeNull();
  expect(departureImpactLines([], { kind: "leave" }, copy)).toBeNull();
});

test("one Computer without Agents is singular and has no Agent sentence", () => {
  expect(departureImpactLines([computer("mac")], remove, copy)).toEqual({
    computers: "Removing Bob disconnects 1 Computer: mac.",
    agents: null,
  });
  expect(departureImpactLines([computer("mac")], { kind: "leave" }, copy)?.computers).toBe(
    "Leaving disconnects the 1 Computer: mac.",
  );
});

test("a Computer's display name wins over its name", () => {
  const lines = departureImpactLines([computer("m1", [], 0, "Bob's Mac")], remove, copy);
  expect(lines?.computers).toContain("Bob's Mac");
});

test("two to three Computers list every name", () => {
  const lines = departureImpactLines([computer("a"), computer("b"), computer("c")], remove, copy);
  expect(lines?.computers).toBe("Removing Bob disconnects 3 Computers: a & b & c.");
});

test("more Computers than fit are counted after the first three", () => {
  const four = ["a", "b", "c", "d"].map((name) => computer(name));
  expect(departureImpactLines(four, remove, copy)?.computers).toBe(
    "Removing Bob disconnects 4 Computers: a, b, c and 1 other.",
  );
  expect(departureImpactLines([...four, computer("e")], { kind: "leave" }, copy)?.computers).toBe(
    "Leaving disconnects the 5 Computers: a, b, c and 2 others.",
  );
});

test("Agents are counted across Computers and named when visible", () => {
  const lines = departureImpactLines(
    [computer("a", ["x"]), computer("b", ["y", "z"])],
    remove,
    copy,
  );
  expect(lines?.agents).toBe("3 Agents offline: x & y & z.");
  expect(departureImpactLines([computer("a", ["x"])], remove, copy)?.agents).toBe(
    "1 Agent offline: x.",
  );
});

test("visible Agents beyond three are counted as more", () => {
  const lines = departureImpactLines([computer("a", ["p", "q", "r", "s", "t"])], remove, copy);
  expect(lines?.agents).toBe("5 Agents offline: p, q, r and 2 more.");
});

test("hidden Agents are counted, never named", () => {
  const some = departureImpactLines([computer("a", ["x"], 2)], remove, copy);
  expect(some?.agents).toBe("3 Agents offline: x and 2 more.");
  const none = departureImpactLines([computer("a", [], 2)], remove, copy);
  expect(none?.agents).toBe("2 Agents offline.");
});
