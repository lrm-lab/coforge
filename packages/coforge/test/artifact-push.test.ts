import { expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ARTIFACT_UPLOAD_MAX_BYTES, type AgentArtifactRequest } from "@lrm/coforge-sdk/agent";
import { runArtifact } from "../src/artifact-commands";
import type { CliError } from "../src/cli-error";
import {
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
  useScratch,
  type Files,
} from "./artifact-directory-fixture";

useScratch();

/** `coforge artifact push`: the files that changed, or a new artifact from a directory. */

async function pulled(files: Files, name = "work") {
  const server = fakeServer(files);
  const dir = join(root, name);
  await run(server, ["pull", ID, "--dir", dir]);
  server.requests.length = 0;
  return { server, dir };
}

test("push sends only the files that differ, over the pulled version, and records the new state", async () => {
  const { server, dir } = await pulled({ "a.md": "a", "b.md": "b", "c/d.md": "d" });
  await writeFile(join(dir, "b.md"), "b2");
  await writeFile(join(dir, "new.md"), "new");
  await rm(join(dir, "c", "d.md"));
  const said = (await run(server, ["push", dir, "--note", "tweak", "--title", "T"])) as string;
  expect(server.requests).toHaveLength(2);
  const [first, second] = server.requests as Extract<AgentArtifactRequest, { operation: "push" }>[];
  expect(first).toMatchObject({
    operation: "push",
    artifact: ID,
    baseVersion: 1,
    note: "tweak",
    title: "T",
    files: [
      { path: "b.md", sha256: sha256("b2") },
      { path: "new.md", sha256: sha256("new") },
    ],
  });
  // A file missing locally is kept, not deleted.
  expect(first).not.toHaveProperty("delete");
  // The first answer was `missing`: the bytes went up, and the same request went again.
  expect(server.uploads.sort()).toEqual([sha256("b2"), sha256("new")].sort());
  expect(second).toEqual(first);
  expect(server.currentFiles()).toMatchObject({ "b.md": sha256("b2"), "c/d.md": sha256("d") });
  expect(said).toContain("Pushed version 2");
  const state = await stateOf(dir);
  expect(state.version).toBe(2);
  expect(state.files).toEqual({
    "a.md": sha256("a"),
    "b.md": sha256("b2"),
    "c/d.md": sha256("d"),
    "new.md": sha256("new"),
  });
  // Nothing differs now: nothing is sent.
  server.requests.length = 0;
  expect(await run(server, ["push", dir])).toContain("Nothing to push");
  expect(server.requests).toEqual([]);
});

test("push leaves out hidden files and the state file unless told, and the state file always", async () => {
  const { server, dir } = await pulled({ "a.md": "a" });
  await writeFile(join(dir, ".secret"), "s");
  await mkdir(join(dir, ".git"));
  await writeFile(join(dir, ".git", "config"), "g");
  await writeFile(join(dir, "visible.md"), "v");
  await run(server, ["push", dir]);
  expect(Object.keys(server.currentFiles()).sort()).toEqual(["a.md", "visible.md"]);
  await run(server, ["push", dir, "--include-hidden"]);
  expect(Object.keys(server.currentFiles()).sort()).toEqual([
    ".git/config",
    ".secret",
    "a.md",
    "visible.md",
  ]);
  expect(Object.keys(server.currentFiles())).not.toContain(STATE);
});

test("push --delete removes a file the directory no longer has, and says when it is still there", async () => {
  const { server, dir } = await pulled({ "a.md": "a", "b.md": "b" });
  const refused = await failure(run(server, ["push", dir, "--delete", "b.md"]));
  expect(refused.code).toBe("INVALID_ARG");
  expect(server.requests).toEqual([]);
  await rm(join(dir, "b.md"));
  await run(server, ["push", dir, "--delete", "b.md"]);
  expect(server.requests[0]).toMatchObject({ delete: ["b.md"] });
  expect(server.currentFiles()).toEqual({ "a.md": sha256("a") });
  expect((await stateOf(dir)).files).toEqual({ "a.md": sha256("a") });
  expect((await failure(run(server, ["push", dir, "--delete", "../x"]))).code).toBe("INVALID_ARG");
});

test("push refuses a symbolic link before sending anything", async () => {
  const { server, dir } = await pulled({ "a.md": "a" });
  await writeFile(join(root, "target.txt"), "t");
  await symlink(join(root, "target.txt"), join(dir, "link.txt"));
  const error = await failure(run(server, ["push", dir]));
  expect(error.code).toBe("INVALID_ARG");
  expect(error.message).toContain("link.txt");
  expect(server.requests).toEqual([]);
});

test("push refuses a file over the upload limit before sending anything", async () => {
  const { server, dir } = await pulled({ "a.md": "a" });
  await writeFile(join(dir, "big.bin"), new Uint8Array(ARTIFACT_UPLOAD_MAX_BYTES + 1));
  const error = await failure(run(server, ["push", dir]));
  expect(error.code).toBe("INVALID_ARG");
  expect(error.message).toContain("big.bin");
  expect(server.requests).toEqual([]);
});

test("push after a clash names the files and says to pull the newest version", async () => {
  const { server, dir } = await pulled({ "a.md": "a", "b.md": "b" });
  await writeFile(join(dir, "a.md"), "mine");
  server.clash = ["a.md", "css/site.css"];
  const error = await failure(run(server, ["push", dir]));
  expect(error.code).toBe("CONFLICT");
  expect(error.message).toContain("a.md");
  expect(error.message).toContain("css/site.css");
  expect(error.message).toContain("Settings that clashed: title");
  expect(error.suggestedNextAction).toContain(`coforge artifact pull ${ID}`);
  // The state still names the version the files started from.
  expect((await stateOf(dir)).version).toBe(1);
});

