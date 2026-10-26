import { piProvider } from "./fixtures/pi-host";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCoforgeAgentInstructions } from "#src/code-agent/agent-instructions";

// Runs the bundled, unmodified Pi runtime against a deterministic local model endpoint.
// This proves native transcript isolation/resume; it is not a live-provider conversation proof.
test("platform assistant native sessions isolate members and resume only their own transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-assistant-native-"));
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(await request.text());
      const chunk = {
        id: crypto.randomUUID(),
        object: "chat.completion.chunk",
        created: 1,
        model: "assistant-proof",
        choices: [
          { index: 0, delta: { role: "assistant", content: "ack" }, finish_reason: "stop" },
        ],
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  const ids = new Map<string, string>();
  try {
    const agentDir = join(root, "host");
    await mkdir(agentDir);
    await Bun.write(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          openai: {
            baseUrl: `${server.url}v1`,
            models: [{ id: "assistant-proof", name: "Assistant proof", api: "openai-completions" }],
          },
        },
      }),
    );
    async function turn(member: string, message: string, resume = false) {
      const directory = join(root, member);
      await mkdir(directory, { recursive: true });
      const session = await piProvider().createAgentSession({
        agentId: member,
        agentWorkspaceDirectory: directory,
        sessionId: resume ? ids.get(member) : undefined,
        instructions: buildCoforgeAgentInstructions({
          agentId: member,
          agentWorkspaceDirectory: directory,
          identity: { systemKind: "workspace-assistant", displayName: "通用助手" },
        }),
        environment: { PI_CODING_AGENT_DIR: agentDir },
        runtime: {
          provider: "pi",
          modelProvider: "openai",
          model: "assistant-proof",
          reasoning: "",
          providerConfig: { kind: "coforge", providerId: "openai", apiKey: "local-proof-only" },
        },
        async onSessionId(id) {
          if (resume) expect(id).toBe(ids.get(member)!);
          ids.set(member, id);
        },
      });
      try {
        await session.sendMessage(message);
      } finally {
        await session.dispose();
      }
    }
    await turn("alice", "alice-private-marker");
    await turn("bob", "bob-private-marker");
    expect(ids.get("alice")).not.toBe(ids.get("bob"));
    expect(requests[0]).toContain("alice-private-marker");
    expect(requests[0]).not.toContain("bob-private-marker");
    expect(requests[1]).toContain("bob-private-marker");
    expect(requests[1]).not.toContain("alice-private-marker");
    await turn("alice", "resume-alice", true);
    expect(requests[2]).toContain("alice-private-marker");
    expect(requests[2]).not.toContain("bob-private-marker");
    await turn("bob", "resume-bob", true);
    expect(requests[3]).toContain("bob-private-marker");
    expect(requests[3]).not.toContain("alice-private-marker");
    expect(requests.every((body) => body.includes("Command toolbox"))).toBe(true);
    const artifacts = new URL("../../../.amp/e2e/workspace-assistant/", import.meta.url).pathname;
    await mkdir(artifacts, { recursive: true });
    await Bun.write(
      join(artifacts, "native-report.json"),
      JSON.stringify(
        {
          feature: "workspace-assistant",
          environment: "bundled native Pi runtime, deterministic local model endpoint",
          steps: [
            "Create independent native sessions for Alice and Bob",
            "Run distinct private prompts",
            "Dispose both sessions and resume their persisted native IDs",
          ],
          observations: [
            "Native IDs differed",
            "Each initial and resumed model request contained only its own member's marker",
            "The platform playbook reached every model request",
          ],
          outcome: "pass",
          notes:
            "The endpoint returns deterministic completions. This does not exercise a real external model or Web-to-Daemon delivery.",
        },
        null,
        2,
      ),
    );
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
