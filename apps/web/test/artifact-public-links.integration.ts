import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { ArtifactPublicLinks } from "#src/server/artifacts/artifact-public-links.server";
import {
  linkPageLookup,
  publicPageLookup,
} from "#src/server/artifacts/artifact-public-page.server";
import { rememberArtifactSandboxConfig } from "#src/server/artifacts/artifact-sandbox-config.server";
import { conversationRealtimeChannel } from "#src/features/conversations/conversation-realtime";

const connectionString = Bun.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const handle = crypto.randomUUID().slice(0, 8);
const ORIGIN = "http://127.0.0.1:5199";

const links = new ArtifactPublicLinks(db);
let workspaceId: string;
let owner: string;
let reader: string;
let bystander: string;
let outsider: string;
let channelId: string;

const artifact = (extension: string) =>
  db.artifact.create({
    data: {
      workspaceId,
      homeKey: `conversation:${channelId}`,
      name: `${extension}-${crypto.randomUUID()}`,
      entryPath: `index.${extension}`,
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
  outsider = await person("outsider");
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
  await db.user.deleteMany({ where: { id: { in: [owner, reader, bystander, outsider] } } });
  await db.$disconnect();
});

test("one who can read it sees the link, on and after it is off", async () => {
  const { id: artifactId } = await artifact("md");
  const read = () => links.read({ workspaceId, artifactId, userId: reader });
  expect(await read()).toEqual({ available: true, url: null });
  const set = await links.set({ workspaceId, artifactId, userId: owner, enabled: true });
  expect(set.enabled).toBe(true);
  expect(await read()).toEqual({ available: true, url: set.enabled ? set.url : null });
  await links.set({ workspaceId, artifactId, userId: owner, enabled: false });
  expect(await read()).toEqual({ available: true, url: null });
});

test("turning the link on or off tells the pages that show the artifact, and a no-op tells none", async () => {
  const published: string[] = [];
  const signalled = new ArtifactPublicLinks(db, {
    publish: async (channel) => void published.push(channel),
  });
  const { id: artifactId } = await artifact("md");
  const home = conversationRealtimeChannel(channelId);
  await signalled.set({ workspaceId, artifactId, userId: owner, enabled: true });
  expect(published).toEqual([home]);
  published.length = 0;
  await signalled.set({ workspaceId, artifactId, userId: owner, enabled: true });
  expect(published).toEqual([]);
  await signalled.set({ workspaceId, artifactId, userId: owner, enabled: false });
  expect(published).toEqual([home]);
  published.length = 0;
  await signalled.set({ workspaceId, artifactId, userId: owner, enabled: false });
  expect(published).toEqual([]);
});

test("one outside the Workspace gets what a missing artifact gets", async () => {
  const { id: artifactId } = await artifact("html");
  await links.set({ workspaceId, artifactId, userId: owner, enabled: true });
  const denied = await refusal(links.read({ workspaceId, artifactId, userId: outsider }));
  const missing = await refusal(
    links.read({ workspaceId, artifactId: crypto.randomUUID(), userId: reader }),
  );
  expect(denied).toBe("NOT_FOUND");
  expect(denied).toBe(missing);
});

test("a member outside the home sees the link state only once the artifact is widened", async () => {
  const { id: artifactId } = await artifact("html");
  await links.set({ workspaceId, artifactId, userId: owner, enabled: true });
  expect(await refusal(links.read({ workspaceId, artifactId, userId: bystander }))).toBe(
    "NOT_FOUND",
  );
  await db.artifact.update({ where: { id: artifactId }, data: { access: "workspace" } });
  expect(await links.read({ workspaceId, artifactId, userId: bystander })).toEqual(
    await links.read({ workspaceId, artifactId, userId: reader }),
  );
});

test("an artifact of any entry file can have a public link", async () => {
  for (const extension of ["pdf", "csv", "png", "txt", "mp4"]) {
    const { id: artifactId } = await artifact(extension);
    const set = await links.set({ workspaceId, artifactId, userId: owner, enabled: true });
    expect(set.enabled, extension).toBe(true);
    expect(await links.read({ workspaceId, artifactId, userId: owner })).toEqual({
      available: true,
      url: set.enabled ? set.url : null,
    });
  }
});

test("no link can be made while the sandbox origin is unset", async () => {
  const { id: artifactId } = await artifact("md");
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

test("a home the Workspace hides takes its link state and link from all but the admins", async () => {
  const { id: artifactId } = await artifact("html");
  await links.set({ workspaceId, artifactId, userId: owner, enabled: true });
  await db.conversation.update({
    where: { id: channelId },
    data: { hiddenFromWorkspaceAt: new Date() },
  });
  try {
    for (const userId of [reader, bystander]) {
      expect(await refusal(links.read({ workspaceId, artifactId, userId }))).toBe("NOT_FOUND");
      expect(await refusal(links.set({ workspaceId, artifactId, userId, enabled: false }))).toBe(
        "NOT_FOUND",
      );
    }
    expect(await links.read({ workspaceId, artifactId, userId: owner })).toMatchObject({
      available: true,
    });
  } finally {
    await db.conversation.update({
      where: { id: channelId },
      data: { hiddenFromWorkspaceAt: null },
    });
  }
});

test("a public link shows the current version's entry and any one file of it", async () => {
  const made = await db.artifact.create({
    data: {
      workspaceId,
      homeKey: `conversation:${channelId}`,
      name: `files-${crypto.randomUUID()}`,
      title: "Site",
      entryPath: "home.html",
      currentVersion: 2,
    },
  });
  const version = (number: number, files: Record<string, string>) =>
    db.artifactVersion.create({
      data: {
        artifactId: made.id,
        number,
        createdAt: new Date(Date.UTC(2026, 0, number)),
        entryPath: "home.html",
        changedPaths: [],
        idempotencyKey: `k${number}`,
        files: {
          create: Object.entries(files).map(([path, sha256]) => ({
            artifactId: made.id,
            path,
            sha256,
            sizeBytes: 1,
            kind: "text",
          })),
        },
      },
    });
  await version(1, { "home.html": "old-home", "old.css": "old-css" });
  const current = await version(2, {
    "home.html": "home",
    "site.css": "css",
    "img/a.png": "png",
  });
  const set = await links.set({ workspaceId, artifactId: made.id, userId: owner, enabled: true });
  const token = set.enabled ? set.url.slice(set.url.lastIndexOf("/") + 1) : "";
  const lookup = publicPageLookup(db);
  const lookupById = linkPageLookup(db);

  expect(await lookup(token)).toEqual({
    workspaceId,
    artifactId: made.id,
    title: "Site",
    kind: "html",
    entryPath: "home.html",
    sha256: "home",
    sizeBytes: 1,
    access: "conversation",
    version: 2,
    updatedAt: current.createdAt.toISOString(),
  });
  expect(await lookup(token, "site.css")).toMatchObject({ sha256: "css", entryPath: "home.html" });
  expect(await lookup(token, "img/a.png")).toMatchObject({ sha256: "png" });
  expect(await lookup(token, "old.css")).toBeNull();
  expect(await lookup(token, "nope.css")).toBeNull();
  expect(await lookup("x".repeat(43))).toBeNull();
  expect(await lookupById(made.id)).toMatchObject({
    shared: true,
    page: { artifactId: made.id, access: "conversation", sha256: "home" },
  });
  expect(await lookupById(made.id, "site.css")).toMatchObject({
    shared: true,
    page: { sha256: "css" },
  });
  await links.set({ workspaceId, artifactId: made.id, userId: owner, enabled: false });
  expect(await lookup(token, "site.css")).toBeNull();
  expect(await lookupById(made.id)).toEqual({ shared: false, page: null });
  expect(await lookupById(made.id, "site.css")).toEqual({ shared: false, page: null });
  expect(
    await db.artifact.findUniqueOrThrow({ where: { id: made.id }, select: { access: true } }),
  ).toEqual({ access: "conversation" });
  expect(await db.artifactAccessEvent.count({ where: { artifactId: made.id } })).toBe(0);
});

test("a public link to a file entry is looked up with its kind and size", async () => {
  const made = await db.artifact.create({
    data: {
      workspaceId,
      homeKey: `conversation:${channelId}`,
      name: `paper-${crypto.randomUUID()}`,
      title: "Paper",
      entryPath: "paper.pdf",
      currentVersion: 1,
    },
  });
  await db.artifactVersion.create({
    data: {
      artifactId: made.id,
      number: 1,
      entryPath: "paper.pdf",
      changedPaths: [],
      idempotencyKey: "paper",
      files: {
        create: {
          artifactId: made.id,
          path: "paper.pdf",
          sha256: "pdf",
          sizeBytes: 4096,
          kind: "binary",
        },
      },
    },
  });
  const set = await links.set({ workspaceId, artifactId: made.id, userId: owner, enabled: true });
  const token = set.enabled ? set.url.slice(set.url.lastIndexOf("/") + 1) : "";
  expect(await publicPageLookup(db)(token, "paper.pdf")).toMatchObject({
    kind: "pdf",
    entryPath: "paper.pdf",
    sha256: "pdf",
    sizeBytes: 4096,
  });
});
