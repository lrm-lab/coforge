import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  approveAttachSession,
  authenticateComputerAttach,
  consumeAttachToken,
  resolveAttachToken,
  pollAttachSession,
  readAttachSession,
  refuseAttachSession,
  retireComputerSession,
  startAttachSession,
} from "#src/server/computers/computer-attach.server";
import { mintOpaqueToken, sha256Hex } from "#src/server/auth/opaque-token.server";
import { signComputerAccessToken } from "#src/server/auth/computer-access-token.server";
import { generateKeyPair, exportJWK } from "jose";

/**
 * The one-shot Computer attach (task #417): a machine reports itself, a person approves on the
 * page, the deviceCode polls a single-use attachToken, and `computer:register` consumes it for
 * an `sk_computer` — plus `retire-session`, which retires the login the setup left behind and
 * nothing else.
 */
const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const handle = crypto.randomUUID().slice(0, 8);

let workspaceId: string;
let secondWorkspaceId: string;
const people: Record<"alice" | "bob", string> = { alice: "", bob: "" };
let computerId: string;
let skComputer = "";

// The login/verify path needs a signing env the tests provide: a throwaway EdDSA key.
const testEnv = await (async () => {
  const { privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  const jwk = await exportJWK(privateKey);
  jwk.alg = "EdDSA";
  return {
    COFORGE_WORKER_JWT_PRIVATE_JWK: JSON.stringify(jwk),
    COFORGE_WORKER_JWT_KEY_ID: "test",
  };
})();

const bearer = (token: string) =>
  new Request("http://local/api/computer/attach", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });

beforeAll(async () => {
  for (const name of Object.keys(people) as (keyof typeof people)[]) {
    const user = await db.user.create({
      data: { username: `ca-${name}-${handle}`, displayName: name },
    });
    people[name] = user.id;
  }
  const workspace = await db.workspace.create({
    data: {
      slug: `ca-${handle}`,
      name: "Attach",
      members: {
        create: [
          { userId: people.alice, role: "owner" },
          { userId: people.bob, role: "member" },
        ],
      },
    },
  });
  workspaceId = workspace.id;
  secondWorkspaceId = (
    await db.workspace.create({
      data: {
        slug: `ca2-${handle}`,
        name: "Other",
        members: { create: [{ userId: people.bob, role: "owner" }] },
      },
    })
  ).id;
  const computer = await db.computer.create({
    data: {
      ownerId: people.alice,
      machineId: `ca-${handle}`,
      name: "ca-computer",
      displayName: "ca",
    },
  });
  computerId = computer.id;
  await db.workspaceComputer.create({ data: { workspaceId, computerId } });
  skComputer = `sk_computer_${mintOpaqueToken()}`;
  await db.daemonApiKey.create({
    data: {
      apiKeyHash: sha256Hex(skComputer),
      ownerId: people.alice,
      workspaceId,
      computerId,
      kind: "computer",
    },
  });
});

afterAll(async () => {
  await db.workspace.deleteMany({
    where: {
      OR: [{ id: { in: [workspaceId, secondWorkspaceId] } }, { slug: { startsWith: "ca2-" } }],
    },
  });
  // Every computer the test people own — the register paths mint new ones, not only `computerId`.
  await db.computer.deleteMany({ where: { ownerId: { in: Object.values(people) } } });
  await db.user.deleteMany({ where: { id: { in: Object.values(people) } } });
  await db.$disconnect();
});

const start = (overrides: Partial<Parameters<typeof startAttachSession>[1]> = {}) =>
  startAttachSession(db, {
    machineName: "dev-box",
    hostname: "dev.local",
    os: "linux x86_64",
    origin: "http://local",
    ...overrides,
  });

test("start answers a deviceCode, a compareable userCode, and a link without the secret", async () => {
  const session = await start();
  expect(session.deviceCode).toMatch(/^cd_[A-Za-z0-9_-]{43}$/);
  expect(session.userCode).toMatch(/^[A-Z2-9]{8}$/);
  expect(session.approveUrl).toContain(`/computers/attach/${session.sessionId}`);
  expect(session.approveUrl).not.toContain(session.deviceCode);
  // The approval page's read shows the machine and the code it displays — a pending session only.
  const shown = await readAttachSession(db, session.sessionId);
  expect(shown).toMatchObject({
    machineName: "dev-box",
    hostname: "dev.local",
    os: "linux x86_64",
    userCode: session.userCode,
    status: "pending",
  });
});

