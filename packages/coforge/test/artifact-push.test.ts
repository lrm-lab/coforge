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

test("push leaves out hidden files unless told, always skips tool entries, and keeps tracking hidden files in state", async () => {
  const { server, dir } = await pulled({
    "a.md": "a",
    ".env.example": "KEY=1",
    ".well-known/info.txt": "v1",
  });
  await writeFile(join(dir, ".secret"), "s");
  await writeFile(join(dir, ".DS_Store"), "finder");
  await mkdir(join(dir, ".git"));
  await writeFile(join(dir, ".git", "config"), "g");
  await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(dir, "node_modules", "pkg", "index.js"), "module.exports = 1;");
  await symlink(join(dir, "a.md"), join(dir, "node_modules", "link"));
  await writeFile(join(dir, ".env.example"), "KEY=2");
  await writeFile(join(dir, ".well-known", "info.txt"), "v2");
  await writeFile(join(dir, ".well-known", "untracked.txt"), "u");
  await writeFile(join(dir, "visible.md"), "v");

  await run(server, ["push", dir]);
  expect(Object.keys(server.currentFiles()).sort()).toEqual([
    ".env.example",
    ".well-known/info.txt",
    "a.md",
    "visible.md",
  ]);
  expect(server.currentFiles()[".env.example"]).toBe(sha256("KEY=2"));
  expect(server.currentFiles()[".well-known/info.txt"]).toBe(sha256("v2"));

  await run(server, ["push", dir, "--include-hidden"]);
  expect(Object.keys(server.currentFiles()).sort()).toEqual([
    ".env.example",
    ".secret",
    ".well-known/info.txt",
    ".well-known/untracked.txt",
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
  const to = ["--target", "#launch"];
  const refused = await failure(run(server, ["push", dir, "--title", "Docs"]));
  expect(refused.code).toBe("TARGET_REQUIRED");
  expect(refused.message).toContain("--target");
  expect(server.requests).toHaveLength(0);
  expect((await failure(run(server, ["push", dir, ...to]))).message).toContain("--title");
  expect((await failure(run(server, ["push", dir, "--title", "Docs", ...to]))).message).toContain(
    "--entry",
  );
  await run(server, ["push", dir, "--title", "Docs", "--entry", "two.md", ...to]);
  expect(server.requests[0]).toMatchObject({ entry: "two.md" });
  // A web page needs no description: it is optional, as for any artifact.
  const page = join(root, "page");
  await mkdir(page);
  await writeFile(join(page, "index.html"), "<p>");
  await run(server, ["push", page, "--title", "P", ...to]);
  expect(server.requests.at(-1)).not.toHaveProperty("description");
  // A directory that is already an artifact's cannot be sent as a new one.
  const { dir: owned } = await pulled({ "a.md": "a" }, "owned");
  expect((await failure(run(server, ["push", owned, "--target", "#x"]))).code).toBe("INVALID_ARG");
  // Nothing to send at all.
  const empty = join(root, "empty");
  await mkdir(empty);
  expect((await failure(run(server, ["push", empty, "--title", "E", ...to]))).code).toBe(
    "INVALID_ARG",
  );
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

test("push prints Open URL when the server returns url on create and update", async () => {
  const url = `https://app.example/w/acme/artifacts/${ID}`;
  const server = fakeServer({ "a.md": "a" });
  const dir = join(root, "with-url");
  await mkdir(dir);
  await writeFile(join(dir, "a.md"), "hello");
  const transport = {
    ...server.transport,
    artifact: async (request: AgentArtifactRequest) => {
      const answer = (await server.transport.artifact(request)) as Record<string, unknown>;
      return request.operation === "push" && answer.status !== "missing"
        ? { ...answer, url }
        : answer;
    },
  };
  const createdSaid = (await runArtifact(
    invoke(["push", dir, "--target", "#launch", "--title", "Plan"]),
    transport,
  )) as string;
  expect(createdSaid).toContain(`Open: ${url}`);

  await writeFile(join(dir, "a.md"), "hello v2");
  const updatedSaid = (await runArtifact(invoke(["push", dir]), transport)) as string;
  expect(updatedSaid).toContain(`Open: ${url}`);
});

test("push --announcement preflights channel admin authority before pushing and pins after create", async () => {
  const forbiddenServer = fakeServer({ "a.md": "a" });
  const forbiddenDir = join(root, "ann-forbidden");
  await mkdir(forbiddenDir);
  await writeFile(join(forbiddenDir, "a.md"), "hello");
  const channelCalls: unknown[] = [];
  const forbiddenErr = await failure(
    runArtifact(
      invoke(["push", forbiddenDir, "--target", "#eng", "--title", "Plan", "--announcement"]),
      {
        ...forbiddenServer.transport,
        channel: async (command) => {
          channelCalls.push(command);
          return { channel: { archived: false, channelCapabilities: { update: false } } };
        },
      },
    ),
  );
  expect(forbiddenErr.code).toBe("CHANNEL_ANNOUNCEMENT_FORBIDDEN");
  expect(forbiddenServer.requests).toHaveLength(0);
  expect(channelCalls).toEqual([{ operation: "info", target: "#eng" }]);

  const threadErr = await failure(
    runArtifact(
      invoke([
        "push",
        forbiddenDir,
        "--target",
        "#eng:12345678",
        "--title",
        "Plan",
        "--announcement",
      ]),
      { ...forbiddenServer.transport, channel: async () => ({}) },
    ),
  );
  expect(threadErr.code).toBe("INVALID_TARGET");
  expect(forbiddenServer.requests).toHaveLength(0);

  const okServer = fakeServer({ "a.md": "a" });
  const okDir = join(root, "ann-ok");
  await mkdir(okDir);
  await writeFile(join(okDir, "a.md"), "hello");
  const okCalls: unknown[] = [];
  const okSaid = (await runArtifact(
    invoke(["push", okDir, "--target", "#eng", "--title", "Plan", "--announcement"]),
    {
      ...okServer.transport,
      channel: async (command) => {
        okCalls.push(command);
        return { channel: { archived: false, channelCapabilities: { update: true } } };
      },
    },
  )) as string;
  expect(okSaid).toContain("It is now the announcement of #eng.");
  expect(okCalls).toEqual([
    { operation: "info", target: "#eng" },
    { operation: "update", target: "#eng", announcement: ID },
  ]);

  const dmServer = fakeServer({ "a.md": "a" });
  const dmDir = join(root, "ann-dm");
  await mkdir(dmDir);
  await writeFile(join(dmDir, "a.md"), "hello");
  const dmCalls: unknown[] = [];
  await runArtifact(
    invoke(["push", dmDir, "--target", "@alice", "--title", "DM Plan", "--announcement"]),
    {
      ...dmServer.transport,
      channel: async (command) => {
        dmCalls.push(command);
        return { channel: { archived: false, channelCapabilities: { update: true } } };
      },
    },
  );
  expect(dmCalls).toEqual([{ operation: "update", target: "@alice", announcement: ID }]);

  const failPinServer = fakeServer({ "a.md": "a" });
  const failPinDir = join(root, "ann-fail-pin");
  await mkdir(failPinDir);
  await writeFile(join(failPinDir, "a.md"), "hello");
  const pinErr = await failure(
    runArtifact(
      invoke(["push", failPinDir, "--target", "#eng", "--title", "Plan", "--announcement"]),
      {
        ...failPinServer.transport,
        channel: async (command) => {
          if (command.operation === "info")
            return { channel: { archived: false, channelCapabilities: { update: true } } };
          throw new Error("boom");
        },
      },
    ),
  );
  expect(pinErr.code).toBe("CHANNEL_ANNOUNCEMENT_NOT_SET");
  expect(pinErr.suggestedNextAction).toBe(
    `coforge channel update --target "#eng" --announcement ${ID}`,
  );
});