test("a push the server merged brings the files it merged into the directory", async () => {
  const { server, dir } = await pulled({ "a.md": "a", "b.md": "b" });
  server.others({ "b.md": "b by someone else" });
  await writeFile(join(dir, "a.md"), "a2");
  const transport = {
    ...server.transport,
    artifact: async (request: AgentArtifactRequest) => {
      const answer = (await server.transport.artifact(request)) as { status?: string };
      return answer.status === "created"
        ? { ...answer, number: server.current, merged: ["b.md"] }
        : answer;
    },
  };
  const said = (await runArtifact(invoke(["push", dir]), transport)) as string;
  expect(said).toContain("Merged");
  expect(await read("work", "b.md")).toEqual(Buffer.from("b by someone else"));
  expect((await stateOf(dir)).files["b.md"]).toBe(sha256("b by someone else"));
});

test("a merged push whose files differ only by case refuses before writing them", async () => {
  const { server, dir } = await pulled({ "a.md": "a" });
  server.others({ "README.md": "upper", "readme.md": "lower" });
  await writeFile(join(dir, "a.md"), "a2");
  const transport = {
    ...server.transport,
    artifact: async (request: AgentArtifactRequest) => {
      const answer = (await server.transport.artifact(request)) as { status?: string };
      return answer.status === "created"
        ? { ...answer, number: server.current, merged: ["README.md", "readme.md"] }
        : answer;
    },
  };
  const error = await runArtifact(invoke(["push", dir]), transport).catch(
    (caught: unknown) => caught as CliError,
  );
  expect((error as CliError).code).toBe("INVALID_ARG");
  expect(await read("work", "README.md").catch(() => null)).toBeNull();
});

test("push over a directory with no state creates an artifact from its files", async () => {
  const server = fakeServer();
  const dir = join(root, "site");
  await mkdir(dir);
  await writeFile(join(dir, "index.html"), "<h1>hi</h1>");
  await writeFile(join(dir, "app.js"), "1");
  const said = (await run(server, [
    "push",
    dir,
    "--target",
    "#launch",
    "--title",
    "Site",
    "--description",
    "A page",
  ])) as string;
  expect(server.requests[0]).toMatchObject({
    operation: "push",
    title: "Site",
    target: "#launch",
    description: "A page",
    entry: "index.html",
    files: [
      { path: "app.js", sha256: sha256("1") },
      { path: "index.html", sha256: sha256("<h1>hi</h1>") },
    ],
  });
  expect(server.requests[0]).not.toHaveProperty("artifact");
  expect(server.requests[0]).not.toHaveProperty("baseVersion");
  // missing, then the same request again with the same key
  expect(server.requests).toHaveLength(2);
  expect(server.requests[1]).toEqual(server.requests[0]!);
  expect(said).toContain(`id ${ID}`);
  expect((await stateOf(dir)).artifact).toBe(ID);
  // The directory is now this artifact's: another push goes over its version.
  await writeFile(join(dir, "app.js"), "2");
  server.requests.length = 0;
  await run(server, ["push", dir]);
  expect(server.requests[0]).toMatchObject({ operation: "push", artifact: ID, baseVersion: 1 });
});

test("creating from a directory needs a title and an entry it can name", async () => {
  const server = fakeServer();
  const dir = join(root, "docs");
  await mkdir(dir);
  await writeFile(join(dir, "one.md"), "1");
  await writeFile(join(dir, "two.md"), "2");
  expect((await failure(run(server, ["push", dir]))).message).toContain("--title");
  // Two Markdown files and no index.html: the entry has to be named.
  expect((await failure(run(server, ["push", dir, "--title", "Docs"]))).message).toContain(
    "--entry",
  );
  await run(server, ["push", dir, "--title", "Docs", "--entry", "two.md"]);
  expect(server.requests[0]).toMatchObject({ entry: "two.md" });
  // A web page needs no description: it is optional, as for any artifact.
  const page = join(root, "page");
  await mkdir(page);
  await writeFile(join(page, "index.html"), "<p>");
  await run(server, ["push", page, "--title", "P"]);
  expect(server.requests.at(-1)).not.toHaveProperty("description");
  // A directory that is already an artifact's cannot be sent as a new one.
  const { dir: owned } = await pulled({ "a.md": "a" }, "owned");
  expect((await failure(run(server, ["push", owned, "--target", "#x"]))).code).toBe("INVALID_ARG");
  // Nothing to send at all.
  const empty = join(root, "empty");
  await mkdir(empty);
  expect((await failure(run(server, ["push", empty, "--title", "E"]))).code).toBe("INVALID_ARG");
});

test("a push the server answers with nothing keeps the pulled version and says nothing was sent", async () => {
  const { server, dir } = await pulled({ "a.md": "a" });
  // Others moved the artifact on, and already hold this very change.
  server.others({ "a.md": "a2", "o.md": "o" });
  await writeFile(join(dir, "a.md"), "a2");
  const transport = {
    ...server.transport,
    artifact: async (request: AgentArtifactRequest) =>
      request.operation === "push" ? { status: "nothing" } : server.transport.artifact(request),
  };
  const before = await stateOf(dir);
  const said = (await runArtifact(invoke(["push", dir]), transport)) as string;
  expect(await stateOf(dir)).toEqual(before);
  expect(said).toContain("Nothing was sent");
  expect(said).toContain("version 1");
  expect(said).not.toContain("holds what the directory holds");
  expect(said).toContain(`coforge artifact pull ${ID}`);
});
