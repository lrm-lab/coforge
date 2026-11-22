import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeEvent, AgentSession } from "@lrm/coforge-anvil";
import { CoforgeProvider } from "#src/code-agent/pi/provider";
import { completionStream, piProvider, piRuntime, writeOpenAiHost } from "./fixtures/pi-host";

const input = "Read the fixture and report what it contains.";
const toolOutput = "pi-continuation-read-only-result";
const providerError = "Provider finish_reason: error";
const encryptedThinking = {
  reasoning_details: [{ type: "reasoning.encrypted", data: "fixture-thinking-signature" }],
};

type ModelMessage = { role: string; content: unknown };
type Scenario =
  | "continue"
  | "built-in"
  | "repeat-error"
  | "rejected-continuation"
  | "erased-output"
  | "erased-thinking"
  | "settled-extension"
  | "partial-output"
  | "thinking"
  | "encrypted-thinking"
  | "tool-action"
  | "other-error"
  | "no-tool"
  | "cancel"
  | "cancel-continuation"
  | "dispose";

const partialOutput: Partial<Record<Scenario, Record<string, unknown>>> = {
  "partial-output": { content: "partial answer" },
  "erased-output": { content: "partial answer" },
  thinking: { reasoning_content: "I have the result." },
  "encrypted-thinking": encryptedThinking,
  "erased-thinking": encryptedThinking,
  "tool-action": readToolDelta("unfinished-read"),
};

