import { expect, test } from "bun:test";
import { RuntimeAuth } from "#src/server/computers/runtime-auth.server";
import { PrismaRuntimeAuthAuthorization } from "#src/server/computers/runtime-auth-authorization.server";
import { RuntimeResetCredit } from "#src/server/computers/runtime-reset-credit.server";

type Row =
  | {
      ownerId: string;
      role: string | undefined;
      kind?: string;
      cloudSlot?: string | null;
      /** The runtime row's `isPublic`; `null` is no runtime reported. Public by default. */
      runtime?: { isPublic: boolean } | null;
    }
  | undefined;

function authorization(row: Row) {
  const lookups = { runtime: 0, where: undefined as unknown };
  const authorization = new PrismaRuntimeAuthAuthorization({
    computerRuntime: {
      findFirst: async () => {
        lookups.runtime += 1;
        return row?.runtime === undefined ? { isPublic: true } : row.runtime;
      },
    },
    workspaceComputer: {
      findFirst: async ({ where }: { where: unknown }) => {
        lookups.where = where;
        return (
          row && {
            computer: {
              ownerId: row.ownerId,
              kind: row.kind ?? "local",
              cloudSlot: row.cloudSlot ?? null,
            },
            workspace: { members: row.role ? [{ role: row.role }] : [] },
          }
        );
      },
    },
  } as never);
  return Object.assign(authorization, { lookups });
}
const scope = { userId: "u", workspaceId: "w", computerId: "c" };
const principal = { userId: "u", workspaceId: "w" };
const defaultCloud = { kind: "cloud", cloudSlot: "default" };
const anotherMembersDefaultCloud = { ownerId: "x", role: "admin", ...defaultCloud };

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

test("another member's default cloud Computer is managed by nobody but its owner, as the Computer list hides it", async () => {
  for (const role of ["owner", "admin"]) {
    expect(await authorization({ ownerId: "x", role, ...defaultCloud }).canManage(scope)).toBe(
      false,
    );
  }
  // Its owner, whatever their Workspace role.
  for (const role of ["member", "admin"]) {
    expect(await authorization({ ownerId: "u", role, ...defaultCloud }).canManage(scope)).toBe(
      true,
    );
  }
  // Every other kind of Computer stays managed by a Workspace owner or admin.
  for (const computer of [
    { kind: "cloud", cloudSlot: "extra" },
    { kind: "local", cloudSlot: null },
  ]) {
    expect(await authorization({ ownerId: "x", role: "admin", ...computer }).canManage(scope)).toBe(
      true,
    );
  }
});

test("an admin who holds the id of another member's default cloud Computer cannot sign it in or out", async () => {
  // Refused before the store, the Computer or the Centrifugo API is reached.
  const runtimeAuth = new RuntimeAuth(
    authorization(anotherMembersDefaultCloud),
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    () => "",
  );
  const input = { computerId: "c", provider: "codex" as const };
  await expect(runtimeAuth.startLogin(principal, input)).rejects.toThrow(
    "Computer is not available",
  );
  await expect(runtimeAuth.logout(principal, { ...input, requestId: "r1" })).rejects.toThrow(
    "Computer is not available",
  );
});

test("an admin who holds the id of another member's default cloud Computer cannot spend its reset credit", async () => {
  const marks: string[] = [];
  const resetCredit = new RuntimeResetCredit({
    authorization: authorization(anotherMembersDefaultCloud),
    computerStatus: { get: async () => true },
    capability: { supports: async () => true },
    results: {
      begin: async () => void marks.push("begin"),
      read: async (requestId) => ({
        protocolMajor: 1,
        requestId,
        workspaceId: "w",
        computerId: "c",
        provider: "codex",
        outcome: "reset",
      }),
    },
    publish: async () => void marks.push("publish"),
  });
  const target = { computerId: "c", provider: "codex" as const };
  expect(
    await resetCredit.start(principal, {
      ...target,
      idempotencyKey: "0b8c1f3e-52d7-4a9c-9a4e-6f1d2c3b4a59",
    }),
  ).toEqual({ status: "refused", reason: "forbidden" });
  expect(await resetCredit.read(principal, { ...target, requestId: "r1" })).toEqual({
    status: "refused",
    reason: "forbidden",
  });
  expect(marks).toEqual([]);
});

test("a Computer taken off the list (soft-deleted) is managed by nobody, in the same query", async () => {
  for (const row of [
    { ownerId: "u", role: "member" },
    { ownerId: "x", role: "admin" },
  ]) {
    const live = authorization(row);
    await live.canManage(scope);
    // The connection must be to a Computer the list would still show as existing.
    expect(live.lookups.where).toMatchObject({ computer: { deletedAt: null } });
  }
});

