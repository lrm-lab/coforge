import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { verifyBlockedEgress } from "../../../scripts/e2e/codex-compatible-egress";
import { startResponsesFixture } from "../../../scripts/e2e/codex-compatible-responses";
import {
  beginCodexReceipt,
  codexFixtureEnvironment as required,
  codexIsSignedOut,
  codexThreadOpens,
  codexThreads,
  isolatedHomeDirectory,
  withPoisonedCodexHost,
} from "./helpers/codex-compatible-host";
import { codexCompatibleWeb, waitForFixtureReply } from "./helpers/codex-compatible-web";

type Computer = {
  id: string;
  online: boolean;
  runtimes: { provider: string }[];
};

async function waitFor<T>(name: string, read: () => Promise<T | undefined | false>) {
  const stopAt = performance.now() + 90_000;
  while (performance.now() < stopAt) {
    const value = await read();
    if (value) return value;
    await Bun.sleep(300);
  }
  throw new Error(`Did not observe ${name}`);
}

test("a clean installed Computer routes a Codex Agent to its own compatible endpoint", async () => {
  if (process.platform !== "linux" || required("COFORGE_CODEX_E2E_DISPOSABLE") !== "1") {
    throw new Error("Run the native acceptance on its disposable Linux Computer");
  }
  const { path: evidencePath } = await beginCodexReceipt("backend");
  const codexHome = await isolatedHomeDirectory(required("CODEX_HOME"));
  const probeDir = await isolatedHomeDirectory(required("COFORGE_CODEX_E2E_PROBE_DIR"));
  const origin = new URL(required("COFORGE_CODEX_E2E_WEB_URL"));
  const currentId = required("COFORGE_CODEX_E2E_CURRENT_COMPUTER");
  const legacyId = required("COFORGE_CODEX_E2E_LEGACY_COMPUTER");
  const candidate = required("COFORGE_CODEX_E2E_CANDIDATE_SHA");
  const legacy = required("COFORGE_CODEX_E2E_LEGACY_SHA");
  const codexVersion = required("COFORGE_CODEX_E2E_CODEX_VERSION");
  if (currentId === legacyId) throw new Error("Two registered Computers are required");
  const cleanEnvironment = [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "COFORGE_CODEX_COMPATIBLE_API_KEY",
  ].every((name) => Bun.env[name] === undefined);
  const authFileAbsent = !(await Bun.file(resolve(codexHome, "auth.json")).exists());
  const signedOut = await codexIsSignedOut();
  expect(cleanEnvironment && authFileAbsent).toBe(true);
  expect(signedOut).toBe(true);
  const egress = await verifyBlockedEgress();
  const web = codexCompatibleWeb(origin, "dev-user");
  const model = "gpt-5.4";
  const apiKey = `fixture-${crypto.randomUUID()}`;
  const wrongKey = `fixture-${crypto.randomUUID()}`;
  await Bun.write(
    resolve(probeDir, "expected.sha256"),
    new Bun.CryptoHasher("sha256").update(apiKey).digest("hex"),
  );
  const fixture = startResponsesFixture({ apiKey, model, reply: "Fixture ready" });
  const rejectionFixture = startResponsesFixture({
    apiKey,
    model,
    reply: "Unexpected test response",
  });
  const agentIds: string[] = [];
  const readLaunches = async () => {
    const launchLog = Bun.file(resolve(probeDir, "launch.jsonl"));
    return ((await launchLog.exists()) ? await launchLog.text() : "")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };
  const initialLaunchCount = (await readLaunches()).length;

  async function createAgent(input: Record<string, unknown>) {
    const { agent } = await web<{ agent: { id: string } }>("createAgent", input);
    agentIds.push(agent.id);
    const { conversationId } = await web<{ conversationId: string }>("openDirectConversation", {
      agentId: agent.id,
    });
    return { agentId: agent.id, conversationId };
  }

  async function sendTurn(conversationId: string, body: string) {
    await web("sendDirectConversationMessage", {
      conversationId,
      body,
      idempotencyKey: crypto.randomUUID(),
    });
  }

  const control = (agentId: string, action: "start" | "stop" | "restart") =>
    web("executeAgentControl", { agentId, action, requestId: crypto.randomUUID() });

  async function observeCompatibleTurn(agentId: string, conversationId: string) {
    const reply = `CODEX_E2E_${crypto.randomUUID()}`;
    const trigger = `CODEX_TEST_REQUEST_${crypto.randomUUID()}`;
    const offset = fixture.requests.length;
    fixture.prepareReply({ reply, sendReply: { target: "@dev-user", trigger } });
    await sendTurn(conversationId, trigger);
    const message = await waitForFixtureReply(web, conversationId, reply);
    const session = await waitFor(
      "the real Codex session",
      async () => (await codexThreads(codexHome, agentId, "coforge-openai-compatible", reply))[0],
    );
    const requests = fixture.requests.slice(offset);
    expect(requests.some(({ status }) => status === 200)).toBe(true);
    expect(requests.every(({ bearerMatched }) => bearerMatched)).toBe(true);
    return { session, replyId: message.id, requests };
  }

  async function startDefaultSession(agentId: string) {
    const provider = "coforge-e2e-default";
    const previous = new Set(await codexThreads(codexHome, agentId, provider));
    await web("updateAgent", { agentId, provider: "codex" });
    await control(agentId, "start");
    return waitFor("a new default-mode Codex session", async () =>
      (await codexThreads(codexHome, agentId, provider)).find((id) => !previous.has(id)),
    );
  }

  try {
    await waitFor("both registered Computers online with Codex", async () => {
      const computers = await web<Computer[]>("listComputers");
      return [currentId, legacyId].every((id) =>
        computers.some(
          (computer) =>
            computer.id === id &&
            computer.online &&
            computer.runtimes.some(({ provider }) => provider === "codex"),
        ),
      );
    });
    await waitFor("compatible capability", () =>
      web<boolean>("getComputerCodexCompatible", { computerId: currentId }),
    );
    expect(await web<boolean>("getComputerCodexCompatible", { computerId: legacyId })).toBe(false);
    const name = `codex-e2e-${crypto.randomUUID().slice(0, 8)}`;
    const input = {
      name,
      provider: "codex",
      modelProvider: "openai-compatible",
      model,
      baseUrl: fixture.baseUrl.href,
    };
    await expect(web("createAgent", { ...input, computerId: legacyId, apiKey })).rejects.toThrow(
      "refused createAgent",
    );
    await expect(web("createAgent", { ...input, computerId: currentId })).rejects.toThrow(
      "refused createAgent",
    );
    expect(fixture.requests).toHaveLength(0);
    const { agentId, conversationId } = await createAgent({
      ...input,
      computerId: currentId,
      apiKey,
    });
    const cleanTurn = await observeCompatibleTurn(agentId, conversationId);
    const launches = (await readLaunches()).slice(initialLaunchCount);
    const expectedLaunch = {
      standardKeyAbsent: true,
      standardUrlAbsent: true,
      providerKeyMatched: true,
    };
    expect(launches).toContainEqual(expectedLaunch);
    const usage = await web<object>("readAgentUsage", { agentId });
    expect(usage).toEqual({
      state: "fresh",
      billing: "provider-api-key",
      target: { computerId: currentId, runtimeConfigRevision: expect.any(Number) },
    });

    const rejection = await createAgent({
      ...input,
      name: `wrong-${name}`,
      computerId: currentId,
      apiKey: wrongKey,
      baseUrl: rejectionFixture.baseUrl.href,
    });
    await sendTurn(rejection.conversationId, "Wrong credential control");
    await waitFor("the provider's credential refusal", async () =>
      rejectionFixture.requests.some(({ status }) => status === 401),
    );
    expect(rejectionFixture.requests.every(({ bearerMatched }) => !bearerMatched)).toBe(true);
    await control(rejection.agentId, "stop");
    await control(agentId, "stop");
    const prePoisonLaunchCount = (await readLaunches()).length;

    const switchReceipt = await withPoisonedCodexHost({
      codexHome,
      defaultBaseUrl: rejectionFixture.baseUrl,
      model,
      async run() {
        await waitFor("current Computer after host restart", () =>
          web<boolean>("getComputerCodexCompatible", { computerId: currentId }),
        );
        const mode = { agentId, provider: "codex" };
        const defaultSession = await startDefaultSession(agentId);
        await control(agentId, "stop");
        await web("updateAgent", {
          ...mode,
          model,
          modelProvider: "openai-compatible",
          apiKey,
          baseUrl: fixture.baseUrl.href,
        });
        await control(agentId, "start");
        const firstCompatible = await observeCompatibleTurn(agentId, conversationId);
        const previousRuntimes = new Set(
          (await codexThreadOpens(agentId)).map(({ runtimeId }) => runtimeId),
        );
        await control(agentId, "restart");
        const resumed = await waitFor("the Codex thread opened by same-mode restart", async () =>
          (await codexThreadOpens(agentId)).find(
            ({ runtimeId }) => !previousRuntimes.has(runtimeId),
          ),
        );
        await control(agentId, "stop");
        const backToDefault = await startDefaultSession(agentId);
        expect(firstCompatible.session).not.toBe(defaultSession);
        expect(firstCompatible.session).not.toBe(cleanTurn.session);
        expect(resumed.method).toBe("thread/resume");
        expect(resumed.threadId).toBe(firstCompatible.session);
        expect(backToDefault).not.toBe(resumed.threadId);
        const poisonedLaunches = (await readLaunches()).slice(prePoisonLaunchCount);
        expect(poisonedLaunches).toContainEqual(expectedLaunch);
        return {
          launch: expectedLaunch,
          changedToCompatible: true,
          retainedCompatible: true,
          changedToDefault: true,
          requestTraceIds: firstCompatible.requests.map(({ traceId }) => traceId),
        };
      },
    });
    expect(await verifyBlockedEgress()).toEqual(egress);
    const evidence = JSON.stringify(
      {
        candidate,
        legacy,
        codexVersion,
        phases: {
          backend: {
            status: "passed",
            cleanEnvironment,
            authFileAbsent,
            signedOut,
            egress,
            legacyCapability: false,
            legacyCreateRefused: true,
            missingKeyRefused: true,
            refusedCreatesMadeNoRequests: true,
            launch: expectedLaunch,
            publishedReplyId: cleanTurn.replyId,
            requests: [...fixture.requests, ...rejectionFixture.requests],
            wrongKeyRefused: true,
            switchReceipt,
            billing: "provider-api-key",
          },
          browser: { status: "pending" },
        },
      },
      null,
      2,
    );
    if ([apiKey, wrongKey].some((key) => evidence.includes(key))) {
      throw new Error("Fixture rejected credential-bearing evidence");
    }
    await Bun.write(evidencePath, `${evidence}\n`);
  } catch (error) {
    const evidence = JSON.stringify(
      {
        candidate,
        legacy,
        codexVersion,
        phases: {
          backend: {
            status: "failed",
            egress,
            cleanEnvironment,
            authFileAbsent,
            signedOut,
            compatibleRequests: fixture.requests,
            wrongKeyRequests: rejectionFixture.requests,
          },
          browser: { status: "pending" },
        },
      },
      null,
      2,
    );
    await Bun.write(evidencePath, `${evidence}\n`);
    throw error;
  } finally {
    await Promise.allSettled(agentIds.map((agentId) => control(agentId, "stop")));
    await Promise.all([fixture.stop(), rejectionFixture.stop()]);
  }
}, 480_000);
