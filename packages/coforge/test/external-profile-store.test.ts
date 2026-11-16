import { expect, test } from "bun:test";
import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultProfileSlug } from "../src/external/profile-store";
import { selectProfile } from "../src/external/profile-select";
import { profile, useAgentHome } from "./external-fixture";

const home = useAgentHome();

const mode = async (path: string) => (await stat(path)).mode & 0o777;

test("a profile is written to a 0700 directory as a 0600 file under COFORGE_AGENT_HOME", async () => {
  await home.store.writeProfile("acme-builder", profile());
  const directory = join(home.home, "profiles", "acme-builder");
  expect(await mode(directory)).toBe(0o700);
  expect(await mode(join(directory, "credential.json"))).toBe(0o600);
  expect(await home.store.readProfile("acme-builder")).toEqual(profile());
});

test("pending login and inbox cursor files are private too", async () => {
  await home.store.writePending("p", {
    serverUrl: "https://forge.example",
    deviceCode: "d",
    userCode: "U",
    verificationUri: "https://forge.example/device",
    expiresAt: "2026-11-16T01:00:00.000Z",
    interval: 5,
    workspace: "acme",
    agent: "builder",
  });
  await home.store.writeCursor("p", "cursor-1");
  const directory = join(home.home, "profiles", "p");
  expect(await mode(join(directory, "pending.json"))).toBe(0o600);
  expect(await mode(join(directory, "inbox-cursor"))).toBe(0o600);
  expect(await home.store.readCursor("p")).toBe("cursor-1");
});

test("a rewrite replaces the file whole and leaves no temporary file behind", async () => {
  await home.store.writeProfile("p", profile());
  await home.store.writeProfile("p", profile({ apiKey: "sk_ext_replaced", credentialId: "c2" }));
  expect((await home.store.readProfile("p"))?.credentialId).toBe("c2");
  expect(await readdir(join(home.home, "profiles", "p"))).toEqual(["credential.json"]);
});

test("a corrupt credential file is reported, a missing one is undefined", async () => {
  expect(await home.store.readProfile("none")).toBeUndefined();
  await home.store.writeProfile("bad", profile());
  await writeFile(join(home.home, "profiles", "bad", "credential.json"), "{not json");
  await expect(home.store.readProfile("bad")).rejects.toMatchObject({ code: "PROFILE_CORRUPT" });
});

test("profile names cannot leave the profiles directory", async () => {
  for (const slug of ["..", "a/b", ".hidden", ""])
    await expect(home.store.readProfile(slug)).rejects.toMatchObject({ code: "PROFILE_INVALID" });
});

test("profiles are listed by the files they hold", async () => {
  await home.store.writeProfile("b", profile());
  await home.store.writeProfile("a", profile());
  expect(await home.store.listProfiles()).toEqual(["a", "b"]);
  expect(await home.store.listPendingLogins()).toEqual([]);
});

test("the default profile name joins workspace and agent", () => {
  expect(defaultProfileSlug("Acme", "Builder")).toBe("acme-builder");
});

test("--profile and COFORGE_PROFILE select a profile and leave the other arguments", () => {
  expect(selectProfile(["whoami"], {})).toEqual({ args: ["whoami"] });
  expect(selectProfile(["--profile", "p", "whoami"], {})).toEqual({ slug: "p", args: ["whoami"] });
  expect(selectProfile(["whoami", "--profile=p"], {})).toEqual({ slug: "p", args: ["whoami"] });
  expect(selectProfile(["whoami"], { COFORGE_PROFILE: "e" })).toEqual({
    slug: "e",
    args: ["whoami"],
  });
  expect(selectProfile(["--profile", "p", "x"], { COFORGE_PROFILE: "p" }).slug).toBe("p");
});

test("a flag and an environment variable that disagree are a conflict", () => {
  expect(() => selectProfile(["--profile", "a"], { COFORGE_PROFILE: "b" })).toThrow(
    expect.objectContaining({ code: "PROFILE_CONFLICT" }),
  );
});

test("--profile after -- belongs to the program that follows", () => {
  expect(selectProfile(["app", "token", "--", "tool", "--profile", "x"], {})).toEqual({
    args: ["app", "token", "--", "tool", "--profile", "x"],
  });
});

test("a profile flag needs a valid name", () => {
  expect(() => selectProfile(["--profile"], {})).toThrow(
    expect.objectContaining({ code: "INVALID_ARG" }),
  );
  expect(() => selectProfile(["--profile", "../x"], {})).toThrow(
    expect.objectContaining({ code: "PROFILE_INVALID" }),
  );
});