test.each<Scenario>([
  "continue",
  "built-in",
  "repeat-error",
  "rejected-continuation",
  "erased-output",
  "erased-thinking",
  "settled-extension",
  "partial-output",
  "thinking",
  "encrypted-thinking",
  "tool-action",
  "other-error",
  "no-tool",
  "cancel",
  "cancel-continuation",
  "dispose",
])(
  "embedded Pi handles the provider finish error with %s",
  async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), "coforge-pi-finish-error-"));
    const workspace = join(root, "workspace");
    const agentDir = join(root, "pi-agent");
    const signatureFile = join(root, "observed-reasoning");
    const requests: ModelMessage[][] = [];
    const events: AgentRuntimeEvent[] = [];
    const liveAtCompleted: Array<boolean | undefined> = [];
    const errorRequest = scenario === "no-tool" ? 1 : 2;
    const cancellationPoint = Promise.withResolvers<void>();
    const releaseResponse = Promise.withResolvers<void>();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname === "/continuation-start") {
          cancellationPoint.resolve();
          await releaseResponse.promise;
          return new Response(null, { status: 204 });
        }
        const body = (await request.json()) as { messages: ModelMessage[] };
        const count = requests.push(body.messages);
        if (count === errorRequest && (scenario === "cancel" || scenario === "dispose")) {
          cancellationPoint.resolve();
          await releaseResponse.promise;
        }
        if (count === errorRequest || (count === 4 && scenario === "repeat-error")) {
          return completionStream(
            partialOutput[scenario] ?? {},
            scenario === "other-error" ? "content_filter" : "error",
          );
        }
        if (count === 1 || (count === 3 && scenario === "repeat-error")) {
          return completionStream(
            readToolDelta(count === 1 ? "fixture-read" : "follow-up-read"),
            "tool_calls",
          );
        }
        return completionStream({ content: `answer ${count}` }, "stop");
      },
    });
    let session: AgentSession | undefined;
    try {
      await mkdir(workspace);
      await Bun.write(join(workspace, "fixture.txt"), toolOutput);
      await writeOpenAiHost(agentDir, `${server.url}v1`);
      if (scenario === "erased-output" || scenario === "erased-thinking") {
        await Bun.write(
          join(agentDir, "extensions", "erase-error-output.ts"),
          `export default function (pi) {
            pi.on("message_end", async ({ message }) => {
              if (message.role === "assistant" && message.stopReason === "error") {
                const signature = message.content.find(
                  (part) => part.type === "thinking" && part.thinkingSignature,
                )?.thinkingSignature;
                if (signature) await Bun.write(${JSON.stringify(signatureFile)}, signature);
                return { message: { ...message, content: [] } };
              }
            });
          }`,
        );
      }
      if (scenario === "settled-extension") {
        await Bun.write(
          join(agentDir, "extensions", "settled-follow-up.ts"),
          `export default function (pi) {
            let queued = false;
            pi.on("agent_settled", () => {
              if (queued) return;
              queued = true;
              pi.sendMessage(
                { customType: "fixture", display: false, content: "Independent extension input" },
                { triggerTurn: true },
              );
            });
          }`,
        );
      }
      if (scenario === "rejected-continuation") {
        await Bun.write(
          join(agentDir, "extensions", "reject-continuation-boundary.ts"),
          `export default function (pi) {
            pi.on("agent_before_settle", ({ outcome }) => {
              if (outcome === "error") {
                return { entries: [{ type: "context_edit", targetId: "missing-entry", replacement: null }] };
              }
            });
          }`,
        );
      }
      if (scenario === "cancel-continuation") {
        await Bun.write(
          join(agentDir, "extensions", "pause-continuation-boundary.ts"),
          `export default function (pi) {
            pi.on("agent_before_settle", async ({ outcome }) => {
              if (outcome === "error") {
                await fetch(${JSON.stringify(new URL("/continuation-start", server.url).href)});
              }
            });
          }`,
        );
      }
      const configured = piRuntime(agentDir);
      const provider = scenario === "built-in" ? new CoforgeProvider({ agentDir }) : piProvider();
      const active = await provider.createAgentSession({
        agentWorkspaceDirectory: workspace,
        instructions: "Test Agent instructions.",
        ...configured,
        runtime: { ...configured.runtime, provider: provider.provider },
      });
      session = active;
      active.subscribe((event) => {
        events.push(event);
        if (event.type === "completed") liveAtCompleted.push(active.hasLiveTurn);
      });

      const turn = active.sendMessage(input);
      const stoppedEarly =
        scenario === "cancel" || scenario === "dispose" || scenario === "cancel-continuation";
      if (stoppedEarly) {
        await cancellationPoint.promise;
        expect(active.hasLiveTurn).toBe(true);
        expect(events.filter((event) => event.type === "completed")).toEqual([]);
        const stopped = scenario === "dispose" ? active.dispose() : active.interrupt();
        releaseResponse.resolve();
        await stopped;
      }
      await turn;

      const extensionRun = scenario === "settled-extension";
      const succeeded = scenario === "continue" || scenario === "built-in" || extensionRun;
      const continued = succeeded || scenario === "repeat-error";
      expect(requests).toHaveLength(
        errorRequest + Number(continued) + Number(scenario === "repeat-error" || extensionRun),
      );
      expect(events.filter((event) => event.type === "completed")).toEqual([
        {
          type: "completed",
          status: succeeded ? "completed" : stoppedEarly ? "interrupted" : "failed",
        },
        ...(extensionRun ? ([{ type: "completed", status: "completed" }] as const) : []),
      ]);
      expect(liveAtCompleted).toEqual(extensionRun ? [false, false] : [false]);
      const toolStarts = events.filter((event) => event.type === "tool-start");
      expect(toolStarts.map((event) => event.id)).toEqual(
        scenario === "no-tool"
          ? []
          : scenario === "repeat-error"
            ? ["fixture-read", "follow-up-read"]
            : ["fixture-read"],
      );
      const failureMessage =
        scenario === "other-error" ? "Provider finish_reason: content_filter" : providerError;
      const shouldFail = !succeeded && !stoppedEarly;
      expect(events.filter((event) => event.type === "error")).toEqual(
        shouldFail ? [{ type: "error", message: failureMessage }] : [],
      );
      if (continued) {
        const recoveryContext = requests[2] ?? [];
        expect(
          recoveryContext.filter((message) => JSON.stringify(message.content).includes(input)),
        ).toHaveLength(1);
        expect(recoveryContext.filter((message) => message.role === "tool")).toEqual([
          expect.objectContaining({ content: expect.stringContaining(toolOutput) }),
        ]);
      }

      if (scenario === "erased-output") {
        expect(events).toContainEqual({ type: "text-delta", text: "partial answer" });
      }
      if (scenario === "erased-thinking") {
        expect(await Bun.file(signatureFile).text()).toContain("fixture-thinking-signature");
      }
      if (extensionRun) {
        expect(JSON.stringify(requests[2])).toContain("Continue from the tool results above");
        expect(JSON.stringify(requests[2])).not.toContain("Independent extension input");
        expect(JSON.stringify(requests[3])).toContain("Independent extension input");
      }

      if (scenario !== "dispose") {
        events.length = 0;
        await active.sendMessage("New independent turn");
        expect(events.filter((event) => event.type === "completed")).toEqual([
          { type: "completed", status: "completed" },
        ]);
        expect(events.filter((event) => event.type === "error")).toEqual([]);
        if (scenario === "cancel-continuation" || scenario === "rejected-continuation") {
          expect(JSON.stringify(requests.at(-1))).not.toContain(
            "Continue from the tool results above",
          );
        }
      }
    } finally {
      releaseResponse.resolve();
      await session?.dispose();
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

function readToolDelta(id: string) {
  return {
    tool_calls: [
      {
        index: 0,
        id,
        type: "function",
        function: { name: "read", arguments: '{"path":"fixture.txt"}' },
      },
    ],
  };
}
