import { expect, test } from "bun:test";
import { PrismaRuntimeAuthAuthorization } from "#src/server/computers/runtime-auth-authorization.server";

type Row = { ownerId: string; role: string | undefined } | undefined;

function authorization(row: Row) {
  return new PrismaRuntimeAuthAuthorization({
    workspaceComputer: {
      findFirst: async () =>
        row && {
          computer: { ownerId: row.ownerId },
          workspace: { members: row.role ? [{ role: row.role }] : [] },
        },
    },
  } as never);
}
const scope = { userId: "u", workspaceId: "w", computerId: "c" };

test("the Computer's owner, and a Workspace owner or admin, may manage runtime sign-in", async () => {
  expect(await authorization({ ownerId: "u", role: "member" }).canManage(scope)).toBe(true);
  expect(await authorization({ ownerId: "x", role: "owner" }).canManage(scope)).toBe(true);
  expect(await authorization({ ownerId: "x", role: "admin" }).canManage(scope)).toBe(true);
});

test("a plain member, a stranger, and a Computer not connected to the Workspace may not", async () => {
  expect(await authorization({ ownerId: "x", role: "member" }).canManage(scope)).toBe(false);
  expect(await authorization({ ownerId: "x", role: "weird" }).canManage(scope)).toBe(false);
  expect(await authorization(undefined).canManage(scope)).toBe(false);
});
