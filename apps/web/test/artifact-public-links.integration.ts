import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { ArtifactPublicLinks } from "#src/server/artifacts/artifact-public-links.server";
import { rememberArtifactSandboxConfig } from "#src/server/artifacts/artifact-sandbox-config.server";

/**
 * Reading an artifact's public link (task #646): whoever reads the artifact sees whether it can
 * have one and the one it has; anyone else gets what a missing artifact gets.
 */
const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const handle = crypto.randomUUID().slice(0, 8);
const ORIGIN = "http://127.0.0.1:5199";

let switchedOn = true;
const links = new ArtifactPublicLinks(db, async () => switchedOn);
let workspaceId: string;
let owner: string;
let reader: string;
let bystander: string;
let channelId: string;

const artifact = (kind: string) =>
  db.artifact.create({
    data: {
      workspaceId,
      homeKey: `conversation:${channelId}`,
      name: `${kind}-${crypto.randomUUID()}`,
      kind,
      entryPath: "index",
      authorUserId: owner,
    },
  });
const refusal = (run: Promise<unknown>) =>
  run.then(
    () => null,
    (error: { code: string }) => error.code,
  );

beforeAll(async () => {
  const person = async (name: string) =>
    (await db.user.create({ data: { username: `apl-${name}-${handle}`, displayName: name } })).id;
  owner = await person("owner");
  reader = await person("reader");
  bystander = await person("bystander");
  const workspace = await db.workspace.create({
    data: {
      slug: `apl-${handle}`,
      name: "Public links",
      members: {
        create: [
          { userId: owner, role: "owner" },
          { userId: reader, role: "member" },
          { userId: bystander, role: "member" },
        ],
      },
    },
  });
  workspaceId = workspace.id;
  const channel = await db.conversation.create({
    data: {
      workspaceId,
      channelName: `apl-${handle}`,
      visibility: "private",
      members: { create: [{ userId: owner }, { userId: reader }] },
    },
  });
  channelId = channel.id;
  rememberArtifactSandboxConfig({ origin: ORIGIN });
});

afterAll(async () => {
  rememberArtifactSandboxConfig(null);
  await db.workspace.delete({ where: { id: workspaceId } });
  await db.user.deleteMany({ where: { id: { in: [owner, reader, bystander] } } });
  await db.$disconnect();
});

test("one who can read it sees the link, on and after it is off", async () => {
  const { id: artifactId } = await artifact("markdown");
  const read = () => links.read({ workspaceId, artifactId, userId: reader });
  expect(await read()).toEqual({ available: true, url: null });
  const set = await links.set({ workspaceId, artifactId, userId: owner, enabled: true });
  expect(set.enabled).toBe(true);
  expect(await read()).toEqual({ available: true, url: set.enabled ? set.url : null });
  await links.set({ workspaceId, artifactId, userId: owner, enabled: false });
  expect(await read()).toEqual({ available: true, url: null });
});

test("one who cannot read it gets what a missing artifact gets", async () => {
  const { id: artifactId } = await artifact("html");
  await links.set({ workspaceId, artifactId, userId: owner, enabled: true });
  const denied = await refusal(links.read({ workspaceId, artifactId, userId: bystander }));
  const missing = await refusal(
    links.read({ workspaceId, artifactId: crypto.randomUUID(), userId: reader }),
  );
  expect(denied).toBe("NOT_FOUND");
  expect(denied).toBe(missing);
});

test("a kind with no public link is not available", async () => {
  const { id: artifactId } = await artifact("pdf");
  expect(await links.read({ workspaceId, artifactId, userId: owner })).toEqual({
    available: false,
    url: null,
  });
});

test("no link can be made while the sandbox origin is unset", async () => {
  const { id: artifactId } = await artifact("markdown");
  rememberArtifactSandboxConfig(null);
  try {
    expect(await links.read({ workspaceId, artifactId, userId: owner })).toEqual({
      available: false,
      url: null,
    });
  } finally {
    rememberArtifactSandboxConfig({ origin: ORIGIN });
  }
});

test("nothing is read while the Workspace has artifacts off", async () => {
  const { id: artifactId } = await artifact("markdown");
  switchedOn = false;
  try {
    expect(await refusal(links.read({ workspaceId, artifactId, userId: owner }))).toBe(
      "ACCESS_DENIED",
    );
  } finally {
    switchedOn = true;
  }
});
