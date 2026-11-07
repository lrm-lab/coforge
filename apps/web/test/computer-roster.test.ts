import { expect, test } from "bun:test";
import type { ComputerCandidate } from "@lrm/coforge-sdk/internal";
import { ComputerRoster } from "#src/server/computers/roster.server";

const computers: ComputerCandidate[] = [
  {
    computerId: "computer-1",
    machineId: "machine-1",
    name: "host",
    displayName: "Host",
    platform: "darwin",
    osVersion: "15",
    computerVersion: "1.0.64",
    workspaceSlugs: ["team"],
  },
];

test("Computer roster requires a signed-in User and preserves request correlation", async () => {
  const roster = new ComputerRoster({ listOwned: async () => computers });
  await expect(
    roster.list({ protocolMajor: 1, requestId: "roster-1" }, undefined),
  ).rejects.toMatchObject({ code: 401 });
  await expect(
    roster.list({ protocolMajor: 2, requestId: "roster-2" }, { userId: "user-1" }),
  ).rejects.toMatchObject({ code: 422 });
  await expect(
    roster.list({ protocolMajor: 1, requestId: "roster-3" }, { userId: "user-1" }),
  ).resolves.toEqual({ protocolMajor: 1, requestId: "roster-3", computers });
});

test("Computer roster does not expose repository errors as another user's candidates", async () => {
  const roster = new ComputerRoster({
    async listOwned() {
      throw new Error("database unavailable");
    },
  });
  await expect(
    roster.list({ protocolMajor: 1, requestId: "roster-4" }, { userId: "user-1" }),
  ).rejects.toThrow("database unavailable");
});
