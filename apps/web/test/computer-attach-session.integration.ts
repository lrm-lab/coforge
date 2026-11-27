import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  ComputerAttachErrorCode,
  computerAttachWire,
  ComputerAttachSessionIntent,
  ComputerAttachSessionState,
} from "@lrm/coforge-sdk/internal/computer-attach-session";
import { attachProofBytes } from "@lrm/coforge-sdk/internal/computer-attach-proof";
import { hashDaemonApiKey } from "#src/server/auth/daemon-api-key.server";
import { markComputerAttachReady } from "#src/server/computers/computer-attach-ready.server";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { pollAttachSession } from "#src/server/computers/computer-attach.server";
import {
  createComputerAttachSession,
  decideComputerAttachSession,
  pollComputerAttachSession,
} from "#src/server/computers/computer-attach-session.server";

import {
  completeComputerAttachSession,
  preflightComputerAttachSession,
} from "#src/server/computers/computer-attach-session-activation.server";

import {
  computerAttachCapabilities,
  openComputerAttachSession,
  runComputerAttachOperation,
} from "#src/server/computers/computer-attach-session-http.server";

import {
  listMachineAttachRequests,
  readMachineAttachApproval,
  sweepMachineAttachSessions,
} from "#src/server/computers/computer-attach-visibility.server";

