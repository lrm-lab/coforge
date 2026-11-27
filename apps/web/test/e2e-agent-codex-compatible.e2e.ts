import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { CODEX_COMPATIBLE_PROVIDER_CAPABILITY } from "@lrm/coforge-sdk/internal/codex-compatible-provider";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import { PrismaClient } from "#src/generated/prisma/client";
import { getCodexCompatibleCapabilityLease } from "#src/server/agents/codex-compatible-capability.server";
import { DEV_BROWSER_USER } from "#src/server/auth/dev-skip-auth.server";
import { getComputerStatusCache } from "#src/server/centrifugo/computer-status.server";
import { ownedWorkspaceCreateData } from "#src/server/db/repositories/workspace-slugs.repositories.server";
import {
  browserSession,
  elementAtRest,
  hydratedElement,
  localBrowserE2e,
  pageHydrated,
} from "./helpers/browser-e2e";

const { origin, browserPath, databaseUrl } = localBrowserE2e();
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const suffix = `${process.pid}-${Date.now().toString(36)}`;
const session = `codex-compat-${suffix}`;
const { browser, evaluate, waitFor } = browserSession(browserPath, session);

let workspaceId = "";
let workspaceSlug = "";
let computerId = "";
let legacyComputerId = "";

async function refreshLeaseAndPresence() {
  await getComputerStatusCache().put({ workspaceId, computerId }, true);
  if (legacyComputerId) {
    await getComputerStatusCache().put({ workspaceId, computerId: legacyComputerId }, true);
  }
  await getCodexCompatibleCapabilityLease().record(workspaceId, computerId, [
    CODEX_COMPATIBLE_PROVIDER_CAPABILITY,
  ]);
}

beforeAll(async () => {
  const workspace = await db.workspace.create({
    data: ownedWorkspaceCreateData({
      slug: `e2e-codex-${suffix}`,
      name: `Codex E2E ${suffix}`,
      userId: DEV_BROWSER_USER.id,
    }),
    select: { id: true, slug: true },
  });
  workspaceId = workspace.id;
  workspaceSlug = workspace.slug;

  const computer = await db.computer.create({
    data: {
      ownerId: DEV_BROWSER_USER.id,
      machineId: `codex-compat-${suffix}`,
      name: `codex-compat-${suffix}.local`,
      displayName: "Codex Relay Studio",
      kind: "local",
      runtimeAuth: {
        collectedAtMs: Date.now(),
        runtimes: {
          codex: { provider: "codex", state: "logged_out" },
        },
      },
      workspaces: { create: { workspaceId } },
      runtimes: {
        create: {
          workspaceId,
          provider: RUNTIME_PROVIDER.CODEX,
          version: "0.118.0",
          displayName: "Codex",
          isPublic: true,
        },
      },
    },
    select: { id: true },
  });
  computerId = computer.id;

  const legacyComputer = await db.computer.create({
    data: {
      ownerId: DEV_BROWSER_USER.id,
      machineId: `codex-legacy-${suffix}`,
      name: `codex-legacy-${suffix}.local`,
      displayName: "Legacy Codex Host",
      kind: "local",
      runtimeAuth: {
        collectedAtMs: Date.now(),
        runtimes: {
          codex: { provider: "codex", state: "logged_out" },
        },
      },
      workspaces: { create: { workspaceId } },
      runtimes: {
        create: {
          workspaceId,
          provider: RUNTIME_PROVIDER.CODEX,
          version: "0.118.0",
          displayName: "Codex",
          isPublic: true,
        },
      },
    },
    select: { id: true },
  });
  legacyComputerId = legacyComputer.id;
  await refreshLeaseAndPresence();
});

afterAll(async () => {
  await browser("close").catch(() => undefined);
  if (computerId && workspaceId) {
    await getComputerStatusCache()
      .put({ workspaceId, computerId }, false)
      .catch(() => undefined);
  }
  if (legacyComputerId && workspaceId) {
    await getComputerStatusCache()
      .put({ workspaceId, computerId: legacyComputerId }, false)
      .catch(() => undefined);
  }
  if (workspaceId) {
    await db.agent.deleteMany({ where: { workspaceId } }).catch(() => undefined);
    await db.computerRuntime.deleteMany({ where: { workspaceId } }).catch(() => undefined);
    await db.workspaceComputer.deleteMany({ where: { workspaceId } }).catch(() => undefined);
    await db.workspace.deleteMany({ where: { id: workspaceId } }).catch(() => undefined);
  }
  const computerIds = [computerId, legacyComputerId].filter(Boolean);
  if (computerIds.length > 0) {
    await db.computer.deleteMany({ where: { id: { in: computerIds } } }).catch(() => undefined);
  }
  await db.$disconnect();
});

