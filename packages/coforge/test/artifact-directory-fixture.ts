import { afterEach, beforeEach } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentArtifactRequest } from "@lrm/coforge-sdk/agent";
import { parseArgs } from "../index";
import {
  runArtifact,
  type ArtifactInvocation,
  type ArtifactTransport,
} from "../src/artifact-commands";
import { CliError } from "../src/cli-error";

/** What the artifact directory tests share: a scratch directory per test, and a fake server that
 * keeps versions the way the Web's contract describes. */

export const ID = "0f8c3b52-6d0e-4f3a-9a51-3c1d2e4f5a6b";
export const STATE = ".coforge-artifact.json";
export const sha256 = (bytes: Uint8Array | string) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
export const text = (value: string) => new TextEncoder().encode(value);
/** Not valid UTF-8: any text round trip corrupts it. */
export const BINARY = new Uint8Array([0, 255, 254, 128, 10, 13, 200]);

export let root: string;
export const servers: { stop(): void }[] = [];

/** Gives the calling test file its scratch `root` and stops its servers, test by test. */
export function useScratch() {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "coforge-artifact-dir-"));
  });
  afterEach(async () => {
    for (const server of servers.splice(0)) server.stop();
    await rm(root, { recursive: true, force: true });
  });
}

export type Files = Record<string, Uint8Array | string>;

/** An artifact kept by the fake: every version's files, and the bytes it was told about. */
export function fakeServer(initial: Files = {}, title = "Launch plan") {
  const bytes = new Map<string, Uint8Array>();
  const known = new Set<string>();
  const versions: Map<string, string>[] = [new Map()];
  const put = (files: Files) => {
    const next = new Map(versions.at(-1));
    for (const [path, content] of Object.entries(files)) {
      const data = typeof content === "string" ? text(content) : content;
      bytes.set(sha256(data), data);
      known.add(sha256(data));
      next.set(path, sha256(data));
    }
    versions.push(next);
  };
  if (Object.keys(initial).length > 0) put(initial);
  let unseen: unknown;
  const requests: AgentArtifactRequest[] = [];
  const uploads: string[] = [];
  const downloads: { path: string; version?: number }[] = [];
  const listing = (number: number) =>
    [...versions[number]!].map(([path, hash]) => ({
      path,
      sha256: hash,
      sizeBytes: bytes.get(hash)!.byteLength,
      kind: "text",
    }));
  const server = {
    requests,
    uploads,
    downloads,
    /** Versions the server holds, current last (index 0 is the empty start). */
    get current() {
      return versions.length - 1;
    },
    currentFiles: () => Object.fromEntries(versions.at(-1)!),
    /** Someone else saves, moving the artifact on. */
    others: put,
    /** Refuse the next manifest save as a clash on these paths. */
    clash: undefined as string[] | undefined,
    /** What a read of the current version says others pushed since the Agent last looked. */
    get unseen() {
      return unseen;
    },
    set unseen(value: unknown) {
      unseen = value;
    },
    transport: {
      artifact: async (request: AgentArtifactRequest) => {
        requests.push(request);
        if (request.operation === "read") {
          const number = request.version ?? versions.length - 1;
          return {
            artifact: { id: ID, title, currentVersion: versions.length - 1 },
            version: { number, note: null, label: null },
            entryPath: versions[number]!.has("index.html") ? "index.html" : "plan.md",
            files: listing(number),
            text: "",
            ...(unseen !== undefined && request.version === undefined ? { unseen } : {}),
          };
        }
        if (request.operation !== "push" && request.operation !== "create")
          throw new Error(`unexpected ${request.operation}`);
        if (server.clash)
          throw new CliError({
            code: "CONFLICT",
            message: "conflict (artifact-agent-base-moved): the artifact changed after you read it",
            details: { files: server.clash.join("\n"), settings: "title" },
          });
        const missing = (request.files ?? [])
          .map((file) => file.sha256)
          .filter((h) => !known.has(h));
        if (missing.length > 0) return { status: "missing", missing };
        const next = new Map(versions.at(-1));
        for (const file of request.files ?? []) next.set(file.path, file.sha256);
        for (const path of request.delete ?? []) next.delete(path);
        versions.push(next);
        return request.operation === "create"
          ? {
              id: ID,
              name: "launch-plan",
              title: request.title,
              currentVersion: versions.length - 1,
            }
          : { status: "created", number: versions.length - 1, merged: [], mergedSettings: [] };
      },
      artifactUpload: async (hash: string, data: Uint8Array) => {
        uploads.push(hash);
        if (sha256(data) !== hash) throw new Error("hash mismatch");
        bytes.set(hash, data);
        known.add(hash);
      },
      artifactDownload: async (request: { artifact: string; path: string; version?: number }) => {
        downloads.push({ path: request.path, version: request.version });
        const number = request.version ?? versions.length - 1;
        const hash = versions[number]!.get(request.path);
        if (!hash) throw new CliError({ code: "NOT_FOUND", message: "artifact file not found" });
        return bytes.get(hash)!;
      },
    } satisfies ArtifactTransport,
  };
  return server;
}

export const invoke = (args: string[]) => parseArgs(["artifact", ...args]) as ArtifactInvocation;
export const run = (server: { transport: ArtifactTransport }, args: string[]) =>
  runArtifact(invoke(args), server.transport);
export const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a failure");
    },
    (caught: unknown) => caught as CliError,
  );
export const read = (...parts: string[]) => readFile(join(root, ...parts));
export const stateOf = async (dir: string) => JSON.parse(await readFile(join(dir, STATE), "utf8"));

export function serveBytes(handler: (request: Request) => Response | Promise<Response>) {
  const seen: { method: string; path: string; headers: Headers; bytes: Uint8Array }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      seen.push({
        method: request.method,
        path: new URL(request.url).pathname + new URL(request.url).search,
        headers: request.headers,
        bytes: new Uint8Array(await request.arrayBuffer()),
      });
      return handler(request);
    },
  });
  servers.push(server);
  const proxyUrl = `http://127.0.0.1:${server.port}`;
  const endpoint = (path: string) => new URL(path, proxyUrl);
  return { seen, proxyUrl, endpoint };
}
export const CONTEXT = `sfp_${"a".repeat(43)}`;
