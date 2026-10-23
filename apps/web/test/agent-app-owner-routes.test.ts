import { expect, test } from "bun:test";

import type { AppAgentManagement } from "#src/server/apps/app-agent-management.server";
import { AppError } from "#src/lib/app-error";
import { handleAgentAppOwned } from "#src/routes/api/agent/v1/apps/owned/index";
import { handleAgentAppRotateSecret } from "#src/routes/api/agent/v1/apps/owned/$clientKey/rotate-secret";
import { handleAgentAppRegistrationStatus } from "#src/routes/api/agent/v1/apps/registrations/status";

const stub = (methods: Partial<AppAgentManagement>) => methods as AppAgentManagement;
const principal = { workspaceId: "ws", agentId: "agent" };
const request = (query: string) =>
  new Request(`https://coforge.example/api/agent/v1/apps/registrations/status?${query}`);

test("a rotation answers the secret with no-store, and a refusal names why", async () => {
  const ok = await handleAgentAppRotateSecret(
    new Request("https://coforge.example/x", { method: "POST" }),
    principal,
    "acme",
    stub({ rotateSecret: async () => ({ clientKey: "acme", clientSecret: "cfa_secret_x" }) }),
  );
  expect(await ok.json()).toEqual({ ok: true, clientKey: "acme", clientSecret: "cfa_secret_x" });
  expect(ok.headers.get("cache-control")).toBe("no-store");

  const missing = await handleAgentAppRotateSecret(
    new Request("https://coforge.example/x", { method: "POST" }),
    principal,
    "acme",
    stub({
      rotateSecret: async () => {
        throw new AppError("NOT_FOUND");
      },
    }),
  );
  expect(missing.status).toBe(404);
});

test("a status names exactly one of card and client", async () => {
  const owners = { status: async () => ({ status: "committed" as const, clientKey: "acme" }) };
  const ok = await handleAgentAppRegistrationStatus(request("client=acme"), principal, owners);
  expect(await ok.json()).toEqual({ ok: true, status: "committed", clientKey: "acme" });
  for (const query of ["", "card=a&client=b"]) {
    const bad = await handleAgentAppRegistrationStatus(request(query), principal, owners);
    expect(bad.status).toBe(400);
  }
});

test("the owned list answers cards and apps", async () => {
  const body = {
    pending: [{ cardMessageId: "m", name: "Acme", clientKey: null }],
    apps: [{ clientKey: "acme", name: "Acme", role: "owner" as const }],
  };
  const response = await handleAgentAppOwned(principal, { list: async () => body });
  expect(await response.json()).toEqual({ ok: true, ...body });
});
