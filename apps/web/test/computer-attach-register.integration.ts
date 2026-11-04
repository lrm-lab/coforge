import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import {
  approveAttachSession,
  pollAttachSession,
  startAttachSession,
} from "#src/server/computers/computer-attach.server";
import { createComputerHttpHandler } from "#src/server/computers/computer-http.server";
import { generateKeyPair, exportJWK } from "jose";

/** The at_ register path (task #417): `computer:register` consumes the one-shot attach token
 * and resolves the machine's Workspace from the token's bound id — the body slug never
 * overrides it, and an empty one is fine for a token-bound register. */
const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const handle = crypto.randomUUID().slice(0, 8);
const people: Record<"alice" | "bob", string> = { alice: "", bob: "" };
let secondWorkspaceId: string;

await (async () => {
  const { privateKey } = await generateKeyPair("EdDSA", { extractable: true });
  const jwk = await exportJWK(privateKey);
  jwk.alg = "EdDSA";
  process.env.COFORGE_WORKER_JWT_PRIVATE_JWK = JSON.stringify(jwk);
  process.env.COFORGE_WORKER_JWT_KEY_ID = "test";
})();

const envelope = (method: string, b64data: Uint8Array) =>
  JSON.stringify({ method, b64data: Buffer.from(b64data).toString("base64") });

const start = () =>
  startAttachSession(db, {
    machineName: "dev",
    hostname: "dev.local",
    os: "linux",
    origin: "http://local",
  });

beforeAll(async () => {
  for (const name of Object.keys(people) as (keyof typeof people)[]) {
    const user = await db.user.create({
      data: { username: `car-${name}-${handle}`, displayName: name },
    });
    people[name] = user.id;
  }
  await db.workspace.create({
    data: {
      slug: `ca-${handle}`,
      name: "One",
      members: { create: { userId: people.alice, role: "owner" } },
    },
  });
  const second = await db.workspace.create({
    data: {
      slug: `car2-${crypto.randomUUID().slice(0, 8)}`,
      name: "Two",
      members: { create: { userId: people.bob, role: "owner" } },
    },
  });
  secondWorkspaceId = second.id;
});

afterAll(async () => {
  await db.computer.deleteMany({ where: { ownerId: people.alice } });
  await db.computer.deleteMany({ where: { ownerId: people.bob } });
  await db.computerAttachSession.deleteMany({});
  await db.workspace.deleteMany({
    where: { slug: { startsWith: "car-" } },
  });
  await db.user.deleteMany({ where: { id: { in: [people.alice, people.bob] } } });
  await db.$disconnect();
});

test("the HTTP register route refuses a body workspaceSlug the token did not bind (issue 1)", async () => {
  // The approval binds secondWorkspaceId; a body naming the first is refused through the real
  // route — the token, not the caller's slug, decides where the machine lands.
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
  const { encodeComputerRegisterRequest } = await import("@lrm/coforge-sdk/internal");
  const response = await createComputerHttpHandler().handleRequest(
    new Request("http://server/api/computer/attach", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${attachToken}`,
      },
      body: envelope(
        "computer:v1:register",
        encodeComputerRegisterRequest({
          protocolMajor: 1,
          requestId: crypto.randomUUID(),
          workspaceSlug: `ca-${handle}`,
          name: "dev",
          displayName: "dev",
          machineId: "dev",
          platform: "linux",
          osVersion: "1",
          computerVersion: "1",
          registrationIdempotencyKey: crypto.randomUUID(),
        }),
      ),
    }),
  );
  // A Centrifugo-RPC refusal is an `{error: {code}}` body, not an HTTP status.
  const body = await response.json();
  expect(body).toMatchObject({ error: { code: 403 } });
});

test("the HTTP register route accepts an at_ token whose body slug matches its bound workspace", async () => {
  const second = await db.workspace.create({
    data: {
      slug: `ca2-${crypto.randomUUID().slice(0, 8)}`,
      name: "Two",
      members: { create: { userId: people.alice, role: "owner" } },
    },
  });
  const session = await start();
  await approveAttachSession(db, {
    sessionId: session.sessionId,
    userId: people.alice,
    workspaceId: second.id,
  });
  const { attachToken } = (await pollAttachSession(db, {
    deviceCode: session.deviceCode,
  })) as { attachToken: string };
  const { encodeComputerRegisterRequest } = await import("@lrm/coforge-sdk/internal");
  const response = await createComputerHttpHandler().handleRequest(
    new Request("http://server/api/computer/attach", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${attachToken}`,
      },
      body: envelope(
        "computer:v1:register",
        encodeComputerRegisterRequest({
          protocolMajor: 1,
          requestId: crypto.randomUUID(),
          workspaceSlug: second.slug,
          name: "dev",
          displayName: "dev",
          machineId: "dev-success",
          platform: "linux",
          osVersion: "1",
          computerVersion: "1",
          registrationIdempotencyKey: crypto.randomUUID(),
        }),
      ),
    }),
  );
  const result = await response.json();
  expect(result.result).toBeDefined();
});

test("the HTTP register route accepts an at_ token with an empty slug, naming its bound workspace", async () => {
  // The one-shot CLI sends no slug — the token's bound workspace decides it (task #417).
  const second = await db.workspace.create({
    data: {
      slug: `car3-${crypto.randomUUID().slice(0, 8)}`,
      name: "Three",
      members: { create: { userId: people.alice, role: "owner" } },
    },
  });
  const session = await start();
  await approveAttachSession(db, {
    sessionId: session.sessionId,
    userId: people.alice,
    workspaceId: second.id,
  });
  const { attachToken } = (await pollAttachSession(db, {
    deviceCode: session.deviceCode,
  })) as { attachToken: string };
  const { encodeComputerRegisterRequest, decodeComputerRegisterResponse } =
    await import("@lrm/coforge-sdk/internal");
  const response = await createComputerHttpHandler().handleRequest(
    new Request("http://server/api/computer/attach", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${attachToken}`,
      },
      body: envelope(
        "computer:v1:register",
        encodeComputerRegisterRequest({
          protocolMajor: 1,
          requestId: crypto.randomUUID(),
          workspaceSlug: "",
          name: "dev",
          displayName: "dev",
          machineId: "dev-empty-slug",
          platform: "linux",
          osVersion: "1",
          computerVersion: "1",
          registrationIdempotencyKey: crypto.randomUUID(),
        }),
      ),
    }),
  );
  const result = await response.json();
  const registered = decodeComputerRegisterResponse(
    new Uint8Array(Buffer.from(result.result.b64data, "base64")),
  );
  expect(registered.workspaceId).toBe(second.id);
  expect(registered.workspaceSlug).toBe(second.slug);
});