const connectionString = Bun.env.DATABASE_URL;
if (!connectionString || new URL(connectionString).hostname !== "127.0.0.1")
  throw new Error("DATABASE_URL must point to scratch PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const origin = "https://attach.example";
const suffix = crypto.randomUUID().slice(0, 8);
const workspaceSlug = `ca-session-${suffix}`;
const foreignSlug = `ca-session-other-${suffix}`;
const users: Record<"admin" | "member" | "foreign", string> = {
  admin: "",
  member: "",
  foreign: "",
};
let workspaceId: string;
let foreignId: string;

beforeAll(async () => {
  for (const name of ["admin", "member", "foreign"] as const) {
    const user = await db.user.create({
      data: { username: `ca-session-${name}-${suffix}`, displayName: name },
    });
    users[name] = user.id;
  }
  const workspace = await db.workspace.create({
    data: {
      slug: workspaceSlug,
      name: "Attach target",
      members: {
        create: [
          { userId: users.admin, role: "admin" },
          { userId: users.member, role: "member" },
        ],
      },
    },
  });
  workspaceId = workspace.id;
  const foreign = await db.workspace.create({
    data: {
      slug: foreignSlug,
      name: "Other workspace",
      members: { create: { userId: users.foreign, role: "admin" } },
    },
  });
  foreignId = foreign.id;
});

afterAll(async () => {
  await db.computerAttachSession.deleteMany({ where: { machineName: suffix } });
  await db.computer.deleteMany({
    where: { ownerId: { in: Object.values(users).filter(Boolean) } },
  });
  await db.workspace.deleteMany({ where: { slug: { in: [workspaceSlug, foreignSlug] } } });
  await db.user.deleteMany({ where: { id: { in: Object.values(users).filter(Boolean) } } });
  await db.$disconnect();
});

async function start(now: Date) {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  if (!("publicKey" in pair)) throw new TypeError("Expected a key pair");
  const machinePublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const request = computerAttachWire.createRequest.decode(
    computerAttachWire.createRequest.encode({
      protocolMajor: 1,
      machineId: crypto.randomUUID(),
      machineName: suffix,
      hostname: "fixture.example",
      platform: "linux",
      workspaceSlug,
      intent: ComputerAttachSessionIntent.ATTACH,
      machinePublicKey,
    }),
  );
  const session = await createComputerAttachSession(db, request, { origin, now });
  return {
    ...session,
    privateKey: pair.privateKey,
    machinePublicKey,
    machineId: request.machineId,
  };
}

test("a targeted session only accepts the actual user code and the target Workspace admin", async () => {
  const now = new Date();
  const started = await start(now);
  const decision = {
    sessionId: started.sessionId,
    userCode: started.userCode!,
    userId: users.admin,
    workspaceId,
    action: "approve" as const,
  };
  expect(new URL(started.verificationUri!).search).toBe("");
  expect(started.verificationUri).not.toContain(started.userCode!);
  expect(await decideComputerAttachSession(db, { ...decision, userCode: "wrong" }, now)).toBe(
    false,
  );
  expect(await decideComputerAttachSession(db, { ...decision, userId: users.member }, now)).toBe(
    false,
  );
  expect(
    await decideComputerAttachSession(
      db,
      { ...decision, workspaceId: foreignId, userId: users.foreign },
      now,
    ),
  ).toBe(false);
  expect(await decideComputerAttachSession(db, decision, now)).toBe(true);
  expect(await db.workspaceComputer.count({ where: { workspaceId } })).toBe(0);
  expect(await pollAttachSession(db, { deviceCode: started.pollSecret }, now)).toEqual({
    kind: "expired",
  });
  const polled = await pollComputerAttachSession(db, started.sessionId, started.pollSecret, now);
  expect(polled).toMatchObject({ state: ComputerAttachSessionState.APPROVED, workspaceId });
  expect(polled.challenge).toMatchObject({ expiresInSeconds: 300 });
  expect(polled.challenge?.attachTicket).toBeTruthy();
});

test("records explicit approval and completion deadlines without issuing a key", async () => {
  const now = new Date();
  const started = await start(now);
  await decideComputerAttachSession(
    db,
    {
      sessionId: started.sessionId,
      userCode: started.userCode!,
      userId: users.admin,
      workspaceId,
      action: "approve",
    },
    now,
  );
  const deadline = new Date(now.getTime() + 600_000);
  await expect(
    pollComputerAttachSession(db, started.sessionId, started.pollSecret, deadline),
  ).rejects.toMatchObject({
    code: ComputerAttachErrorCode.COMPLETION_TIMEOUT,
  });
  expect(
    await db.computerAttachSession.findUnique({ where: { id: started.sessionId } }),
  ).toMatchObject({
    status: "failed",
    terminalAt: deadline,
    candidateKeyHash: null,
  });
});

test("candidate issuance creates no binding and concurrent preflights activate exactly once", async () => {
  const now = new Date();
  const started = await start(now);
  await decideComputerAttachSession(
    db,
    {
      sessionId: started.sessionId,
      userCode: started.userCode!,
      userId: users.admin,
      workspaceId,
      action: "approve",
    },
    now,
  );
  const polled = await pollComputerAttachSession(db, started.sessionId, started.pollSecret, now);
  const { nonce, attachTicket } = polled.challenge!;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      started.privateKey,
      attachProofBytes({ origin, sessionId: started.sessionId, purpose: "complete", nonce }),
    ),
  );
  const completed = await completeComputerAttachSession(
    db,
    started.sessionId,
    {
      nonce,
      attachTicket,
      signature,
    },
    { origin, now },
  );

  expect(completed).toMatchObject({ workspaceId, resumed: false });
  expect(
    await db.workspaceComputer.count({ where: { workspaceId, computerId: completed.computerId } }),
  ).toBe(0);
  expect(await db.daemonApiKey.count({ where: { computerId: completed.computerId } })).toBe(0);
  await expect(
    completeComputerAttachSession(
      db,
      started.sessionId,
      {
        nonce,
        attachTicket,
        signature,
      },
      { origin, now },
    ),
  ).rejects.toMatchObject({ code: ComputerAttachErrorCode.TICKET_CONSUMED });

  const [one, two] = await Promise.all([
    preflightComputerAttachSession(db, started.sessionId, completed.apiKey, now),
    preflightComputerAttachSession(db, started.sessionId, completed.apiKey, now),
  ]);
  expect(one).toEqual(two);
  expect(one).toMatchObject({ workspaceId, computerId: completed.computerId });
  expect(
    await db.workspaceComputer.count({ where: { workspaceId, computerId: completed.computerId } }),
  ).toBe(1);
  expect(
    await db.daemonApiKey.count({ where: { computerId: completed.computerId, revokedAt: null } }),
  ).toBe(1);
  const scope = { workspaceId, computerId: completed.computerId };
  expect(await markComputerAttachReady(db, { ...scope, apiKeyHash: "0".repeat(64) }, now)).toBe(0);
  expect(
    await markComputerAttachReady(
      db,
      { ...scope, apiKeyHash: hashDaemonApiKey(completed.apiKey) },
      now,
    ),
  ).toBe(1);
  expect(
    await markComputerAttachReady(
      db,
      { ...scope, apiKeyHash: hashDaemonApiKey(completed.apiKey) },
      now,
    ),
  ).toBe(0);
  expect(
    await db.computerAttachSession.findUnique({ where: { id: started.sessionId } }),
  ).toMatchObject({
    status: "ready",
    readyAt: now,
  });
});

