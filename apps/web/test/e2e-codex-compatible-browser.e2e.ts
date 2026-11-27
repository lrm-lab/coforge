import { expect, test } from "bun:test";
import { join } from "node:path";
import { verifyBlockedEgress } from "../../../scripts/e2e/codex-compatible-egress";
import { startResponsesFixture } from "../../../scripts/e2e/codex-compatible-responses";
import { browserSession, elementAtRest } from "./helpers/browser-e2e";
import {
  beginCodexReceipt,
  codexFixtureEnvironment as required,
  codexIsSignedOut,
} from "./helpers/codex-compatible-host";
import { codexCompatibleWeb, waitForFixtureReply } from "./helpers/codex-compatible-web";

async function enterSyntheticKey(browserPath: string, session: string, key: string) {
  const child = Bun.spawn([browserPath, "--session", session, "eval", "--stdin"], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
  child.stdin.write(`(() => {
    const input = document.querySelector('[role="dialog"] input[name="apiKey"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!(input instanceof HTMLInputElement) || !setter) throw new Error("API key field unavailable");
    setter.call(input, ${JSON.stringify(key)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  child.stdin.end();
  if ((await child.exited) !== 0)
    throw new Error("The browser did not accept the synthetic API key");
}

test("a real Computer accepts compatible Agent creation and API billing in the browser", async () => {
  if (process.platform !== "linux" || required("COFORGE_CODEX_E2E_DISPOSABLE") !== "1") {
    throw new Error("Run the browser acceptance on its disposable Linux Computer");
  }
  const { path: evidencePath, directory: evidenceDirectory } = await beginCodexReceipt("browser");
  const origin = new URL(required("COFORGE_CODEX_E2E_WEB_URL"));
  const currentId = required("COFORGE_CODEX_E2E_CURRENT_COMPUTER");
  const legacyId = required("COFORGE_CODEX_E2E_LEGACY_COMPUTER");
  const browserPath = Bun.which("agent-browser");
  if (!browserPath) throw new Error("agent-browser is required inside the disposable guest");
  const egress = await verifyBlockedEgress();
  const signedOut = await codexIsSignedOut();
  expect(signedOut).toBe(true);
  const web = codexCompatibleWeb(origin, "dev-user");
  expect(await web<boolean>("getComputerCodexCompatible", { computerId: currentId })).toBe(true);
  expect(await web<boolean>("getComputerCodexCompatible", { computerId: legacyId })).toBe(false);
  const session = `codex-live-${crypto.randomUUID()}`;
  const { browser, evaluate, waitFor } = browserSession(browserPath, session);
  const name = `codex-browser-${crypto.randomUUID().slice(0, 8)}`;
  const model = "gpt-5.4";
  const apiKey = `fixture-${crypto.randomUUID()}`;
  const trigger = `CODEX_TEST_REQUEST_${crypto.randomUUID()}`;
  const reply = `CODEX_E2E_${crypto.randomUUID()}`;
  const fixture = startResponsesFixture({
    apiKey,
    model,
    reply,
    sendReply: { target: "@dev-user", trigger },
  });
  let agentId: string | undefined;

  async function openComputerPicker() {
    await browser("find", "role", "button", "click", "--name", "Computer");
    await waitFor(`document.querySelector('[role="listbox"]') !== null`);
  }

  async function selectCodex() {
    const provider = `document.querySelector('[role="dialog"] input[name="provider"]')`;
    if (await evaluate<boolean>(`${provider}?.value === 'codex'`)) return;
    await browser("find", "role", "button", "click", "--name", "Runtime");
    await browser("click", '[role="listbox"] [data-key="codex"]');
    await waitFor(`${provider}?.value === 'codex'`);
  }

  try {
    await browser("set", "viewport", "1440", "900");
    await browser("open", new URL("/en/w/dev-user", origin).href);
    const expandSidebar = "document.querySelector('button[aria-label=\"Expand sidebar\"]')";
    if (await evaluate<boolean>(`Boolean(${expandSidebar})`)) {
      await waitFor(elementAtRest(expandSidebar));
      await browser("click", 'button[aria-label="Expand sidebar"]');
    }
    const newAgentMenu = "document.querySelector('button[aria-label=\"New\"]')";
    await waitFor(elementAtRest(newAgentMenu));
    await browser("click", 'button[aria-label="New"]');
    await browser("find", "role", "menuitem", "click", "--name", "New Agent", "--exact");
    await waitFor(`document.querySelector('[role="dialog"] input[name="name"]') !== null`);

    await openComputerPicker();
    await browser("click", `[role="listbox"] [data-key="${legacyId}"]`);
    await waitFor(`document.querySelector('[role="listbox"]') === null`);
    await selectCodex();
    const legacyOffersCompatible = await evaluate<boolean>(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      return [...(dialog?.querySelectorAll('button') ?? [])].some((button) =>
        button.textContent.trim() === 'Use API key',
      );
    })()`);
    expect(legacyOffersCompatible).toBe(false);

    await openComputerPicker();
    await browser("click", `[role="listbox"] [data-key="${currentId}"]`);
    await waitFor(`document.querySelector('[role="listbox"]') === null`);
    await selectCodex();
    await waitFor(
      `document.querySelector('[role="dialog"]')?.innerText.includes('Use API key') ?? false`,
    );
    await browser("find", "role", "button", "click", "--name", "Use API key", "--exact");
    await waitFor(`document.querySelector('[role="dialog"] input[name="baseUrl"]') !== null`);

    await openComputerPicker();
    const legacyStillSelectable = await evaluate<boolean>(`(() => {
      const option = document.querySelector(${JSON.stringify(`[role="listbox"] [data-key="${legacyId}"]`)});
      return Boolean(option && option.getAttribute('aria-disabled') !== 'true');
    })()`);
    await browser("press", "Escape");

    await browser("fill", '[role="dialog"] input[name="name"]', name);
    await browser("fill", '[role="dialog"] input[name="model"]', model);
    await browser("fill", '[role="dialog"] input[name="baseUrl"]', fixture.baseUrl.href);
    await enterSyntheticKey(browserPath, session, apiKey);
    await browser("click", '[role="dialog"] button[type="submit"]');
    await waitFor(`document.querySelector('[role="dialog"] input[name="baseUrl"]') === null`);

    type AgentList = { id: string; agents: { id: string; name: string }[] }[];
    const computers = await web<AgentList>("listComputers");
    agentId = computers
      .find(({ id }) => id === currentId)
      ?.agents.find((agent) => agent.name === name)?.id;
    if (!agentId) throw new Error("The browser did not create the Agent on the current Computer");
    const { conversationId } = await web<{ conversationId: string }>("openDirectConversation", {
      agentId,
    });
    await web("sendDirectConversationMessage", {
      conversationId,
      body: trigger,
      idempotencyKey: crypto.randomUUID(),
    });
    const published = await waitForFixtureReply(web, conversationId, reply);
    await browser("open", new URL(`/en/w/dev-user/dm/${conversationId}`, origin).href);
    const replyPresent = `(() => {
      const row = document.querySelector(${JSON.stringify(`[data-message-id="${published.id}"]`)});
      return Boolean(row?.querySelector('[data-message="other"]') &&
        row.textContent.includes(${JSON.stringify(reply)}));
    })()`;
    await waitFor(replyPresent);
    await browser("reload");
    await waitFor(replyPresent);

    await browser("open", new URL(`/en/w/dev-user/members?profile=agent:${agentId}`, origin).href);
    const billing = "Billed by your configured API provider. Check usage with that provider.";
    await waitFor(`document.body.innerText.includes(${JSON.stringify(billing)})`);
    await waitFor(elementAtRest("document.querySelector('button[aria-label^=\"Codex,\"]')"));
    await browser("click", 'button[aria-label^="Codex,"]');
    await waitFor(
      `[...document.querySelectorAll('[role="dialog"]')].some((d) => d.innerText.includes(${JSON.stringify(billing)}))`,
    );
    const subscriptionControls =
      await evaluate<boolean>(`[...document.querySelectorAll('[role="dialog"] button')]
      .some((button) => /refresh|reset/i.test(button.getAttribute('aria-label') || button.textContent || ''))`);
    expect(subscriptionControls).toBe(false);
    expect(await verifyBlockedEgress()).toEqual(egress);
    expect(
      fixture.requests.some(({ status, bearerMatched }) => status === 200 && bearerMatched),
    ).toBe(true);
    await browser("screenshot", join(evidenceDirectory, "codex-compatible-usage.png"));

    const evidence = JSON.stringify(
      {
        candidate: required("COFORGE_CODEX_E2E_CANDIDATE_SHA"),
        phases: {
          browser: {
            status: legacyStillSelectable ? "failed" : "passed",
            egress,
            signedOut,
            legacyOffersCompatible,
            legacyStillSelectable,
            replyAfterReload: true,
            apiProviderBilling: true,
            subscriptionControls,
            requests: fixture.requests,
          },
        },
      },
      null,
      2,
    );
    if (evidence.includes(apiKey)) throw new Error("Fixture rejected credential-bearing evidence");
    await Bun.write(evidencePath, `${evidence}\n`);
    expect(legacyStillSelectable).toBe(false);
  } finally {
    if (agentId)
      await web("executeAgentControl", {
        agentId,
        action: "stop",
        requestId: crypto.randomUUID(),
      }).catch(() => undefined);
    await browser("close").catch(() => undefined);
    await fixture.stop();
  }
}, 180_000);
