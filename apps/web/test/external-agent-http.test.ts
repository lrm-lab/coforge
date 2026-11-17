import { describe, expect, test } from "bun:test";
import {
  externalAgentFeature,
  externalAgentFeatures,
} from "#src/server/agents/external-agent-capabilities.server";
import { authenticateExternalAgentRequest } from "#src/server/agents/external-agent-http.server";
import { authenticateAppBotRequest } from "#src/server/app-bots/app-bot-agent-api.server";
import {
  mintExternalAgentCredential,
  generateExternalAgentKey,
} from "#src/server/agents/external-agent-credentials.server";
import { generateAgentApiKey } from "#src/server/agents/agent-api-key.server";
import { MemoryExternalAgentCredentials } from "./helpers/memory-external-agent-credentials";

const API = "/api/agent/v1";
const ID = "0d9f3a1c-0000-4000-8000-000000000000";

describe("what an external Agent key may call", () => {
  test.each<[string, string, string]>([
    ["POST", "/messages", "messages"],
    ["GET", "/messages", "messages"],
    ["GET", "/messages/search", "messages"],
    ["GET", `/messages/${ID}/resolve`, "messages"],
    ["GET", `/messages/${ID}/mention-deliveries`, "messages"],
    ["POST", `/messages/${ID}/reactions`, "messages"],
    ["DELETE", `/messages/${ID}/reactions`, "messages"],
    ["GET", "/threads", "threads"],
    ["POST", `/threads/${ID}/unfollow`, "threads"],
    ["POST", "/channels", "channels"],
    ["GET", "/channels/general", "channels"],
    ["PATCH", "/channels/general", "channels"],
    ["POST", "/channels/general/join", "channels"],
    ["GET", "/channels/general/members", "channels"],
    ["DELETE", "/channels/general/members", "channels"],
    ["POST", "/tasks", "tasks"],
    ["GET", "/tasks/view", "tasks"],
    ["POST", "/tasks/reply", "tasks"],
    ["POST", "/actions/prepare", "actions"],
    ["POST", "/attachments", "attachments"],
    ["GET", `/attachments/${ID}`, "attachments"],
    ["GET", `/attachments/${ID}/comments`, "attachments"],
    ["POST", "/attachment-upload-sessions", "attachment-upload-sessions"],
    ["POST", `/attachment-upload-sessions/${ID}/complete`, "attachment-upload-sessions"],
    ["POST", "/artifacts", "artifacts"],
    ["PUT", `/artifacts/uploads/${"a".repeat(64)}`, "artifacts"],
    ["GET", `/artifacts/${ID}/files/readme.md`, "artifacts"],
    ["GET", "/labels", "labels"],
    ["GET", "/users/alice", "users"],
    ["POST", "/profile", "profile"],
    ["GET", "/workspace", "workspace"],
    ["GET", "/manual/search", "manual"],
    ["GET", "/events", "events"],
    ["GET", "/events/", "events"],
    ["GET", "/inbox/conversations", "inbox"],
    ["GET", "/mention-actions/pending", "mention-actions"],
    ["POST", "/memory-dispositions", "memory-dispositions"],
    ["GET", "/apps", "apps"],
    ["GET", "/apps/marketplace", "apps"],
    ["POST", "/reminders", "reminders"],
    ["GET", "/context", "context"],
    ["POST", "/credentials/self/revoke", "credentials"],
    ["GET", "/wake-hints", "wake-hints"],
    ["GET", "/wake-hints/stream", "wake-hints"],
    ["GET", "/push-webhook", "push-webhook"],
    ["PUT", "/push-webhook", "push-webhook"],
    ["DELETE", "/push-webhook", "push-webhook"],
  ])("%s %s is covered by %s", (method, path, feature) => {
    expect(externalAgentFeature(method, `${API}${path}`)).toBe(feature);
  });

  test.each([
    ["POST", "/github-credentials"],
    ["POST", "/github-commit-trailers"],
    ["POST", "/openviking"],
    ["POST", "/weekly-reports"],
    ["POST", "/weekly-report-collect"],
    ["GET", `/apps/${ID}/config`],
    ["PATCH", `/apps/${ID}/config`],
    ["POST", `/apps/${ID}/token`],
    ["GET", "/apps/owned"],
    ["POST", "/apps/owned/key/rotate-secret"],
    ["GET", "/apps/registrations/status"],
    ["DELETE", "/messages"],
    ["PUT", "/messages"],
    ["POST", "/events"],
    ["GET", "/credentials/self/revoke"],
    ["GET", "/messages/a%2Fb/resolve"],
    ["GET", "/channels/a/b/c"],
    ["POST", "/wake-hints"],
    ["POST", "/push-webhook"],
    ["GET", "/wake-hints/other"],
    ["POST", "/new-route-nobody-listed"],
    ["GET", ""],
  ])("%s %s is refused", (method, path) => {
    expect(externalAgentFeature(method, `${API}${path}`)).toBeUndefined();
  });

  test("a path outside the Agent API is refused", () => {
    expect(externalAgentFeature("GET", "/api/other/messages")).toBeUndefined();
  });

  test("the feature list is sorted and has no duplicates", () => {
    const features = externalAgentFeatures();
    expect(features).toEqual([...new Set(features)].sort());
    expect(features).toContain("messages");
    expect(features).not.toContain("github-credentials");
  });
});