test("the four HTTP operations use no-store binary frames and reject unproven identity adoption", async () => {
  const capability = computerAttachCapabilities();
  expect(capability.headers.get("cache-control")).toBe("no-store");
  expect(
    computerAttachWire.capabilities.decode(new Uint8Array(await capability.arrayBuffer()))
      .protocolMajor,
  ).toBe(1);
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  if (!("publicKey" in pair)) throw new TypeError("Expected a key pair");
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const payload = {
    protocolMajor: 1,
    machineId: crypto.randomUUID(),
    machineName: suffix,
    hostname: "fixture.example",
    platform: "linux",
    workspaceSlug,
    intent: ComputerAttachSessionIntent.ATTACH,
    machinePublicKey: publicKey,
  };
  const post = (body?: Uint8Array, apiKey?: string) =>
    new Request(origin + "/api/computer/attach/sessions", {
      method: "POST",
      body: body ? Uint8Array.from(body) : undefined,
      headers: {
        "content-type": "application/protobuf",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
    });
  const unproven = await openComputerAttachSession(
    post(
      computerAttachWire.createRequest.encode({
        ...payload,
        existingComputerId: crypto.randomUUID(),
      }),
    ),
    { db },
  );
  expect(unproven.status).toBe(401);
  const created = await openComputerAttachSession(
    post(computerAttachWire.createRequest.encode(payload)),
    { db },
  );
  expect(created.status).toBe(201);
  const { sessionId, pollSecret, userCode } = computerAttachWire.createResponse.decode(
    new Uint8Array(await created.arrayBuffer()),
  );
  expect(created.headers.get("cache-control")).toBe("no-store");

  await decideComputerAttachSession(db, {
    sessionId,
    userCode: userCode!,
    userId: users.admin,
    workspaceId,
    action: "approve",
  });
  const polled = await runComputerAttachOperation(
    db,
    sessionId,
    "poll",
    post(computerAttachWire.pollRequest.encode({ pollSecret })),
  );
  const { challenge } = computerAttachWire.pollResponse.decode(
    new Uint8Array(await polled.arrayBuffer()),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "Ed25519",
      pair.privateKey,
      attachProofBytes({ sessionId, origin, purpose: "complete", nonce: challenge!.nonce }),
    ),
  );
  const issued = await runComputerAttachOperation(
    db,
    sessionId,
    "complete",
    post(
      computerAttachWire.completeRequest.encode({
        signature,
        nonce: challenge!.nonce,
        attachTicket: challenge!.attachTicket,
      }),
    ),
  );
  expect(issued.status).toBe(201);
  const binding = computerAttachWire.completeResponse.decode(
    new Uint8Array(await issued.arrayBuffer()),
  );
  expect(issued.headers.get("cache-control")).toBe("no-store");
  const preflight = await runComputerAttachOperation(
    db,
    sessionId,
    "preflight",
    post(undefined, binding.apiKey),
  );
  expect(preflight.status).toBe(200);
  expect(
    computerAttachWire.preflightResponse.decode(new Uint8Array(await preflight.arrayBuffer())),
  ).toMatchObject({
    workspaceId,
    computerId: binding.computerId,
  });
});

test("only current Workspace admins can read scoped sessions and terminal history survives the sweep", async () => {
  const now = new Date();
  const started = await start(now);
  const row = (await listMachineAttachRequests(db, workspaceId, users.admin, now)).find(
    ({ id }) => id === started.sessionId,
  );
  expect(row).toMatchObject({
    id: started.sessionId,
    status: "awaiting_approval",
    machineName: suffix,
  });
  expect(row).not.toHaveProperty("userCode");
  expect(row).not.toHaveProperty("deviceCodeHash");
  expect(await listMachineAttachRequests(db, workspaceId, users.member, now)).toEqual([]);
  expect(await listMachineAttachRequests(db, workspaceId, users.foreign, now)).toEqual([]);
  expect(await readMachineAttachApproval(db, started.sessionId, users.foreign, now)).toBeNull();

  const expired = new Date(now.getTime() + 600_100);
  await sweepMachineAttachSessions(db, expired);
  expect(
    (await listMachineAttachRequests(db, workspaceId, users.admin, expired)).find(
      ({ id }) => id === started.sessionId,
    ),
  ).toMatchObject({ status: "expired", failureReason: "approval_expired" });
  await sweepMachineAttachSessions(db, new Date(expired.getTime() + 86_400_001));
  expect(
    await db.computerAttachSession.findUnique({ where: { id: started.sessionId } }),
  ).toBeNull();
});

