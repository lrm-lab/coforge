import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { shareArtifactInputSchema } from "#src/features/artifacts/artifact-share-input";
import { peopleDirectKey } from "#src/features/conversations/direct-key";
import { isAppError } from "#src/lib/app-error";
import { ArtifactShares } from "#src/server/artifacts/artifact-shares.server";
import { Artifacts, type ArtifactBlobStore } from "#src/server/artifacts/artifacts.server";
import { postUserMessage } from "#src/server/conversations/user-message-post.server";
import { quietCentrifugo } from "./helpers/fake-centrifugo";

/**
 * A person's artifact share from the web (artifacts task #2): the share service with the person's
 * own send into channels and DMs (`postUserMessage`). The person must be able to read the
 * artifact, or nothing is sent anywhere; each destination then takes their send there or fails
 * with a reason; documents off refuses everything. The request names no actor and is capped.
 */
const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const handle = crypto.randomUUID().slice(0, 8);

const store: ArtifactBlobStore = {
  inspectMany: async () => new Map(),
  use: async () => [],
  read: async () => null,
  allowed: async (_workspaceId, _artifactId, _actor, sha256s) => new Set(sha256s),
};

let workspaceId: string;
const people = { alice: "", bob: "", carol: "" };
const rooms = {
  closed: "", // private, Alice's: the artifact's home
  open: "", // public, Alice is in it
  archived: "", // public, Alice is in it, archived
  unjoined: "", // public, Alice never joined
  hidden: "", // Alice is in it, hidden from the Workspace
  aliceBob: "", // Alice's DM with Bob
  bobCarol: "", // a DM Alice is not in
};
let artifactId: string;
let enabled = true;

const shares = new ArtifactShares(db, async () => enabled);
const ports = {
  db,
  idempotency: { execute: (_scope: unknown, persist: () => Promise<never>) => persist() },
  publisher: quietCentrifugo(),
};
const share = (userId: string, targets: string[]) =>
  shares.share({
    workspaceId,
    actor: { userId },
    artifactIds: [artifactId],
    targets,
    note: "Have a look",
    requestId: crypto.randomUUID(),
    send: ({ target, idempotencyKey, body }) =>
      postUserMessage(ports as never, {
        workspaceId,
        userId,
        conversationId: target,
        idempotencyKey,
        body,
      }),
  });
const linkMessages = () =>
  db.message.findMany({
    where: { workspaceId, body: { contains: `/artifacts/${artifactId}` } },
    select: { conversationId: true, body: true },
  });

beforeAll(async () => {
  for (const name of Object.keys(people) as (keyof typeof people)[]) {
    const user = await db.user.create({
      data: { username: `aws-${name}-${handle}`, displayName: name },
    });
    people[name] = user.id;
  }
  const workspace = await db.workspace.create({
    data: {
      slug: `aws-${handle}`,
      name: "Artifact web share",
      members: {
        create: [
          { userId: people.alice, role: "member" },
          { userId: people.bob, role: "member" },
          { userId: people.carol, role: "member" },
        ],
      },
    },
  });
  workspaceId = workspace.id;
  const channel = async (
    name: string,
    members: string[],
    extra: { visibility?: "public" | "private"; archivedAt?: Date; hiddenFromWorkspaceAt?: Date },
  ) => {
    const { id } = await db.conversation.create({
      data: { workspaceId, channelName: `${name}-${handle}`, visibility: "public", ...extra },
    });
    if (members.length)
      await db.conversationMember.createMany({
        data: members.map((userId) => ({ conversationId: id, workspaceId, userId })),
      });
    return id;
  };
  const direct = async (a: string, b: string) => {
    const { id } = await db.conversation.create({
      data: { workspaceId, directKey: peopleDirectKey(a, b) },
    });
    await db.conversationMember.createMany({
      data: [a, b].map((userId) => ({ conversationId: id, workspaceId, userId })),
    });
    return id;
  };
  rooms.closed = await channel("closed", [people.alice], { visibility: "private" });
  rooms.open = await channel("open", [people.alice, people.bob], {});
  rooms.archived = await channel("archived", [people.alice], { archivedAt: new Date() });
  rooms.unjoined = await channel("unjoined", [people.bob], {});
  rooms.hidden = await channel("hidden", [people.alice], { hiddenFromWorkspaceAt: new Date() });
  rooms.aliceBob = await direct(people.alice, people.bob);
  rooms.bobCarol = await direct(people.bob, people.carol);

  const artifacts = new Artifacts(db, store, { enabled: async () => true });
  const writer = await db.agent.create({
    data: {
      workspaceId,
      name: `aws-writer-${handle}`,
      displayName: "Writer",
      ownerId: people.alice,
      runtimeConfig: {},
    },
  });
  await db.conversationMember.create({
    data: { conversationId: rooms.closed, workspaceId, agentId: writer.id },
  });
  const made = await artifacts.create({
    workspaceId,
    home: { kind: "conversation", conversationId: rooms.closed },
    name: `plan-${handle}`,
    entryPath: "document.md",
    author: { agentId: writer.id },
  });
  artifactId = made.id;
});

