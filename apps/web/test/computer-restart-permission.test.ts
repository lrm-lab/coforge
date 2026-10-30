import { expect, test } from "bun:test";

import { mayRestartComputer } from "#src/server/computers/computer-membership.server";

const computer = { ownerId: "owner-user" };

test("a Computer's owner may restart it, whatever their Workspace role", () => {
  expect(mayRestartComputer({ userId: "owner-user", role: "member" }, computer)).toBe(true);
});

test("a Workspace owner or admin may restart someone else's Computer", () => {
  expect(mayRestartComputer({ userId: "someone", role: "owner" }, computer)).toBe(true);
  expect(mayRestartComputer({ userId: "someone", role: "admin" }, computer)).toBe(true);
});

test("an ordinary member may not restart someone else's Computer", () => {
  expect(mayRestartComputer({ userId: "someone", role: "member" }, computer)).toBe(false);
  expect(mayRestartComputer({ userId: "someone", role: undefined }, computer)).toBe(false);
});
