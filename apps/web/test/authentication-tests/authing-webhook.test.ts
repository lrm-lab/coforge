import { afterEach, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "#src/generated/prisma/client";
import {
  applyAuthingWebhookEvent,
  authingWebhookHandler,
  readAuthingWebhookSecret,
  verifyAuthingWebhookSecret,
} from "#src/server/auth/authing-webhook.server";
import { UserIdentityRepository } from "#src/server/auth/user-identity.repository.server";

const SECRET = "test-webhook-secret";
const ENV_KEY = "COFORGE_AUTHING_WEBHOOK_SECRET";
const savedSecret = Bun.env[ENV_KEY];
const savedSecretFile = Bun.env[`${ENV_KEY}_FILE`];
const savedDatabaseUrl = Bun.env.DATABASE_URL;

afterEach(() => {
  if (savedSecret === undefined) delete Bun.env[ENV_KEY];
  else Bun.env[ENV_KEY] = savedSecret;
  if (savedSecretFile === undefined) delete Bun.env[`${ENV_KEY}_FILE`];
  else Bun.env[`${ENV_KEY}_FILE`] = savedSecretFile;
  if (savedDatabaseUrl === undefined) delete Bun.env.DATABASE_URL;
  else Bun.env.DATABASE_URL = savedDatabaseUrl;
});

describe("verifyAuthingWebhookSecret", () => {
  test("accepts the configured secret and rejects anything else", () => {
    expect(verifyAuthingWebhookSecret(SECRET, SECRET)).toBe(true);
    expect(verifyAuthingWebhookSecret(SECRET, null)).toBe(false);
    expect(verifyAuthingWebhookSecret(SECRET, "")).toBe(false);
    expect(verifyAuthingWebhookSecret(SECRET, "wrong-secret")).toBe(false);
    expect(verifyAuthingWebhookSecret(SECRET, `${SECRET}x`)).toBe(false);
  });
});

describe("readAuthingWebhookSecret", () => {
  test("reads the inline value, or nothing when unset", async () => {
    expect(await readAuthingWebhookSecret({})).toBeNull();
    expect(await readAuthingWebhookSecret({ [ENV_KEY]: "  s3cret  " })).toBe("s3cret");
  });

  test("refuses both forms set and an unreadable file", async () => {
    await expect(
      readAuthingWebhookSecret({ [ENV_KEY]: "a", [`${ENV_KEY}_FILE`]: "/tmp/x" }),
    ).rejects.toThrow();
    await expect(
      readAuthingWebhookSecret({ [`${ENV_KEY}_FILE`]: "/nonexistent/secret" }),
    ).rejects.toThrow();
  });

  test("an empty or blank secret file reads as unset, so the endpoint stays closed", async () => {
    const path = join(tmpdir(), `authing-webhook-secret-${crypto.randomUUID()}`);
    await writeFile(path, "  \n");
    try {
      expect(await readAuthingWebhookSecret({ [`${ENV_KEY}_FILE`]: path })).toBeNull();
    } finally {
      await rm(path, { force: true });
    }
  });
});

function webhookRequest(body: string, secret: string | null = SECRET) {
  return new Request("https://coforge.test/api/authing/webhook", {
    method: "POST",
    headers: secret === null ? {} : { "x-authing-webhook-secret": secret },
    body,
  });
}

describe("authingWebhookHandler", () => {
  test("answers 503 while the secret is unconfigured", async () => {
    delete Bun.env[ENV_KEY];
    delete Bun.env[`${ENV_KEY}_FILE`];
    const response = await authingWebhookHandler({ request: webhookRequest("{}") });
    expect(response.status).toBe(503);
  });

  test("answers 503 when the configured secret file does not exist", async () => {
    delete Bun.env[ENV_KEY];
    Bun.env[`${ENV_KEY}_FILE`] = "/nonexistent/coforge_authing_webhook_secret";
    const response = await authingWebhookHandler({ request: webhookRequest("{}") });
    expect(response.status).toBe(503);
  });

  test("answers 401 for a missing or wrong secret", async () => {
    Bun.env[ENV_KEY] = SECRET;
    expect((await authingWebhookHandler({ request: webhookRequest("{}", null) })).status).toBe(401);
    expect((await authingWebhookHandler({ request: webhookRequest("{}", "wrong") })).status).toBe(
      401,
    );
  });

  test("answers 200 for an irrelevant event without needing the database", async () => {
    Bun.env[ENV_KEY] = SECRET;
    Bun.env.DATABASE_URL = "postgresql://user:pass@127.0.0.1:1/none";
    const response = await authingWebhookHandler({
      request: webhookRequest(JSON.stringify({ eventName: "user:created", data: {} })),
    });
    expect(response.status).toBe(200);
  });

  test("answers 200 for a body that is not JSON", async () => {
    Bun.env[ENV_KEY] = SECRET;
    Bun.env.DATABASE_URL = "postgresql://user:pass@127.0.0.1:1/none";
    const response = await authingWebhookHandler({ request: webhookRequest("not json") });
    expect(response.status).toBe(200);
  });
});

describe("applyAuthingWebhookEvent", () => {
  const db = {} as PrismaClient;

  function identities() {
    const calls: [string, string][] = [];
    return {
      calls,
      repo: {
        markEmailVerified: async (provider: string, subject: string) => {
          calls.push([provider, subject]);
          return true;
        },
      } satisfies Pick<UserIdentityRepository, "markEmailVerified">,
    };
  }

  test("user:email-verified marks the Authing identity's user verified", async () => {
    const { calls, repo } = identities();
    for (const data of [
      { userId: "authing-sub-1" },
      { user: { userId: "authing-sub-2" } },
      { user: { id: "authing-sub-3" } },
      { id: "authing-sub-4" },
      { userId: 42 },
    ]) {
      await applyAuthingWebhookEvent(db, { eventName: "user:email-verified", data }, repo);
    }
    expect(calls).toEqual([
      ["authing", "authing-sub-1"],
      ["authing", "authing-sub-2"],
      ["authing", "authing-sub-3"],
      ["authing", "authing-sub-4"],
      ["authing", "42"],
    ]);
  });

  test("irrelevant and malformed events are ignored safely", async () => {
    const { calls, repo } = identities();
    const payloads: unknown[] = [
      null,
      "user:email-verified",
      {},
      { eventName: 7, data: { userId: "x" } },
      { eventName: "user:updated", data: { userId: "x" } },
      { eventName: "user:email-verified" },
      { eventName: "user:email-verified", data: null },
      { eventName: "user:email-verified", data: "authing-sub" },
      { eventName: "user:email-verified", data: {} },
      { eventName: "user:email-verified", data: { userId: "" } },
      { eventName: "user:email-verified", data: { userId: -3 } },
      { eventName: "user:email-verified", data: { user: { name: "no id" } } },
    ];
    for (const payload of payloads) {
      await applyAuthingWebhookEvent(db, payload, repo);
    }
    expect(calls).toEqual([]);
  });
});