afterAll(async () => {
  await db.workspace.deleteMany({ where: { id: workspaceId } });
  await db.user.deleteMany({ where: { id: { in: Object.values(people) } } });
  await db.$disconnect();
});

test("a reader shares into a channel and a DM they may post in: one message each, note above the link", async () => {
  const result = await share(people.alice, [rooms.open, rooms.aliceBob]);
  expect(result.outcome).toBe("success");
  const sent = await linkMessages();
  expect(sent.map((message) => message.conversationId).sort()).toEqual(
    [rooms.open, rooms.aliceBob].sort(),
  );
  for (const message of sent) expect(message.body.startsWith("Have a look\n\n")).toBe(true);
});

test("someone who cannot read the artifact sends nothing anywhere", async () => {
  const before = (await linkMessages()).length;
  // Bob is not in the private channel the artifact lives in; he may post in #open all the same.
  const refused = await share(people.bob, [rooms.open]).catch((error: unknown) => error);
  expect(isAppError(refused) && refused.code).toBe("NOT_FOUND");
  expect((await linkMessages()).length).toBe(before);
});

test("each destination the person may not post in fails with its reason; the rest go through", async () => {
  const result = await share(people.alice, [
    rooms.open,
    rooms.archived,
    rooms.unjoined,
    rooms.hidden,
    rooms.bobCarol,
  ]);
  expect(result.outcome).toBe("partial_failure");
  const reasons = Object.fromEntries(
    result.results.map((entry) => [
      entry.target,
      entry.status === "success" ? "sent" : entry.error.code,
    ]),
  );
  expect(reasons).toEqual({
    [rooms.open]: "sent",
    [rooms.archived]: "archived",
    [rooms.unjoined]: "no_access",
    [rooms.hidden]: "no_access",
    [rooms.bobCarol]: "no_access",
  });
  const posted = new Set((await linkMessages()).map((message) => message.conversationId));
  for (const room of [rooms.archived, rooms.unjoined, rooms.hidden, rooms.bobCarol])
    expect(posted.has(room)).toBe(false);
});

test("with documents off, nothing is shared", async () => {
  enabled = false;
  try {
    const before = (await linkMessages()).length;
    const refused = await share(people.alice, [rooms.open]).catch((error: unknown) => error);
    expect(isAppError(refused) && refused.errorId).toBe("artifacts-disabled");
    expect((await linkMessages()).length).toBe(before);
  } finally {
    enabled = true;
  }
});

test("the service refuses more targets than its cap", async () => {
  // Distinct ids: the service drops repeats before it counts.
  const distinct = Array.from({ length: 21 }, () => crypto.randomUUID());
  const refused = await share(people.alice, distinct).catch((error: unknown) => error);
  expect(isAppError(refused) && refused.code).toBe("INVALID_INPUT");
});

test("the web request names no actor and carries at most the picker's ten destinations", () => {
  const base = {
    artifactId: crypto.randomUUID(),
    destinations: [crypto.randomUUID()],
    requestId: crypto.randomUUID(),
  };
  expect(shareArtifactInputSchema.safeParse(base).success).toBe(true);
  expect(
    shareArtifactInputSchema.safeParse({ ...base, actor: { userId: crypto.randomUUID() } }).success,
  ).toBe(false);
  expect(
    shareArtifactInputSchema.safeParse({
      ...base,
      destinations: Array.from({ length: 11 }, () => crypto.randomUUID()),
    }).success,
  ).toBe(false);
  expect(shareArtifactInputSchema.safeParse({ ...base, note: "x".repeat(501) }).success).toBe(
    false,
  );
});

test("a retry under the same request id posts nothing twice", async () => {
  // As Redis does: a key that completed answers with the message it made, without persisting.
  const done = new Map<string, unknown>();
  const remembering = {
    db,
    idempotency: {
      execute: async (scope: { idempotencyKey: string }, persist: () => Promise<unknown>) => {
        if (done.has(scope.idempotencyKey)) return done.get(scope.idempotencyKey);
        const message = await persist();
        done.set(scope.idempotencyKey, message);
        return message;
      },
    },
    publisher: quietCentrifugo(),
  };
  const requestId = crypto.randomUUID();
  const once = () =>
    shares.share({
      workspaceId,
      actor: { userId: people.alice },
      artifactIds: [artifactId],
      targets: [rooms.aliceBob],
      note: "Retry me",
      requestId,
      send: ({ target, idempotencyKey, body }) =>
        postUserMessage(remembering as never, {
          workspaceId,
          userId: people.alice,
          conversationId: target,
          idempotencyKey,
          body,
        }),
    });
  const first = await once();
  const second = await once();
  expect(first.outcome).toBe("success");
  expect(second.outcome).toBe("success");
  const posted = await db.message.count({
    where: { conversationId: rooms.aliceBob, body: { startsWith: "Retry me" } },
  });
  expect(posted).toBe(1);
});
