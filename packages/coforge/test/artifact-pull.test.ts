import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runArtifact } from "../src/artifact-commands";
import { inPool } from "../src/pool";
import {
  BINARY,
  ID,
  STATE,
  failure,
  fakeServer,
  invoke,
  read,
  root,
  run,
  sha256,
  stateOf,
  text,
  useScratch,
} from "./artifact-directory-fixture";

useScratch();

/** `coforge artifact pull|download`: a version's files into a directory, exactly. */

test("pull writes every file of the version, exactly, with a state file", async () => {
  const server = fakeServer({
    "plan.md": "# Plan\n",
    "img/logo.bin": BINARY,
    "测试/页面.html": "<p>",
  });
  const dir = join(root, "out");
  const said = (await run(server, ["pull", ID, "--dir", dir])) as string;
  expect(await read("out", "plan.md")).toEqual(Buffer.from("# Plan\n"));
  expect(new Uint8Array(await read("out", "img", "logo.bin"))).toEqual(BINARY);
  expect(await read("out", "测试", "页面.html")).toEqual(Buffer.from("<p>"));
  expect(await stateOf(dir)).toEqual({
    artifact: ID,
    version: 1,
    files: {
      "plan.md": sha256("# Plan\n"),
      "img/logo.bin": sha256(BINARY),
      "测试/页面.html": sha256("<p>"),
    },
  });
  expect(said).toContain("Pulled 3 files");
  expect(said).toContain("version 1");
  expect(said).toContain(`coforge artifact push ${dir}`);
});

test("pull --rev reads and downloads that version", async () => {
  const server = fakeServer({ "plan.md": "one" });
  server.others({ "plan.md": "two" });
  const dir = join(root, "old");
  await run(server, ["pull", ID, "--dir", dir, "--rev", "1"]);
  expect(await read("old", "plan.md")).toEqual(Buffer.from("one"));
  expect(server.requests[0]).toMatchObject({ operation: "read", version: 1 });
  expect(server.downloads).toEqual([{ path: "plan.md", version: 1 }]);
  expect((await stateOf(dir)).version).toBe(1);
});

test("pull defaults to a folder named after the title, or the id", async () => {
  const cwd = process.cwd();
  process.chdir(root);
  try {
    await run(fakeServer({ "a.md": "x" }, "Q4: plan/review?"), ["pull", ID]);
    expect(await readdir(root)).toEqual(["Q4- plan-review-"]);
    await run(fakeServer({ "a.md": "x" }, "..."), ["pull", ID]);
    expect((await readdir(root)).sort()).toEqual([ID, "Q4- plan-review-"]);
  } finally {
    process.chdir(cwd);
  }
});

test("pull refuses a non-empty directory that is not this artifact's pull, and refreshes one that is", async () => {
  const server = fakeServer({ "plan.md": "one", "old.md": "gone soon" });
  const stranger = join(root, "stranger");
  await mkdir(stranger);
  await writeFile(join(stranger, "mine.txt"), "mine");
  const refused = await failure(run(server, ["pull", ID, "--dir", stranger]));
  expect(refused.code).toBe("INVALID_ARG");
  expect(await readdir(stranger)).toEqual(["mine.txt"]);
  // An empty directory and a missing one are fine.
  const empty = join(root, "empty");
  await mkdir(empty);
  await run(server, ["pull", ID, "--dir", empty]);
  // Pulling again takes the newest version: changed files replaced, deleted ones removed.
  server.others({ "plan.md": "two" });
  const next = server.transport;
  await runArtifact(invoke(["pull", ID, "--dir", empty]), {
    ...next,
    artifact: async (request) => {
      const answer = (await next.artifact(request)) as { files: { path: string }[] };
      return { ...answer, files: answer.files.filter((file) => file.path !== "old.md") };
    },
  });
  expect(await read("empty", "plan.md")).toEqual(Buffer.from("two"));
  await expect(readFile(join(empty, "old.md"))).rejects.toThrow();
  expect((await stateOf(empty)).version).toBe(2);
  // Another artifact's pull is a stranger.
  await writeFile(join(empty, STATE), JSON.stringify({ artifact: "other", version: 1, files: {} }));
  expect((await failure(run(server, ["pull", ID, "--dir", empty]))).code).toBe("INVALID_ARG");
});

test("pull writes nothing outside its directory, whatever a path says", async () => {
  for (const bad of [
    "../escape.txt",
    "/abs.txt",
    "a/../../escape.txt",
    "a//b",
    "./x",
    STATE,
    "a\\b",
    "",
  ]) {
    const server = fakeServer({ [bad]: "x" });
    const dir = join(root, "jail");
    const error = await failure(run(server, ["pull", ID, "--dir", dir]));
    expect([bad, error.code]).toEqual([bad, "INVALID_ARG"]);
    expect(await readdir(root)).not.toContain("escape.txt");
    await rm(dir, { recursive: true, force: true });
  }
  // A symbolic link inside the directory that leaves it is not followed.
  const outside = join(root, "outside");
  await mkdir(outside);
  const dir = join(root, "linked");
  const server = fakeServer({ "plan.md": "x" });
  await run(server, ["pull", ID, "--dir", dir]);
  await symlink(outside, join(dir, "link"));
  const escaping = fakeServer({ "link/stolen.txt": "x", "plan.md": "x" });
  const error = await failure(run(escaping, ["pull", ID, "--dir", dir]));
  expect(error.code).toBe("INVALID_ARG");
  expect(await readdir(outside)).toEqual([]);
});