const codex = { provider: "codex" as const };

test("for a runtime, a Workspace owner or admin who is not the Computer's owner needs it visible to them, as the Computer page lists it", async () => {
  for (const role of ["owner", "admin"]) {
    const publicRuntime = authorization({ ownerId: "x", role, runtime: { isPublic: true } });
    expect(await publicRuntime.canManage({ ...scope, ...codex })).toBe(true);
    const privateRuntime = authorization({ ownerId: "x", role, runtime: { isPublic: false } });
    expect(await privateRuntime.canManage({ ...scope, ...codex })).toBe(false);
    // A runtime the Computer has not reported is not on the page either.
    const unreported = authorization({ ownerId: "x", role, runtime: null });
    expect(await unreported.canManage({ ...scope, ...codex })).toBe(false);
  }
});

test("the Computer's owner manages their own private runtime without a runtime lookup, and the Computer alone needs none", async () => {
  const owner = authorization({ ownerId: "u", role: "member", runtime: { isPublic: false } });
  expect(await owner.canManage({ ...scope, ...codex })).toBe(true);
  expect(owner.lookups.runtime).toBe(0);
  const computerOnly = authorization({ ownerId: "x", role: "admin", runtime: { isPublic: false } });
  expect(await computerOnly.canManage(scope)).toBe(true);
  expect(computerOnly.lookups.runtime).toBe(0);
});

test("an admin cannot sign in, sign out or spend a reset credit on a private runtime of another member's Computer", async () => {
  const privateRuntime = authorization({
    ownerId: "x",
    role: "admin",
    runtime: { isPublic: false },
  });
  const runtimeAuth = new RuntimeAuth(
    privateRuntime,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    () => "",
  );
  const input = { computerId: "c", provider: "codex" as const };
  await expect(runtimeAuth.startLogin(principal, input)).rejects.toThrow(
    "Computer is not available",
  );
  await expect(runtimeAuth.requestStatusRead(principal, input)).rejects.toThrow(
    "Computer is not available",
  );
  await expect(runtimeAuth.logout(principal, { ...input, requestId: "r1" })).rejects.toThrow(
    "Computer is not available",
  );
  const resetCredit = new RuntimeResetCredit({
    authorization: privateRuntime,
    computerStatus: { get: async () => true },
    capability: { supports: async () => true },
    results: { begin: async () => {}, read: async () => undefined },
    publish: async () => {},
  });
  expect(
    await resetCredit.start(principal, {
      ...input,
      idempotencyKey: "0b8c1f3e-52d7-4a9c-9a4e-6f1d2c3b4a59",
    }),
  ).toEqual({ status: "refused", reason: "forbidden" });
});

test("a login an admin started on a public runtime stops answering once the owner makes it private", async () => {
  const row = { ownerId: "x", role: "admin", runtime: { isPublic: true } };
  const login = {
    loginId: "l1",
    provider: "codex" as const,
    userId: "u",
    startedAt: 0,
    sequence: 0,
  };
  const logout = { requestId: "r1", provider: "codex" as const, userId: "u" };
  const published: unknown[] = [];
  const runtimeAuth = new RuntimeAuth(
    authorization(row),
    { read: async () => login, readLogout: async () => logout } as never,
    { publish: async (...args: unknown[]) => void published.push(args) } as never,
    {} as never,
    {} as never,
    () => "",
  );
  const input = { computerId: "c" };
  // While the runtime is public the starter carries on.
  expect(await runtimeAuth.readLogin(principal, { ...input, loginId: "l1" })).toMatchObject({
    loginId: "l1",
  });
  expect(await runtimeAuth.readLogout(principal, { ...input, requestId: "r1" })).toBeDefined();

  row.runtime = { isPublic: false };
  const after = new RuntimeAuth(
    authorization(row),
    { read: async () => login, readLogout: async () => logout } as never,
    { publish: async (...args: unknown[]) => void published.push(args) } as never,
    {} as never,
    {} as never,
    () => "",
  );
  const refused = "Computer is not available";
  await expect(after.readLogin(principal, { ...input, loginId: "l1" })).rejects.toThrow(refused);
  await expect(
    after.submitCode(principal, { ...input, loginId: "l1", code: "abc" }),
  ).rejects.toThrow(refused);
  await expect(after.cancelLogin(principal, { ...input, loginId: "l1" })).rejects.toThrow(refused);
  await expect(after.readLogout(principal, { ...input, requestId: "r1" })).rejects.toThrow(refused);
  expect(published).toEqual([]);
});
