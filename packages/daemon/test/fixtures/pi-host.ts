import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PiProvider } from "@lrm/coforge-anvil/pi";
import { piRuntimeHost } from "#src/code-agent/pi/host";

export function piProvider() {
  return new PiProvider({ host: piRuntimeHost });
}

export function completionStream(delta: Record<string, unknown>, finishReason: string | null) {
  return new Response(
    [
      `data: ${JSON.stringify({ id: crypto.randomUUID(), object: "chat.completion.chunk", created: 1, model: "custom", choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

export async function writeOpenAiHost(agentDir: string, baseUrl: string) {
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await Bun.write(join(agentDir, "auth.json"), JSON.stringify({ openai: "host-key" }));
  await Bun.write(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        openai: {
          baseUrl,
          models: [{ id: "custom", name: "Custom", api: "openai-completions" }],
        },
      },
    }),
  );
}

export function piRuntime(agentDir: string) {
  return {
    environment: { PI_CODING_AGENT_DIR: agentDir },
    runtime: {
      provider: "pi" as const,
      modelProvider: "openai",
      model: "custom",
      reasoning: "",
      providerConfig: { kind: "coforge" as const, providerId: "openai", apiKey: "agent-key" },
    },
  };
}
