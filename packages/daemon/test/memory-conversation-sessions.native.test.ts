import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSession,
  type AgentSession,
  type AgentSessionOptions,
  type AgentRuntimeEvent,
} from "@coforge/agent";
import { MemoryConversationSessions } from "#src/agent-runtime/memory-conversation-sessions";
import { FileConversationSessionStore } from "#src/persistence/conversation-session-store";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

test("real Pi transcript files recover per group with one shared working directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memory-native-groups-"));
  directories.push(directory);
  const work = join(directory, "workspace");
  await mkdir(work, { mode: 0o700 });
  const captures: {
    scope?: string;
    nativeId: string;
    file?: string;
    history: string;
    tools: string[];
  }[] = [];
  const options: AgentSessionOptions = {
    agentId: "memory",
    agentWorkspaceDirectory: work,
    instructions: "Offline session persistence test",
    sessionId: "control",
    sessionMode: "create",
    memoryControlSession: true,
  };
  const create = async (input: AgentSessionOptions): Promise<AgentSession> => {
    const native = await createSession({
      cwd: input.agentWorkspaceDirectory,
      agentId: input.agentId,
      sessionId: input.sessionId,
      sessionMode: input.sessionMode,
      instructions: input.instructions,
      apiKey: "offline-fixture-key",

      conversation: input.conversation,
      memoryControlSession: input.memoryControlSession,
    });
    await input.onSessionId?.(native.sessionId, native.replacedSessionId);
    captures.push({
      scope: input.conversation?.conversationId,
      nativeId: native.sessionId,
      file: native.session.sessionManager.getSessionFile(),
      history: JSON.stringify(native.session.agent.state.messages),
      tools: native.session.getActiveToolNames(),
    });
    const listeners = new Set<(event: AgentRuntimeEvent) => void>();
    const exits = new Set<() => void>();
    // Exercise the official SDK's real append/resume path without a paid network model.
    const notify = async (text: string) => {
      native.session.sessionManager.appendMessage({ role: "user", content: text, timestamp: 1 });
      native.session.sessionManager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "saved" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "offline",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      });
      for (const listener of listeners) listener({ type: "completed", status: "completed" });
    };
    return {
      hasLiveTurn: false,
      notify,
      sendMessage: notify,
      readSessionIdentity: async () => ({ sessionId: native.sessionId, state: "resumable" }),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onExit: (listener) => {
        exits.add(listener);
        return () => exits.delete(listener);
      },
      interrupt: async () => {},
      dispose: async () => {
        await native.dispose();
        for (const exit of exits) exit();
      },
    };
  };
  const open = async () =>
    new MemoryConversationSessions({
      primary: await create(options),
      options,
      create,
      store: new FileConversationSessionStore(join(directory, "daemon-state", "groups.json")),
    });
  let session: MemoryConversationSessions | undefined;
  try {
    session = await open();
    const a = { conversationId: "group-a", target: "#alpha" };
    const b = { conversationId: "group-b", target: "#beta" };
    await session.notify("ALPHA_ONLY_SECRET", { conversation: a });
    await session.notify("BETA_ONLY_SECRET", { conversation: b });
    await Bun.write(join(work, "shared-memory.txt"), "both groups use this directory");
    await session.dispose();
    session = await open();
    await session.notify("alpha resumed", { conversation: a });
    await session.notify("beta resumed", { conversation: b });
    expect(
      captures.filter((capture) => !capture.scope).every((capture) => capture.tools.length === 0),
    ).toBe(true);
    const alpha = captures.filter((capture) => capture.scope === a.conversationId);
    const beta = captures.filter((capture) => capture.scope === b.conversationId);
    expect(alpha[1]!.nativeId).toBe(alpha[0]!.nativeId);
    expect(beta[1]!.nativeId).toBe(beta[0]!.nativeId);
    expect(alpha[0]!.nativeId).not.toBe(beta[0]!.nativeId);
    expect(alpha[1]!.history).toContain("ALPHA_ONLY_SECRET");
    expect(alpha[1]!.history).not.toContain("BETA_ONLY_SECRET");
    expect(beta[1]!.history).toContain("BETA_ONLY_SECRET");
    expect(beta[1]!.history).not.toContain("ALPHA_ONLY_SECRET");
    expect(
      captures
        .filter((capture) => !capture.scope)
        .every((capture) => !capture.history.includes("ONLY_SECRET")),
    ).toBe(true);
    expect(await Bun.file(join(work, "shared-memory.txt")).text()).toBe(
      "both groups use this directory",
    );
    const artifact = {
      passed: true,
      nativeSdk: "Pi",
      sameDirectory: true,
      separateHistories: true,
      resumedIdentities: true,
      captures,
    };
    await Bun.write(join(directory, "result.json"), JSON.stringify(artifact));
    expect((await Bun.file(join(directory, "result.json")).json()).passed).toBe(true);
    if (Bun.env.MEMORY_SESSION_TEST_ARTIFACT)
      await Bun.write(Bun.env.MEMORY_SESSION_TEST_ARTIFACT, JSON.stringify(artifact, null, 2));
  } finally {
    await session?.dispose();
  }
});