test("an unapproved deviceCode only ever hears attach_pending; a refused one access_denied", async () => {
  const session = await start();
  // First poll sets lastPolledAt; an immediate second poll answers slow_down.
  expect(await pollAttachSession(db, { deviceCode: session.deviceCode })).toEqual({
    kind: "pending",
  });
  expect(await pollAttachSession(db, { deviceCode: session.deviceCode })).toEqual({
    kind: "slow_down",
  });
  // A code never issued is the same expiry as a swept one — `expired_token` (task #417).
  expect(await pollAttachSession(db, { deviceCode: "cd_wrong" })).toEqual({ kind: "expired" });
  await refuseAttachSession(db, session.sessionId);
  expect(await pollAttachSession(db, { deviceCode: session.deviceCode })).toEqual({
    kind: "denied",
  });
});

test("an expired session answers expired_token", async () => {
  const session = await start();
  const past = new Date(Date.now() + 20 * 60 * 1000);
  expect(await pollAttachSession(db, { deviceCode: session.deviceCode }, past)).toEqual({
    kind: "expired",
  });
});

test("the approved poll hands one token once; consume resolves it to the bound workspace", async () => {
  const session = await start();
  await approveAttachSession(db, {
    sessionId: session.sessionId,
    userId: people.alice,
    workspaceId,
  });
  // A poll before the interval still settles first: the token itself is the answer.
  const first = await pollAttachSession(db, { deviceCode: session.deviceCode });
  expect(first).toMatchObject({ kind: "token" });
  const attachToken = (first as { attachToken: string }).attachToken;
  expect(attachToken).toMatch(/^at_[A-Za-z0-9_-]{43}$/);
  // A second poll does not hand it out again — the hash it kept is the only copy. Past the
  // interval it answers pending, and inside it slow_down; neither replays the token.
  expect(await pollAttachSession(db, { deviceCode: session.deviceCode })).toEqual({
    kind: "slow_down",
  });
  const later = new Date(Date.now() + 4 * 1000);
  expect(await pollAttachSession(db, { deviceCode: session.deviceCode }, later)).toEqual({
    kind: "pending",
  });
  // The token resolves to the bound user + workspace, and only once.
  const resolved = await resolveAttachToken(db, attachToken);
  expect(resolved).toMatchObject({ userId: people.alice, workspaceId });
  // Consumption happens inside the register path's transaction — once, then the token is gone.
  const consumed = await db.$transaction((tx) => consumeAttachToken(tx, resolved!.sessionId));
  expect(consumed).toMatchObject({ userId: people.alice, workspaceId });
  expect(await resolveAttachToken(db, attachToken)).toBeNull();
});

test("authenticateComputerAttach answers a token principal for at_, a login for the JWT, and refuses a retired login", async () => {
  // A token resolves to the workspace its approval bound — not the body's slug.
  const session = await start();
  await approveAttachSession(db, {
    sessionId: session.sessionId,
    userId: people.bob,
    workspaceId: secondWorkspaceId,
  });
  const first = await pollAttachSession(db, { deviceCode: session.deviceCode });
  const attachToken = (first as { attachToken: string }).attachToken;
  const principal = await authenticateComputerAttach(bearer(attachToken), db, testEnv);
  expect(principal).toEqual({
    userId: people.bob,
    workspaceId: secondWorkspaceId,
    attachSessionId: session.sessionId,
  });
  // A JWT answers its subject — until the login is retired, after which it is refused.
  const { token } = await signComputerAccessToken(people.alice, testEnv);
  expect(await authenticateComputerAttach(bearer(token), db, testEnv)).toMatchObject({
    userId: people.alice,
    kind: "device",
  });
  await db.computerRetiredLogin.create({
    data: {
      tokenHash: sha256Hex(token),
      userId: people.alice,
      computerId,
      workspaceId,
    },
  });
  expect(await authenticateComputerAttach(bearer(token), db, testEnv)).toBeNull();
});

test("retire-session retires only that login: same user, the device kind", async () => {
  // Same-subject JWTs minted in the same second are identical strings; a new second makes the
  // token this test retires its own.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const { token } = await signComputerAccessToken(people.alice, testEnv);
  const principal = { userId: people.alice, workspaceId, computerId };
  // Only the computer's device login retires — a browser token fails the verify first.
  expect(await retireComputerSession(db, { userToken: "not-a-jwt", principal }, testEnv)).toEqual({
    kind: "session_not_device",
  });
  // Another person's login on this computer is wrong_owner, not retired.
  const { token: bobs } = await signComputerAccessToken(people.bob, testEnv);
  expect(await retireComputerSession(db, { userToken: bobs, principal }, testEnv)).toEqual({
    kind: "wrong_owner",
  });
  // Alice's own retires, once; a repeat is already_retired, never an error.
  expect(await retireComputerSession(db, { userToken: token, principal }, testEnv)).toEqual({
    kind: "retired",
  });
  expect(await retireComputerSession(db, { userToken: token, principal }, testEnv)).toEqual({
    kind: "already_retired",
  });
});

