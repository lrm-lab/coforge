import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ComputerUpdater } from "#src/updater";
import { InstallationDownloadError, runInstallationSource } from "#src/release/installation-source";
import { runCli } from "#src/cli";

// What the Computer's updater still does: read the installed version. Installing, manifest checks,
// artifact verification, and activation are the installer's (crates/installer), which tests them
// against real files and a loopback feed. The version selection the CLI prompts with is
// runInstallationSource (install.sh --resolve-only), so the pointer rules are pinned through it.

const temporaryDirectories: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

const target = process.platform === "darwin" ? "darwin-x64" : "linux-x64";

async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "coforge-updater-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** A feed whose `/latest` answers `latest` (or is absent), optionally through a redirect, and
 * that records every path it is asked for. */
function feed(options: { latest?: string; redirectLatest?: boolean } = {}) {
  const requested: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requested.push(path);
      if (options.redirectLatest && path === "/latest") {
        return new Response(null, { status: 302, headers: { Location: "/latest-real" } });
      }
      if (options.redirectLatest && path === "/latest-real") return new Response("2.0.0\n");
      if (path === "/latest" && options.latest !== undefined) {
        return new Response(`${options.latest}\n`);
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return { baseUrl: server.url.href, requested };
}

function resolve(baseUrl: string, selection: string): Promise<string> {
  return runInstallationSource({ baseUrl, target, selection });
}

test("current version is absent before any installation and follows active.json", async () => {
  const root = await scratchDirectory();
  const updater = new ComputerUpdater({ installRoot: root });
  expect(await updater.getCurrentVersion()).toBeNull();
  await writeFile(
    join(root, "active.json"),
    `${JSON.stringify({ schema_version: 1, current: "0.1.0-dev.15", previous: null })}\n`,
  );
  expect(await updater.getCurrentVersion()).toBe("0.1.0-dev.15");
});

test("latest and an exact version selector resolve to the same version", async () => {
  const { baseUrl } = feed({ latest: "2.0.0" });

  expect(await resolve(baseUrl, "latest")).toBe("2.0.0");
  expect(await resolve(baseUrl, "2.0.0")).toBe("2.0.0");
});

test("a self-referencing latest pointer fails before upgrade consent", async () => {
  const feedServer = feed({ latest: "latest" });
  let prompted = false;
  let upgraded = false;
  const errors: string[] = [];
  const code = await runCli(
    ["upgrade"],
    {
      login: { async run() {} },
      setup: { async run() {} },
      updater: {
        resolveVersion: (selector) => resolve(feedServer.baseUrl, selector),
        getCurrentVersion: async () => null,
        async install() {},
        async recover() {
          return 0;
        },
        async repair() {
          return 0;
        },
        async upgrade() {
          upgraded = true;
        },
      },
    },
    {
      stdout: () => {},
      stderr: (line) => errors.push(line),
      prompt: () => {
        prompted = true;
        return "y";
      },
    },
  );
  expect(code).toBe(1);
  expect(errors.join("\n")).not.toBe("");
  expect(prompted).toBe(false);
  expect(upgraded).toBe(false);
  expect(feedServer.requested).toEqual(["/latest"]);
});

test("an unreachable latest pointer and an unparsable version selector fail closed", async () => {
  await expect(resolve(feed().baseUrl, "latest")).rejects.toThrow();

  const input = feed({ latest: "2.0.0" });
  await expect(resolve(input.baseUrl, "../etc/passwd")).rejects.toThrow();
  // The selector is rejected before any network access, so nothing was requested.
  expect(input.requested).toEqual([]);
});

test("a latest pointer that is not a version string is rejected", async () => {
  const { baseUrl } = feed({ latest: "<html>not found</html>" });

  await expect(resolve(baseUrl, "latest")).rejects.toThrow();
});

test("a redirected feed response is rejected even when the redirect target names a valid version", async () => {
  // The redirect target serves a perfectly valid pointer, so only `redirected` distinguishes this
  // from a legitimate answer: a redirect to something that also fails on its own merits would not
  // prove the redirect check itself is doing the rejecting.
  const { baseUrl } = feed({ redirectLatest: true });

  await expect(resolve(baseUrl, "latest")).rejects.toThrow();
});

test("a version of '.' or one that starts with '-' is rejected", async () => {
  const input = feed({ latest: "2.0.0" });
  for (const invalid of [".", "-rf"]) {
    await expect(resolve(input.baseUrl, invalid)).rejects.toThrow();
  }
  // Rejected before any network access. Without this, a "." or "-rf" selector that slipped past
  // validation would still 404 against the feed and fail the same way, which would let this test
  // pass for the wrong reason.
  expect(input.requested).toEqual([]);
});

test("a feed that answers 5xx is a download failure carrying the script's exit status", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("down", { status: 503 }),
  });
  servers.push(server);

  const failure = await resolve(server.url.href, "latest").catch((e) => e);

  expect(failure).toBeInstanceOf(InstallationDownloadError);
  expect(failure.message).toContain("exit 75");
});

test("a feed answering with an invalid pointer is not a download failure", async () => {
  const { baseUrl } = feed({ latest: "../evil" });

  const failure = await resolve(baseUrl, "latest").catch((e) => e);

  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(InstallationDownloadError);
});
