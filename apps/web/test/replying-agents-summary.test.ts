import { expect, test } from "bun:test";
import { replyingAgentsAmong, replyingNames } from "#src/features/agents/replying-agents-summary";

// en-GB lists "A, B and C"; en-US would add the serial comma.
const names = (...list: string[]) => replyingNames(list, "en-GB");

test("one name is singular; two or three are plural and listed", () => {
  expect(names("Atlas")).toEqual({ kind: "list", text: "Atlas", plural: false });
  expect(names("Atlas", "Ben")).toEqual({ kind: "list", text: "Atlas and Ben", plural: true });
  expect(names("Atlas", "Ben", "Cam")).toEqual({
    kind: "list",
    text: "Atlas, Ben and Cam",
    plural: true,
  });
});

test("more than three name the first two and count both the rest and the whole", () => {
  expect(names("Atlas", "Ben", "Cam", "Dee")).toEqual({
    kind: "overflow",
    first: "Atlas",
    second: "Ben",
    rest: 2,
    total: 4,
  });
  expect(names("Atlas", "Ben", "Cam", "Dee", "Eve")).toMatchObject({ rest: 3, total: 5 });
});

test("the typing Agents are the live roster's, in the order they started, by display name", () => {
  const roster = [
    { id: "ben", name: "ben", displayName: "Ben", mascot: undefined },
    { id: "atlas", name: "atlas", displayName: " ", mascot: "blue" as const },
  ];
  const replying = replyingAgentsAmong(roster, ["atlas", "unknown", "ben"]);
  expect(replying.map(({ id, name }) => [id, name])).toEqual([
    ["atlas", "atlas"],
    ["ben", "Ben"],
  ]);
  expect(replying[0]!.mascot).toBe("blue");
  expect(replying[1]!.mascot).toBeTruthy();
});
