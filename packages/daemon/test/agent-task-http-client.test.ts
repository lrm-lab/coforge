import { expect, test } from "bun:test";
import { AgentExplainedRefusalError } from "#src/connection/agent-explained-refusal-error";
import { AgentUpstreamRefusalError } from "#src/connection/agent-upstream-refusal-error";
import {
  createAgentTaskHttpClient,
  defaultAgentTaskHttpClient,
} from "#src/connection/agent-http-clients";
import { AGENT_RPC_TIMEOUT_MS } from "#src/connection/agent-http-wire";

const request = {
  idempotencyKey: "request-1",
  operation: "list",
  target: "#general",
} as const;

/** The deadline test's client gives up this soon, so it need not wait out production's. */
const TASK_DEADLINE_MS = 100;

test("Agent Task HTTP client rejects a response for a different request", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return Response.json({ idempotencyKey: "request-2", tasks: [] });
    },
  });
  try {
    await expect(
      defaultAgentTaskHttpClient.execute({
        url: `${server.url}api/agent/v1/tasks`,
        agentApiKey: "agent-key",
        daemonApiKey: "daemon-key",
        request,
      }),
    ).rejects.toThrow("Task response idempotency key does not match request");
  } finally {
    await server.stop();
  }
});

test("Agent Task HTTP client reports an authorization denial without treating it as transport", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return Response.json({ detail: "details must not be exposed" }, { status: 403 });
    },
  });
  try {
    await expect(
      defaultAgentTaskHttpClient.execute({
        url: `${server.url}api/agent/v1/tasks`,
        agentApiKey: "agent-key",
        daemonApiKey: "daemon-key",
        request,
      }),
    ).rejects.toThrow("server Agent Task request failed (403)");
  } finally {
    await server.stop();
  }
});

test(
  "Agent Task HTTP client abandons a server request at its deadline",
  async () => {
    // Production's client is built with this deadline.
    expect(AGENT_RPC_TIMEOUT_MS).toBe(10_000);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        return await new Promise<Response>(() => {});
      },
    });
    try {
      await expect(
        createAgentTaskHttpClient(TASK_DEADLINE_MS).execute({
          url: `${server.url}api/agent/v1/tasks`,
          agentApiKey: "agent-key",
          daemonApiKey: "daemon-key",
          request,
        }),
      ).rejects.toBeInstanceOf(Error);
    } finally {
      await server.stop(true);
    }
  },
  TASK_DEADLINE_MS + 1_000,
);

test("Agent Task HTTP client keeps the server's refusal code for the daemon log only", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      // Not the Agent API's refusal shape (no `error`, an extra field): an upstream's internals.
      return Response.json({ code: "ACCESS_DENIED", internal: "row 7" }, { status: 400 });
    },
  });
  try {
    const error = await defaultAgentTaskHttpClient
      .execute({
        url: `${server.url}api/agent/v1/tasks`,
        agentApiKey: "agent-key",
        daemonApiKey: "daemon-key",
        request,
      })
      .catch((thrown: unknown) => thrown);

    // The caller-facing message stays exactly what it was — a test above pins that an upstream's
    // details are not published — and the cause is carried alongside it for the log.
    expect(error).toBeInstanceOf(AgentUpstreamRefusalError);
    expect((error as AgentUpstreamRefusalError).message).toBe(
      "server Agent Task request failed (400)",
    );
    expect((error as AgentUpstreamRefusalError).upstreamCode).toBe("ACCESS_DENIED");
  } finally {
    await server.stop();
  }
});

test("Agent Task HTTP client relays a refusal the server wrote for the Agent", async () => {
  const reason = "With task conversations a task is made with `coforge task create --message-id`.";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return Response.json({ error: reason, code: "CONFLICT" }, { status: 409 });
    },
  });
  try {
    const error = await defaultAgentTaskHttpClient
      .execute({
        url: `${server.url}api/agent/v1/tasks`,
        agentApiKey: "agent-key",
        daemonApiKey: "daemon-key",
        request,
      })
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AgentExplainedRefusalError);
    expect(error).toMatchObject({ message: reason, status: 409, code: "CONFLICT" });
  } finally {
    await server.stop();
  }
});