test("codex custom API key flow works across create, profile usage, same-origin edit, and computer sign-in hints", async () => {
  const agentName = `codex-relay-${suffix}`;
  await browser("set", "viewport", "1440", "900");
  await browser("open", `${origin}/en/w/${workspaceSlug}`);
  await waitFor(`${pageHydrated} && document.querySelector('button[aria-label="New"]') !== null`);
  await refreshLeaseAndPresence();

  await browser("click", 'button[aria-label="New"]');
  await browser("find", "role", "menuitem", "click", "--name", "New Agent", "--exact");
  await waitFor(
    `document.querySelector('[role="dialog"]')?.innerText.includes("Use API key") ?? false`,
  );

  await browser("click", '[data-field="computerId"] button');
  await waitFor(
    `document.querySelector('[role="listbox"]')?.innerText.includes("Legacy Codex Host") ?? false`,
  );
  const beforeCompatibleOption = await evaluate<{ ariaDisabled: string | null }>(`(() => {
    const opt = [...document.querySelectorAll('[role="listbox"] [role="option"]')].find(
      (item) => (item.textContent ?? "").includes("Legacy Codex Host"),
    );
    return { ariaDisabled: opt?.getAttribute("aria-disabled") ?? null };
  })()`);
  expect(beforeCompatibleOption.ariaDisabled).not.toBe("true");
  await browser("press", "Escape");
  await waitFor(`document.querySelector('[role="listbox"]') === null`);

  await evaluate(`(() => {
    const button = [...document.querySelectorAll('[role="dialog"] button')].find(
      (b) => b.textContent.trim() === "Use API key",
    );
    button?.click();
    return Boolean(button);
  })()`);

  await waitFor(
    `document.querySelector('[role="dialog"] input[name="baseUrl"]') !== null && document.querySelector('[role="dialog"] input[name="apiKey"]') !== null && document.querySelector('[role="dialog"] input[name="model"]') !== null`,
  );

  await browser("click", '[data-field="computerId"] button');
  await waitFor(
    `document.querySelector('[role="listbox"]')?.innerText.includes("Legacy Codex Host") ?? false`,
  );
  await waitFor(
    `!(document.querySelector('[role="listbox"]')?.innerText ?? "").includes("Checking compatibility")`,
  );
  const compatibleOptions = await evaluate<{
    compatDisabled: string | null;
    legacyDisabled: string | null;
    legacyText: string;
  }>(`(() => {
    const options = [...document.querySelectorAll('[role="listbox"] [role="option"]')];
    const compat = options.find((item) => (item.textContent ?? "").includes("Codex Relay Studio"));
    const legacy = options.find((item) => (item.textContent ?? "").includes("Legacy Codex Host"));
    return {
      compatDisabled: compat?.getAttribute("aria-disabled") ?? null,
      legacyDisabled: legacy?.getAttribute("aria-disabled") ?? null,
      legacyText: (legacy?.textContent ?? "").trim(),
    };
  })()`);
  expect(compatibleOptions.compatDisabled).not.toBe("true");
  expect(compatibleOptions.legacyDisabled).toBe("true");
  expect(compatibleOptions.legacyText).toContain("API key not supported");

  await evaluate(`(() => {
    const legacy = [...document.querySelectorAll('[role="listbox"] [role="option"]')].find(
      (item) => (item.textContent ?? "").includes("Legacy Codex Host"),
    );
    legacy?.click();
    return Boolean(legacy);
  })()`);
  await browser("wait", "100");
  const afterDisabledClick = await evaluate<{ selectedComputer: string; hasBaseUrl: boolean }>(`({
    selectedComputer: document.querySelector('[data-field="computerId"] button')?.textContent?.trim() ?? "",
    hasBaseUrl: document.querySelector('[role="dialog"] input[name="baseUrl"]') !== null,
  })`);
  expect(afterDisabledClick.selectedComputer).toContain("Codex Relay Studio");
  expect(afterDisabledClick.hasBaseUrl).toBe(true);
  await browser("press", "Escape");
  await waitFor(`document.querySelector('[role="listbox"]') === null`);

  await browser("find", "role", "button", "click", "--name", "Custom API key (OpenAI-compatible)");
  await waitFor(
    `document.querySelector('[role="listbox"]')?.innerText.includes("ChatGPT account (Computer login)") ?? false`,
  );
  await browser("find", "role", "option", "click", "--name", "ChatGPT account (Computer login)");
  await waitFor(
    `document.querySelector('[role="listbox"]') === null && (document.querySelector('[role="dialog"]')?.innerText.includes("Use API key") ?? false)`,
  );

  await browser("click", '[data-field="computerId"] button');
  await waitFor(
    `document.querySelector('[role="listbox"]')?.innerText.includes("Legacy Codex Host") ?? false`,
  );
  const backToAccountOption = await evaluate<{ ariaDisabled: string | null }>(`(() => {
    const opt = [...document.querySelectorAll('[role="listbox"] [role="option"]')].find(
      (item) => (item.textContent ?? "").includes("Legacy Codex Host"),
    );
    return { ariaDisabled: opt?.getAttribute("aria-disabled") ?? null };
  })()`);
  expect(backToAccountOption.ariaDisabled).not.toBe("true");
  await browser("press", "Escape");
  await waitFor(`document.querySelector('[role="listbox"]') === null`);

  await evaluate(`(() => {
    const button = [...document.querySelectorAll('[role="dialog"] button')].find(
      (b) => b.textContent.trim() === "Use API key",
    );
    button?.click();
    return Boolean(button);
  })()`);
  await waitFor(
    `document.querySelector('[role="dialog"] input[name="baseUrl"]') !== null && document.querySelector('[role="dialog"] input[name="apiKey"]') !== null && document.querySelector('[role="dialog"] input[name="model"]') !== null`,
  );

  const afterUseKey = await evaluate<{ hasNotice: boolean; hasSearchModels: boolean }>(`({
    hasNotice: (document.querySelector('[role="dialog"]')?.innerText ?? "").includes("Use API key"),
    hasSearchModels: document.querySelector('[role="dialog"] input[placeholder="Search models"]') !== null,
  })`);
  expect(afterUseKey).toEqual({ hasNotice: false, hasSearchModels: false });

  await browser("fill", '[role="dialog"] input[name="baseUrl"]', "not-a-url");
  await browser("wait", "100");
  const beforeBlur = await evaluate<{ text: string; ariaInvalid: string | null }>(`({
    text: document.querySelector('[role="dialog"]')?.innerText ?? "",
    ariaInvalid: document.querySelector('[role="dialog"] input[name="baseUrl"]')?.getAttribute("aria-invalid") ?? null,
  })`);
  expect(beforeBlur.text).not.toContain("Enter a valid http:// or https:// base URL");
  expect(beforeBlur.ariaInvalid).not.toBe("true");

  await evaluate(`(document.querySelector('[role="dialog"] input[name="model"]')?.focus(), true)`);
  await waitFor(
    `document.querySelector('[role="dialog"]')?.innerText.includes("Enter a valid http:// or https:// base URL") ?? false`,
  );
  const afterBlur = await evaluate<{ ariaInvalid: string | null }>(`({
    ariaInvalid: document.querySelector('[role="dialog"] input[name="baseUrl"]')?.getAttribute("aria-invalid") ?? null,
  })`);
  expect(afterBlur.ariaInvalid).toBe("true");

  await browser("fill", '[role="dialog"] input[name="baseUrl"]', "https://relay.example.com/v1");
  await evaluate(`(document.querySelector('[role="dialog"] input[name="model"]')?.focus(), true)`);
  await waitFor(
    `!(document.querySelector('[role="dialog"]')?.innerText ?? "").includes("Enter a valid http:// or https:// base URL")`,
  );

  await browser("fill", '[role="dialog"] input[name="name"]', agentName);
  await browser("fill", '[role="dialog"] input[name="model"]', "gpt-5.4");
  await browser("fill", '[role="dialog"] input[name="apiKey"]', "sk-test-codex-compatible-123456");
  await browser("click", '[role="dialog"] button[type="submit"]');
  await waitFor(`document.querySelector('[role="dialog"] input[name="baseUrl"]') === null`);

  const created = await db.agent.findFirstOrThrow({
    where: { workspaceId, name: agentName },
    select: { id: true },
  });
  await db.agent.update({
    where: { id: created.id },
    data: { stoppedAt: new Date() },
  });

  await browser("open", `${origin}/en/w/${workspaceSlug}/members?profile=agent:${created.id}`);
  await waitFor(
    `${pageHydrated} && document.body.innerText.includes("https://relay.example.com/v1")`,
  );
  const profileText = await evaluate<string>(`document.body.innerText`);
  expect(profileText).toContain("Custom API key (OpenAI-compatible)");
  expect(profileText).toContain(
    "Billed by your configured API provider. Check usage with that provider.",
  );

  await waitFor(
    `(() => { const el = document.querySelector('button[aria-label^="Codex,"]'); return Boolean(el && ${hydratedElement("el")}); })()`,
  );
  await browser("click", 'button[aria-label^="Codex,"]');
  await waitFor(
    `[...document.querySelectorAll('[role="dialog"]')].some((d) => d.innerText.includes("Billed by your configured API provider"))`,
  );
  const popoverState = await evaluate<{ hasRefresh: boolean; hasReset: boolean }>(`(() => {
    const pop = [...document.querySelectorAll('[role="dialog"]')].find((d) =>
      d.innerText.includes("Billed by your configured API provider"),
    );
    const buttons = [...(pop?.querySelectorAll("button") ?? [])].map((b) =>
      (b.getAttribute("aria-label") || b.textContent || "").trim(),
    );
    return {
      hasRefresh: buttons.some((label) => /Refresh/i.test(label)),
      hasReset: buttons.some((label) => /reset/i.test(label)),
    };
  })()`);
  expect(popoverState).toEqual({ hasRefresh: false, hasReset: false });

  await browser("press", "Escape");
  await waitFor(`document.querySelector('[role="dialog"]') === null`);
  await browser("click", 'button[aria-label="Edit runtime configuration"]');
  await waitFor(
    `document.querySelector('[role="dialog"] form input[name="baseUrl"]')?.value === "https://relay.example.com/v1" && (document.querySelector('[role="dialog"]')?.innerText.includes("Custom API key (OpenAI-compatible)") ?? false)`,
  );

  const editInitial = await evaluate<{
    saveDisabled: boolean;
    apiKeyRequired: boolean;
    modelValue: string;
    dialogText: string;
  }>(`({
    saveDisabled: Boolean(document.querySelector('[role="dialog"] button[type="submit"]')?.disabled),
    apiKeyRequired: Boolean(document.querySelector('[role="dialog"] input[name="apiKey"]')?.required),
    modelValue: document.querySelector('[role="dialog"] input[name="model"]')?.value ?? "",
    dialogText: document.querySelector('[role="dialog"]')?.innerText ?? "",
  })`);
  expect(editInitial.saveDisabled).toBe(true);
  expect(editInitial.apiKeyRequired).toBe(false);
  expect(editInitial.modelValue).toBe("gpt-5.4");
  expect(editInitial.dialogText).toContain("Leave blank to keep the existing key");

  await browser("fill", '[role="dialog"] input[name="baseUrl"]', "https://relay.example.com/v2");
  await waitFor(
    `document.querySelector('[role="dialog"] button[type="submit"]')?.disabled === false`,
  );
  expect(
    await evaluate<boolean>(
      `Boolean(document.querySelector('[role="dialog"] input[name="apiKey"]')?.required)`,
    ),
  ).toBe(false);

  await refreshLeaseAndPresence();
  await waitFor(elementAtRest(`document.querySelector('[role="dialog"] button[type="submit"]')`));
  await browser("click", '[role="dialog"] button[type="submit"]');
  await waitFor(`document.querySelector('[role="dialog"]') === null`);
  await waitFor(`document.body.innerText.includes("https://relay.example.com/v2")`);
  const updated = await db.agent.findUniqueOrThrow({
    where: { id: created.id },
    select: { runtimeConfig: true },
  });
  expect((updated.runtimeConfig as { provider?: { baseUrl?: string } }).provider?.baseUrl).toBe(
    "https://relay.example.com/v2",
  );

  await browser("click", 'button[aria-label="Edit runtime configuration"]');
  await waitFor(
    `document.querySelector('[role="dialog"] form input[name="baseUrl"]')?.value === "https://relay.example.com/v2"`,
  );
  await browser(
    "fill",
    '[role="dialog"] input[name="baseUrl"]',
    "https://other-relay.example.com/v1",
  );
  await waitFor(
    `document.querySelector('[role="dialog"] input[name="apiKey"]')?.required === true`,
  );
  expect(
    await evaluate<string>(`document.querySelector('[role="dialog"]')?.innerText ?? ""`),
  ).toContain("Changing the host, scheme, or port requires re-entering the API key");
  await browser("press", "Escape");

  await refreshLeaseAndPresence();
  await browser("open", `${origin}/en/w/${workspaceSlug}/computer/${computerId}`);
  await waitFor(
    `${pageHydrated} && (() => { const el = document.querySelector('li button[aria-label^="Codex"]'); return Boolean(el && ${hydratedElement("el")}); })()`,
  );
  await browser("click", 'li button[aria-label^="Codex"]');
  await waitFor(`document.body.innerText.includes("configure a custom API key on each Agent")`);
  await browser("find", "role", "button", "click", "--name", "Sign in");
  await waitFor(
    `document.querySelector('[role="dialog"]')?.innerText.includes("No sign-in is needed here") ?? false`,
  );
}, 180_000);