/** The Centrifugo-RPC envelope the HTTP route parses: the method name plus its protobuf body
 * base64'd. */
const envelope = (method: string, payload: Uint8Array) =>
  JSON.stringify({ method, b64data: Buffer.from(payload).toString("base64") });

test("workspace.get refuses an at_ token rather than spending its single use (issue 2)", async () => {
  const session = await start();
  await approveAttachSession(db, {
    sessionId: session.sessionId,
    userId: people.bob,
    workspaceId: secondWorkspaceId,
  });
  const { attachToken } = (await pollAttachSession(db, {
    deviceCode: session.deviceCode,
  })) as { attachToken: string };
  const { createComputerHttpHandler } = await import("#src/server/computers/computer-http.server");
  const { encodeWorkspaceGetRequest, WORKSPACE_GET_METHOD } =
    await import("@lrm/coforge-sdk/internal");
  const response = await createComputerHttpHandler().handleRequest(
    new Request("http://server/api/computer/workspace", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${attachToken}`,
      },
      body: envelope(
        WORKSPACE_GET_METHOD,
        encodeWorkspaceGetRequest({
          protocolMajor: 1,
          requestId: crypto.randomUUID(),
          workspaceSlug: `ca-${handle}`,
        }),
      ),
    }),
  );
  expect((await response.json()).error.code).toBe(403);
  // And the token was never spent — it still resolves for the register it is for.
  expect(await resolveAttachToken(db, attachToken)).not.toBeNull();
});

test("retire-session refuses a real browser realtime token (issue 3)", async () => {
  const { issueBrowserRealtimeToken } =
    await import("#src/server/auth/browser-realtime-token.server");
  const browser = await issueBrowserRealtimeToken({ userId: people.alice, workspaceId }, testEnv);
  const principal = { userId: people.alice, workspaceId, computerId };
  expect(await retireComputerSession(db, { userToken: browser, principal }, testEnv)).toEqual({
    kind: "session_not_device",
  });
});

test("two concurrent retire calls race to one row, never a 500 (issue 8)", async () => {
  const { token } = await signComputerAccessToken(people.alice, testEnv);
  const principal = { userId: people.alice, workspaceId, computerId };
  const results = await Promise.all([
    retireComputerSession(db, { userToken: token, principal }, testEnv),
    retireComputerSession(db, { userToken: token, principal }, testEnv),
  ]);
  expect(results.map((result) => result.kind).sort()).toEqual(["already_retired", "retired"]);
});

test("detach answers computer_key_revoked for a found-but-revoked key", async () => {
  const { Route } = await import("#src/routes/api/computer/detach");
  const { hashDaemonApiKey } = await import("#src/server/auth/daemon-api-key.server");
  const apiKey = "sk_computer_detached";
  await db.daemonApiKey.create({
    data: {
      kind: "computer",
      workspaceId,
      computerId,
      ownerId: people.alice,
      apiKeyHash: hashDaemonApiKey(apiKey),
      revokedAt: new Date(),
    },
  });
  const post = (
    Route.options.server!.handlers as unknown as {
      POST: (ctx: { request: Request }) => Promise<Response>;
    }
  ).POST;
  const response = await post({
    request: new Request("http://server/api/computer/detach", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
    }),
  });
  expect(response.status).toBe(410);
  expect((await response.json()).error).toBe("computer_key_revoked");
});
test("the sweep keeps an approved session until its token's own ten minutes runs", async () => {
  const session = await start();
  await approveAttachSession(db, {
    sessionId: session.sessionId,
    userId: people.alice,
    workspaceId,
  });
  // A poll near the session's expiry mints a token whose ten minutes outlives it.
  const row = await db.computerAttachSession.findUniqueOrThrow({
    where: { id: session.sessionId },
    select: { expiresAt: true },
  });
  const nearExpiry = new Date(row.expiresAt.getTime() - 60_000);
  const { attachToken } = (await pollAttachSession(
    db,
    { deviceCode: session.deviceCode },
    nearExpiry,
  )) as { attachToken: string };
  expect(attachToken).toMatch(/^at_/);
  // Five minutes past the session's expiry, still inside the token's ten — the sweep keeps it.
  const inside = new Date(row.expiresAt.getTime() + 5 * 60_000);
  const { sweepComputerAttach } =
    await import("#src/server/computers/computer-attach-sweep.server");
  await sweepComputerAttach(inside);
  expect(
    await db.computerAttachSession.findUnique({ where: { id: session.sessionId } }),
  ).not.toBeNull();
  // Past the token's ten minutes the sweep takes it.
  const past = new Date(nearExpiry.getTime() + 11 * 60_000);
  await sweepComputerAttach(past);
  expect(
    await db.computerAttachSession.findUnique({ where: { id: session.sessionId } }),
  ).toBeNull();
});