test("pull refuses bytes that do not match the version's listed hash", async () => {
  const server = fakeServer({ "plan.md": "one" });
  const error = await failure(
    runArtifact(invoke(["pull", ID, "--dir", join(root, "bad")]), {
      ...server.transport,
      artifactDownload: async () => text("tampered"),
    }),
  );
  expect(error.code).toBe("ARTIFACT_FILE_CORRUPT");
});

test("download saves one file's exact bytes", async () => {
  const server = fakeServer({ "img/logo.bin": BINARY });
  server.others({ "img/logo.bin": "later" });
  const out = join(root, "logo.bin");
  const said = (await run(server, [
    "download",
    ID,
    "img/logo.bin",
    "--output",
    out,
    "--rev",
    "1",
  ])) as string;
  expect(new Uint8Array(await readFile(out))).toEqual(BINARY);
  expect(server.downloads).toEqual([{ path: "img/logo.bin", version: 1 }]);
  expect(said).toContain(out);
  const error = await failure(run(server, ["download", ID, "missing.txt", "--output", out]));
  expect(error.code).toBe("NOT_FOUND");
  expect((await failure(run(server, ["download", ID, "../x", "--output", out]))).code).toBe(
    "INVALID_ARG",
  );
});

test("pull of files sharing a new subdirectory makes it once, whatever the order", async () => {
  const server = fakeServer({
    "css/a.css": "a",
    "css/b.css": "b",
    "css/c.css": "c",
    "css/d.css": "d",
    "deep/x/y/1.txt": "1",
    "deep/x/y/2.txt": "2",
  });
  const dir = join(root, "site");
  await run(server, ["pull", ID, "--dir", dir]);
  expect((await readdir(join(dir, "css"))).sort()).toEqual(["a.css", "b.css", "c.css", "d.css"]);
  expect((await readdir(join(dir, "deep", "x", "y"))).sort()).toEqual(["1.txt", "2.txt"]);
  expect((await stateOf(dir)).version).toBe(1);
});

test("a pool starts no new work once one worker has failed", async () => {
  const started: number[] = [];
  const failed = inPool([1, 2, 3, 4, 5, 6, 7, 8], 2, async (item) => {
    started.push(item);
    if (item === 1) throw new Error("boom");
    await Promise.resolve();
  });
  await expect(failed).rejects.toThrow("boom");
  expect(started).toEqual([1, 2]);
});

test("a pull that stopped midway still removes the files the next version dropped", async () => {
  const server = fakeServer({ "a.md": "a1", "b.md": "b1" });
  const dir = join(root, "again");
  await run(server, ["pull", ID, "--dir", dir]);
  server.others({ "a.md": "a2" });
  // Version 2 no longer lists b.md.
  const next = server.transport;
  const without = {
    ...next,
    artifact: async (request: Parameters<typeof next.artifact>[0]) => {
      const answer = (await next.artifact(request)) as { files: { path: string }[] };
      return { ...answer, files: answer.files.filter((file) => file.path !== "b.md") };
    },
  };
  const broken = await failure(
    runArtifact(invoke(["pull", ID, "--dir", dir]), {
      ...without,
      artifactDownload: async () => {
        throw new Error("connection lost");
      },
    }),
  );
  expect(broken.message).toContain("connection lost");
  expect((await stateOf(dir)).version).toBe(0);
  await runArtifact(invoke(["pull", ID, "--dir", dir]), without);
  await expect(readFile(join(dir, "b.md"))).rejects.toThrow();
  expect(await read("again", "a.md")).toEqual(Buffer.from("a2"));
  expect(await stateOf(dir)).toEqual({ artifact: ID, version: 2, files: { "a.md": sha256("a2") } });
});

test("pull refuses paths that differ only by case before writing anything", async () => {
  const server = fakeServer({ "README.md": "upper", "docs/readme.md": "x", "readme.md": "lower" });
  const dir = join(root, "cased");
  const error = await failure(run(server, ["pull", ID, "--dir", dir]));
  expect(error.code).toBe("INVALID_ARG");
  expect(error.message).toContain("README.md");
  expect(error.message).toContain("readme.md");
  expect(await readdir(root)).not.toContain("cased");
  expect(server.downloads).toEqual([]);
});

test("download refuses to write through a symbolic link", async () => {
  const server = fakeServer({ "plan.md": "new" });
  const victim = join(root, "victim.txt");
  await writeFile(victim, "keep");
  const link = join(root, "out.md");
  await symlink(victim, link);
  const error = await failure(run(server, ["download", ID, "plan.md", "--output", link]));
  expect(error.code).toBe("INVALID_ARG");
  expect(await readFile(victim, "utf8")).toBe("keep");
  const folder = join(root, "folder");
  await mkdir(folder);
  expect((await failure(run(server, ["download", ID, "plan.md", "--output", folder]))).code).toBe(
    "INVALID_ARG",
  );
});