function request(path: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  return new Request(`https://example.test${API}${path}`, init);
}

async function externalFixture() {
  const repository = new MemoryExternalAgentCredentials();
  repository.addAgent("agent-1");
  const minted = await mintExternalAgentCredential({
    repository,
    agentId: "agent-1",
    workspaceId: "workspace-1",
    approvedByUserId: null,
    source: "device",
    machine: { machineName: "m", hostname: "h", os: "o", clientName: "c" },
  });
  if (!minted.ok) throw new Error("mint refused");
  return { repository, apiKey: minted.apiKey, credentialId: minted.credentialId };
}

describe("the external Agent door", () => {
  test("a valid key on a listed route yields the external principal", async () => {
    const { repository, apiKey, credentialId } = await externalFixture();
    const result = await authenticateExternalAgentRequest(
      request("/messages", { headers: { authorization: `Bearer ${apiKey}` } }),
      repository,
    );
    expect(result).toEqual({
      principal: {
        external: true,
        userId: "owner-1",
        workspaceId: "workspace-1",
        computerId: "",
        agentId: "agent-1",
        credentialId,
      },
    });
  });

  test("a key that does not hold is 401 invalid_credential", async () => {
    const { repository } = await externalFixture();
    for (const key of [generateExternalAgentKey(), "sk_ext_bad"]) {
      const result = await authenticateExternalAgentRequest(
        request("/messages", { headers: { authorization: `Bearer ${key}` } }),
        repository,
      );
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(401);
      expect(await (result as Response).json()).toMatchObject({ code: "invalid_credential" });
    }
  });

  test("an unlisted route is 403 unsupported_for_external_agents naming the route", async () => {
    const { repository, apiKey } = await externalFixture();
    const result = (await authenticateExternalAgentRequest(
      request("/github-credentials", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}` },
      }),
      repository,
    )) as Response;
    expect(result.status).toBe(403);
    expect(await result.json()).toEqual({
      error: "This operation is not available to external Agents",
      code: "unsupported_for_external_agents",
      feature: "github-credentials",
      retryable: false,
    });
  });

  test("a refused unlisted route is only reached after the key authenticated", async () => {
    const { repository } = await externalFixture();
    const result = (await authenticateExternalAgentRequest(
      request("/github-credentials", {
        method: "POST",
        headers: { authorization: `Bearer ${generateExternalAgentKey()}` },
      }),
      repository,
    )) as Response;
    expect(result.status).toBe(401);
  });

  test("a sk_agent_ bearer never reaches the external lookup", async () => {
    const lookups: string[] = [];
    const repository = {
      findByHash: async (hash: string) => {
        lookups.push(hash);
        return undefined;
      },
      touch: async () => {},
    };
    const result = await authenticateExternalAgentRequest(
      request("/messages", { headers: { authorization: `Bearer ${generateAgentApiKey()}` } }),
      repository,
    );
    expect(result).toBeUndefined();
    expect(lookups).toEqual([]);
  });

  test("a sk_ext_ bearer never reaches the bot lookup", async () => {
    const authenticated: string[] = [];
    const bots = {
      authenticate: async (key: string) => {
        authenticated.push(key);
        return undefined;
      },
    };
    const external = generateExternalAgentKey();
    const response = await authenticateAppBotRequest(
      request("/messages", { headers: { authorization: `Bearer ${external}` } }),
      bots,
    );
    expect(response).toBeUndefined();
    expect(authenticated).toEqual([]);
    await authenticateAppBotRequest(
      request("/messages", { headers: { authorization: `Bearer ${generateAgentApiKey()}` } }),
      bots,
    );
    expect(authenticated).toHaveLength(1);
  });

  test("a request carrying the Computer door's header, or no bearer, is not an external request", async () => {
    const { repository, apiKey } = await externalFixture();
    expect(
      await authenticateExternalAgentRequest(
        request("/messages", {
          headers: { authorization: `Bearer ${apiKey}`, "x-coforge-agent-api-key": "Bearer x" },
        }),
        repository,
      ),
    ).toBeUndefined();
    expect(
      await authenticateExternalAgentRequest(request("/messages"), repository),
    ).toBeUndefined();
  });
});
