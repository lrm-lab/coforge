import { chmod, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildCoforgeAgentInstructions } from "../src/code-agent/agent-instructions";
import { decodePlatformMemoryCommand, type PlatformMemoryCommand } from "@lrm/coforge-sdk/agent";

if (Bun.env.PLATFORM_MEMORY_MODEL_SMOKE !== "1")
  throw new Error(
    "Explicit PLATFORM_MEMORY_MODEL_SMOKE=1 is required; this makes real model calls",
  );
const model = Bun.env.PLATFORM_MEMORY_EVAL_MODEL;
if (!model)
  throw new Error("PLATFORM_MEMORY_EVAL_MODEL must name the authorized native Codex model");
const output =
  Bun.env.PLATFORM_MEMORY_MODEL_OUTPUT ?? (await mkdtemp(join(tmpdir(), "coforge-memory-model-")));
const root = resolve(import.meta.dir, "../../..");
const fixture = await mkdtemp(join(tmpdir(), "coforge-memory-tools-"));
const bin = join(fixture, "bin");
const work = join(fixture, "workspace");
await Promise.all([mkdir(bin), mkdir(work), mkdir(output, { recursive: true })]);
const instructions = buildCoforgeAgentInstructions({
  agentWorkspaceDirectory: work,
  identity: { features: { platformMemory: true } },
});
const guidance = instructions.slice(instructions.indexOf("## Platform memory"));
const context = `sfp_${"a".repeat(43)}`;
const entry = {
  id: "11111111-1111-4111-8111-111111111111",
  scope: "team",
  title: "Preview domain decision",
  kind: "fact",
  content:
    "The synthetic team previously designated pr517-preview-demo.com as its already-purchased HTML preview domain. Use this historical decision when asked what was decided; this fixture authorizes no real server changes.",
  revision: 1,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
  canEdit: false,
};
let calls: PlatformMemoryCommand[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.headers.get("authorization") !== `Bearer ${context}`)
      return new Response(null, { status: 401 });
    const path = new URL(request.url).pathname;
    if (path.endsWith("/memory")) {
      const command = decodePlatformMemoryCommand(await request.json());
      calls.push(command);
      if (!["search", "get", "list", "status"].includes(command.operation))
        return Response.json(
          { errorCode: "FORBIDDEN", error: "Read-only evaluation data" },
          { status: 403 },
        );
      return Response.json({ enabled: true, available: true, entries: [entry] });
    }
    if (path.includes("/manual/"))
      return Response.json({
        ok: true,
        docId: "memory",
        topicOrPath: "memory",
        docVersion: "fixture",
        docState: "published",
        contentType: "text/markdown",
        content: await Bun.file(
          join(root, "apps/web/src/server/agents/manual/topics/memory.md"),
        ).text(),
      });
    return Response.json(
      { errorCode: "FORBIDDEN", error: "Only memory/manual fixture routes are available" },
      { status: 403 },
    );
  },
});
await Bun.write(
  join(bin, "coforge"),
  `#!/usr/bin/env bun\nimport { runAgentCli } from ${JSON.stringify(join(root, "packages/coforge/src/cli.ts"))};\nawait runAgentCli(Bun.argv.slice(2));\n`,
);
await chmod(join(bin, "coforge"), 0o700);
const cases = [
  { name: "greeting", prompt: "hi", search: false },
  {
    name: "current-context",
    prompt: "当前任务的要求是：发布前跑测试和构建。请告诉我发版前要做什么。",
    search: false,
  },
  { name: "history", prompt: "上次我们给网页预览确定的域名是什么？", search: true },
  {
    name: "before-reasking",
    prompt: "继续我们已经买好的网页预览域名配置，暂不操作服务器，先告诉我该用哪个域名。",
    search: true,
  },
  {
    name: "explicit-previous",
    prompt: "网页预览域名按上次确定的来。先告诉我上次的决定。",
    search: true,
  },
];
type ModelEvent = {
  type?: string;
  item?: { type?: string; text?: string; command?: string };
  error?: unknown;
};
const results: {
  name: string;
  prompt: string;
  repeat: number;
  expectedSearch: boolean;
  code: number;
  passed: boolean;
  calls: PlatformMemoryCommand[];
  answer: string;
  events: ModelEvent[];
  stderr: string;
}[] = [];
try {
  for (let repeat = 1; repeat <= 2; repeat++)
    for (const item of cases) {
      calls = [];
      const child = Bun.spawn(
        [
          "codex",
          "exec",
          "--ephemeral",
          "--ignore-user-config",
          "--skip-git-repo-check",
          "--json",
          "-m",
          model,
          "-s",
          "workspace-write",
          "-C",
          work,
          "-c",
          "features.apps=false",
          "-c",
          "sandbox_workspace_write.network_access=true",
          "-c",
          "developer_instructions=" +
            JSON.stringify(
              "You are a CoForge Agent. The coforge CLI is on PATH. This is a read-only synthetic evaluation; respond directly and operate only in the provided workspace.\n" +
                guidance,
            ),
          item.prompt,
        ],
        {
          env: {
            HOME: Bun.env.HOME,
            PATH: bin + ":" + Bun.env.PATH,
            LANG: "C.UTF-8",
            http_proxy: Bun.env.http_proxy,
            https_proxy: Bun.env.https_proxy,
            HTTP_PROXY: Bun.env.HTTP_PROXY,
            HTTPS_PROXY: Bun.env.HTTPS_PROXY,
            ALL_PROXY: Bun.env.ALL_PROXY,
            NO_PROXY: "127.0.0.1,localhost",
            no_proxy: "127.0.0.1,localhost",
            COFORGE_AGENT_CONTEXT: context,
            COFORGE_AGENT_PROXY_URL: server.url.origin,
          },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      let force: ReturnType<typeof setTimeout> | undefined;
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        force = setTimeout(() => child.kill("SIGKILL"), 5000);
      }, 120000);
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      clearTimeout(timeout);
      if (force) clearTimeout(force);
      const events = stdout.split("\n").flatMap((line): ModelEvent[] => {
        try {
          const event = JSON.parse(line) as ModelEvent;
          return ["command_execution", "agent_message"].includes(event.item?.type ?? "") ||
            ["error", "turn.failed", "turn.completed"].includes(event.type ?? "")
            ? [event]
            : [];
        } catch {
          return [];
        }
      });
      const answer = events
        .filter((event) => event.item?.type === "agent_message")
        .map((event) => event.item?.text)
        .join("\n");
      const searched = calls.some((call) => call.operation === "search");
      const passed =
        code === 0 &&
        searched === item.search &&
        (item.search || calls.length === 0) &&
        (!item.search || answer.includes("pr517-preview-demo.com"));
      results.push({
        name: item.name,
        prompt: item.prompt,
        repeat,
        expectedSearch: item.search,
        code,
        passed,
        calls: structuredClone(calls),
        answer,
        events,
        stderr,
      });
      console.log(
        JSON.stringify({
          name: item.name,
          repeat,
          code,
          passed,
          operations: calls.map((call) => call.operation),
        }),
      );
      await Bun.write(
        join(output, "results.json"),
        JSON.stringify(
          {
            model,
            guidanceSha256: new Bun.CryptoHasher("sha256").update(guidance).digest("hex"),
            scope:
              "Real native Codex model with production memory guidance and branch CLI; synthetic read-only memory HTTP fixture. This is not real OpenViking or full CoForge delivery acceptance.",
            results,
          },
          null,
          2,
        ),
      );
      if (code !== 0)
        throw new Error(`Native model invocation failed; inspect ${join(output, "results.json")}`);
    }
} finally {
  server.stop(true);
}
console.log(`Evidence: ${join(output, "results.json")}`);
if (results.some((result) => !result.passed))
  throw new Error("A model memory-selection scenario failed");
