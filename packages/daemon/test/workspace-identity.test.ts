import { afterAll, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canDropPrivileges,
  isUsableIdentity,
  resolveSpawnIdentity,
  resolveWorkspaceIdentity,
  WORKSPACE_IDENTITY_FILE,
  workspaceDirectory,
} from "#src/supervisor/workspace-identity";

const stateRoot = join(realpathSync(tmpdir()), `coforge-workspace-identity-${crypto.randomUUID()}`);

afterAll(async () => {
  await rm(stateRoot, { recursive: true, force: true });
});

async function writeProfile(contents: unknown): Promise<void> {
  await mkdir(stateRoot, { recursive: true });
  await writeFile(join(stateRoot, WORKSPACE_IDENTITY_FILE), `${JSON.stringify(contents)}\n`);
}

test("an identity below the agent range is rejected so a profile cannot name root", () => {
  expect(isUsableIdentity({ uid: 0, gid: 0 })).toBe(false);
  expect(isUsableIdentity({ uid: 1234, gid: 1234 })).toBe(false);
  expect(isUsableIdentity({ uid: 20_101, gid: 20_101 })).toBe(true);
});

test("a malformed identity is rejected instead of half-applied", () => {
  expect(isUsableIdentity(undefined)).toBe(false);
  expect(isUsableIdentity("20101")).toBe(false);
  expect(isUsableIdentity({ uid: 20_101 })).toBe(false);
  expect(isUsableIdentity({ uid: 20_101.5, gid: 20_101 })).toBe(false);
});

test("the profile resolves the identity of the asked workspace only", async () => {
  await writeProfile({
    "workspace-a": { uid: 20_101, gid: 20_101 },
    "workspace-b": { uid: 20_102, gid: 20_102 },
  });
  expect(await resolveWorkspaceIdentity(stateRoot, "workspace-b")).toEqual({
    uid: 20_102,
    gid: 20_102,
  });
  expect(await resolveWorkspaceIdentity(stateRoot, "workspace-missing")).toBeUndefined();
});

test("a missing or broken profile falls back to the launcher identity", async () => {
  expect(await resolveWorkspaceIdentity(join(stateRoot, "absent"), "workspace-a")).toBeUndefined();
  await writeFile(join(stateRoot, WORKSPACE_IDENTITY_FILE), "{not json");
  expect(await resolveWorkspaceIdentity(stateRoot, "workspace-a")).toBeUndefined();
  await writeProfile({ "workspace-a": { uid: 0, gid: 0 } });
  expect(await resolveWorkspaceIdentity(stateRoot, "workspace-a")).toBeUndefined();
});

test("each workspace directory is derived from the volume root", () => {
  expect(workspaceDirectory("/srv/coforge", "workspace-a")).toBe("/srv/coforge/ws/workspace-a");
});

test("privileges are only dropped by a root launcher", () => {
  expect(canDropPrivileges(() => 0)).toBe(true);
  expect(canDropPrivileges(() => 1000)).toBe(false);
  expect(canDropPrivileges(() => undefined)).toBe(false);
});

test("the identity is used only when the workspace directory belongs to it", async () => {
  await writeProfile({ "workspace-a": { uid: 20_101, gid: 20_101 } });
  const base = {
    stateRoot,
    workspaceId: "workspace-a",
    volumeRoot: "/srv/coforge",
    getuid: () => 0,
  };
  expect(await resolveSpawnIdentity({ ...base, statOwner: async () => 20_101 })).toEqual({
    identity: { uid: 20_101, gid: 20_101 },
    directory: "/srv/coforge/ws/workspace-a",
  });
  expect(await resolveSpawnIdentity({ ...base, statOwner: async () => 0 })).toBeUndefined();
  expect(await resolveSpawnIdentity({ ...base, statOwner: async () => undefined })).toBeUndefined();
  expect(
    await resolveSpawnIdentity({ ...base, getuid: () => 1000, statOwner: async () => 20_101 }),
  ).toBeUndefined();
  expect(
    await resolveSpawnIdentity({ ...base, volumeRoot: undefined, statOwner: async () => 20_101 }),
  ).toBeUndefined();
});
