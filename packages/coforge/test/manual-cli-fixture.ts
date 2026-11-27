import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentApiRoutes } from "@lrm/coforge-sdk/agent";
import { profileStore } from "#src/external/profile-store";

export const input = "recovery & diagnostics";
export const intent = "Read the requested documentation";
export const reason = "Identify the read-only diagnostic path";
export const slug = "manual-fixture";
export const noticePath = agentApiRoutes.proxy.computerUpdateNotice.path;
export const routes = [
  {
    command: "get",
    parameter: "topic",
    path: agentApiRoutes.manual.get.path,
    body: {
      ok: true,
      docId: "recovery",
      topicOrPath: input,
      docVersion: "fixture-v1",
      docState: "published",
      contentType: "text/markdown",
      content: "# Fixture manual\n",
    },
    stdout: "# Fixture manual\n",
  },
  {
    command: "search",
    parameter: "query",
    path: agentApiRoutes.manual.search.path,
    body: {
      ok: true,
      query: input,
      scope: null,
      results: [{ slug: "recovery", title: "Fixture manual", firstScreen: "Test result" }],
    },
    stdout: "1. recovery — Fixture manual\n   Test result\n",
  },
] as const;

export const modes = ["managed", "external"] as const;
export const faults = ["refused", "timeout", "body-timeout", "502", "503"] as const;
export const controls = ["success", "404", "401", "403", "missing"] as const;
type Route = (typeof routes)[number];
export type Mode = (typeof modes)[number];
export type Scenario = (typeof faults)[number] | (typeof controls)[number] | "redirect";

const MANUAL_CLI_PROCESS_TIMEOUT_MS = 25_000;
const FIXTURE_SETUP_AND_CLEANUP_BUDGET_MS = 5_000;
export const MANUAL_FIXTURE_TEST_TIMEOUT_MS =
  MANUAL_CLI_PROCESS_TIMEOUT_MS + FIXTURE_SETUP_AND_CLEANUP_BUDGET_MS;

const managedKey = `sfp_${"m".repeat(43)}`;
const externalKey = `sk_ext_${"e".repeat(43)}`;

export async function runManualFixture(
  route: Route,
  mode: Mode,
  scenario: Scenario,
  cli: readonly string[] = [process.execPath, join(import.meta.dir, "../src/cli.ts")],
) {
  const home = await mkdtemp(join(tmpdir(), "coforge-manual-"));
  const requests: {
    path: string;
    method: string;
    query: Record<string, string>;
    authorized: boolean;
  }[] = [];
  const timeout = Promise.withResolvers<Response>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch(request) {
      const url = new URL(request.url);
      requests.push({
        path: url.pathname,
        method: request.method,
        query: Object.fromEntries(url.searchParams),
        authorized:
          request.headers.get("authorization") ===
          `Bearer ${mode === "managed" ? managedKey : externalKey}`,
      });
      if (url.pathname === noticePath) return Response.json({ ok: true, notice: "Fixture update" });
      if (url.pathname !== route.path) return new Response(null, { status: 400 });
      if (scenario === "timeout") return timeout.promise;
      if (scenario === "body-timeout")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"ok":'));
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      if (scenario === "redirect") return Response.redirect(new URL("/unexpected", url).href);
      if (scenario === "success") return Response.json(route.body);
      if (scenario === "404")
        return Response.json(
          { ok: false, errorCode: "knowledge_not_found", error: "Fixture topic not found" },
          { status: 404 },
        );
      if (scenario === "503")
        return Response.json(
          { ok: false, errorCode: "knowledge_query_invalid", error: "Fixture server error" },
          { status: 503 },
        );
      if (scenario === "401" && mode === "external")
        return Response.json({ code: "invalid_credential" }, { status: 401 });
      return new Response("Fixture error", { status: Number(scenario) });
    },
  });
  const origin = server.url.origin;
  try {
    if (scenario === "refused") await server.stop(true);
    const env = { HOME: home, COFORGE_AGENT_HOME: join(home, "agent") };
    const args = ["manual", route.command, input, "--intent", intent, "--reason", reason];
    if (mode === "external") {
      if (scenario !== "missing")
        await profileStore(env).writeProfile(slug, {
          schemaVersion: 1,
          serverUrl: origin,
          workspaceId: "w1",
          workspaceSlug: "fixture",
          agentId: "a1",
          agentName: "fixture",
          credentialId: "c1",
          apiKey: externalKey,
          createdAt: "2026-11-25T00:00:00Z",
        });
      args.push("--profile", slug);
    }
    const child = Bun.spawn([...cli, ...args], {
      env:
        mode === "managed" && scenario !== "missing"
          ? { ...env, COFORGE_AGENT_CONTEXT: managedKey, COFORGE_AGENT_PROXY_URL: origin }
          : env,
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(MANUAL_CLI_PROCESS_TIMEOUT_MS),
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exitCode, requests };
  } finally {
    timeout.resolve(new Response(null, { status: 503 }));
    if (scenario !== "refused") await server.stop(true);
    await rm(home, { recursive: true, force: true });
  }
}
