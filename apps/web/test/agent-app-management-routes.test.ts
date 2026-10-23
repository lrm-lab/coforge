import { expect, test } from "bun:test";

import type { AppAgentManagement } from "#src/server/apps/app-agent-management.server";
import { AppError } from "#src/lib/app-error";
import {
  handleAgentAppDelete,
  handleAgentAppUpdate,
} from "#src/routes/api/agent/v1/apps/owned/$clientKey/index";
import { handleAgentAppLogoSet } from "#src/routes/api/agent/v1/apps/owned/$clientKey/logo";
import { handleAgentAppPublishRequest } from "#src/routes/api/agent/v1/apps/owned/$clientKey/publish-request";
import { handleAgentAppShareLinkCreate } from "#src/routes/api/agent/v1/apps/owned/$clientKey/share-link";
import { handleAgentAppTransferOwner } from "#src/routes/api/agent/v1/apps/owned/$clientKey/transfer-owner";

const stub = (methods: Partial<AppAgentManagement>) => methods as AppAgentManagement;
const principal = { workspaceId: "ws", agentId: "agent" };
const json = (body: unknown, method: "POST" | "PATCH" | "PUT" = "POST") =>
  new Request("https://coforge.example/api/agent/v1/apps/owned/acme", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const bodiless = (method = "POST") =>
  new Request("https://coforge.example/api/agent/v1/apps/owned/acme", { method });
const summary = { clientKey: "acme" };

test("update decodes the changes and answers the app, never cached", async () => {
  const seen: unknown[] = [];
  const response = await handleAgentAppUpdate(
    json({ name: "X", scopes: [] }, "PATCH"),
    principal,
    "acme",
    stub({
      update: async (_caller, _key, changes) => {
        seen.push(changes);
        return summary as never;
      },
    }),
  );
  expect(await response.json()).toEqual({ ok: true, app: summary });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(seen).toEqual([{ name: "X", scopes: [] }]);
});

test("a body the contract refuses is request_invalid before the service runs", async () => {
  const never = async () => {
    throw new Error("should not run");
  };
  for (const body of [{}, { key: "other" }, { name: 1 }, [], "x"]) {
    const response = await handleAgentAppUpdate(
      json(body, "PATCH"),
      principal,
      "acme",
      stub({
        update: never,
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, errorCode: "request_invalid" });
  }
  const notJson = await handleAgentAppUpdate(
    new Request("https://coforge.example/x", { method: "PATCH", body: "{" }),
    principal,
    "acme",
    stub({ update: never }),
  );
  expect(notJson.status).toBe(400);
  const days = await handleAgentAppShareLinkCreate(
    json({ expiresDays: 366 }),
    principal,
    "acme",
    stub({
      createShareLink: never,
    }),
  );
  expect(days.status).toBe(400);
  const noTarget = await handleAgentAppTransferOwner(
    json({}),
    principal,
    "acme",
    stub({
      transferOwner: never,
    }),
  );
  expect(noTarget.status).toBe(400);
  const logo = await handleAgentAppLogoSet(
    json({ contentType: "image/png" }, "PUT"),
    principal,
    "acme",
    stub({
      setLogo: never,
    }),
  );
  expect(logo.status).toBe(400);
});

test("service refusals become the Agent app envelope", async () => {
  const refuse = (error: AppError) => async () => {
    throw error;
  };
  const cases: [AppError, number, string, RegExp?][] = [
    [new AppError("NOT_FOUND"), 404, "not_found"],
    [
      new AppError("CONFLICT", { errorId: "app-published-undeletable" }),
      409,
      "conflict",
      /request-unpublish/,
    ],
    [
      new AppError("INVALID_INPUT", { errorId: "app-redirect-uris-invalid" }),
      400,
      "invalid_input",
      /cannot be cleared/,
    ],
    [
      new AppError("ACCESS_DENIED", { errorId: "app-marketplace-off" }),
      403,
      "access_denied",
      /Marketplace/,
    ],
  ];
  for (const [error, status, errorCode, message] of cases) {
    const response = await handleAgentAppDelete(
      bodiless("DELETE"),
      principal,
      "acme",
      stub({
        delete: refuse(error),
      }),
    );
    expect(response.status).toBe(status);
    const body = (await response.json()) as { errorCode: string; error: string };
    expect(body.errorCode).toBe(errorCode);
    if (message) expect(body.error).toMatch(message);
  }
});

test("the share link URL is built from the public origin and a publish request answers its status", async () => {
  const origins: string[] = [];
  const link = await handleAgentAppShareLinkCreate(
    new Request("https://internal.example/x", {
      method: "POST",
      headers: { "x-forwarded-proto": "https", "x-forwarded-host": "coforge.example" },
      body: JSON.stringify({ expiresDays: 7 }),
    }),
    principal,
    "acme",
    stub({
      createShareLink: async (_caller, _key, options) => {
        origins.push(options.origin);
        return { clientKey: "acme", url: "u", createdAt: "a", expiresAt: "b" };
      },
    }),
  );
  expect(link.status).toBe(200);
  expect(origins).toEqual(["https://coforge.example"]);
  const publish = await handleAgentAppPublishRequest(
    bodiless(),
    principal,
    "acme",
    stub({
      requestPublish: async () => ({ clientKey: "acme", publishStatus: "publish_requested" }),
    }),
  );
  expect(await publish.json()).toEqual({
    ok: true,
    clientKey: "acme",
    publishStatus: "publish_requested",
  });
});