test("recovers a lost complete response, reissues safely, and respects unlink", async () => {
  const now = new Date();
  const started = await start(now);
  const approve = {
    sessionId: started.sessionId,
    userCode: started.userCode!,
    userId: users.admin,
    workspaceId,
    action: "approve" as const,
  };
  expect(await decideComputerAttachSession(db, approve, now)).toBe(true);
  const proof = async (sessionId: string, nonce: string, purpose: "complete" | "resume") =>
    new Uint8Array(
      await crypto.subtle.sign(
        "Ed25519",
        started.privateKey,
        attachProofBytes({ origin, sessionId, purpose, nonce }),
      ),
    );

  const first = (await pollComputerAttachSession(db, started.sessionId, started.pollSecret, now))
    .challenge!;
  const lost = await completeComputerAttachSession(
    db,
    started.sessionId,
    {
      nonce: first.nonce,
      attachTicket: first.attachTicket,
      signature: await proof(started.sessionId, first.nonce, "complete"),
    },
    { origin, now },
  );
  const later = new Date(now.getTime() + 3_001);
  const resumed = (
    await pollComputerAttachSession(db, started.sessionId, started.pollSecret, later)
  ).challenge!;
  const next = await completeComputerAttachSession(
    db,
    started.sessionId,
    {
      nonce: resumed.nonce,
      signature: await proof(started.sessionId, resumed.nonce, "resume"),
    },
    { origin, now: later },
  );
  expect(next).toMatchObject({ computerId: lost.computerId, resumed: true });
  await expect(
    preflightComputerAttachSession(db, started.sessionId, lost.apiKey, later),
  ).rejects.toMatchObject({
    code: ComputerAttachErrorCode.INVALID_CREDENTIAL,
  });
  await preflightComputerAttachSession(db, started.sessionId, next.apiKey, later);

  const recoverPayload = computerAttachWire.createRequest.decode(
    computerAttachWire.createRequest.encode({
      protocolMajor: 1,
      machineId: started.machineId,
      machineName: suffix,
      hostname: "fixture.example",
      platform: "linux",
      machinePublicKey: started.machinePublicKey,
      intent: ComputerAttachSessionIntent.RECOVER,
      existingComputerId: next.computerId,
      workspaceSlug,
    }),
  );
  const recovery = await createComputerAttachSession(db, recoverPayload, { origin, now: later });
  const challenge = (
    await pollComputerAttachSession(db, recovery.sessionId, recovery.pollSecret, later)
  ).challenge!;
  const replacement = await completeComputerAttachSession(
    db,
    recovery.sessionId,
    {
      nonce: challenge.nonce,
      signature: await proof(recovery.sessionId, challenge.nonce, "resume"),
    },
    { origin, now: later },
  );
  const live = () =>
    db.daemonApiKey.findMany({
      where: { workspaceId, computerId: next.computerId, revokedAt: null },
      select: { apiKeyHash: true },
    });
  expect(await live()).toEqual([{ apiKeyHash: hashDaemonApiKey(next.apiKey) }]);
  await preflightComputerAttachSession(db, recovery.sessionId, replacement.apiKey, later);
  expect(await live()).toEqual([{ apiKeyHash: hashDaemonApiKey(replacement.apiKey) }]);

  await db.workspaceComputer.delete({
    where: { workspaceId_computerId: { workspaceId, computerId: next.computerId } },
  });
  await expect(
    createComputerAttachSession(db, recoverPayload, { origin, now: later }),
  ).rejects.toMatchObject({
    code: ComputerAttachErrorCode.RECOVERY_UNAVAILABLE,
  });
});
