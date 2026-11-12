import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "#src/generated/prisma/client";
import { ArtifactPublicLinks } from "#src/server/artifacts/artifact-public-links.server";
import { publicPageLookup } from "#src/server/artifacts/artifact-public-page.server";
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

/** An artifact whose entry file is `index.<extension>`: its type is that file's. */
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
  const { id: artifactId } = await artifact("md");
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

test("an artifact whose entry file is neither a web page nor Markdown has no public link", async () => {
  const { id: artifactId } = await artifact("pdf");
  expect(await links.read({ workspaceId, artifactId, userId: owner })).toEqual({
    available: false,
    url: null,
  });
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

test("nothing is read while the Workspace has artifacts off", async () => {
  const { id: artifactId } = await artifact("md");
  switchedOn = false;
  try {
    expect(await refusal(links.read({ workspaceId, artifactId, userId: owner }))).toBe(
      "ACCESS_DENIED",
    );
  } finally {
    switchedOn = true;
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
  await version(2, { "home.html": "home", "site.css": "css", "img/a.png": "png" });
  const set = await links.set({ workspaceId, artifactId: made.id, userId: owner, enabled: true });
  const token = set.enabled ? set.url.slice(set.url.lastIndexOf("/") + 1) : "";
  let enabled = true;
  const lookup = publicPageLookup(db, async () => enabled);

  expect(await lookup(token)).toEqual({
    workspaceId,
    artifactId: made.id,
    title: "Site",
    kind: "html",
    entryPath: "home.html",
    sha256: "home",
  });
  expect(await lookup(token, "site.css")).toMatchObject({ sha256: "css", entryPath: "home.html" });
  expect(await lookup(token, "img/a.png")).toMatchObject({ sha256: "png" });
  // The current version only; and no file means no answer.
  expect(await lookup(token, "old.css")).toBeNull();
  expect(await lookup(token, "nope.css")).toBeNull();
  expect(await lookup("x".repeat(43))).toBeNull();
  // Off while the experiment is off, and once the link is revoked.
  enabled = false;
  expect(await lookup(token, "site.css")).toBeNull();
  enabled = true;
  await links.set({ workspaceId, artifactId: made.id, userId: owner, enabled: false });
  expect(await lookup(token, "site.css")).toBeNull();
});
