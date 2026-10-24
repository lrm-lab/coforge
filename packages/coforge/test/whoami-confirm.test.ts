import { expect, test } from "bun:test";
import { run } from "../index";
import { CliError } from "#src/cli-error";

const KEYS = ["COFORGE_CURRENT_AGENT_ID", "COFORGE_CURRENT_AGENT_NAME"] as const;

async function withAgent<T>(id: string | undefined, body: () => Promise<T>): Promise<T> {
  const previous = KEYS.map((key) => Bun.env[key]);
  if (id === undefined) delete Bun.env.COFORGE_CURRENT_AGENT_ID;
  else Bun.env.COFORGE_CURRENT_AGENT_ID = id;
  Bun.env.COFORGE_CURRENT_AGENT_NAME = "scout";
  try {
    return await body();
  } finally {
    KEYS.forEach((key, index) => {
      if (previous[index] === undefined) delete Bun.env[key];
      else Bun.env[key] = previous[index];
    });
  }
}

const profile = (id: string) => ({
  ok: true as const,
  profile: {
    kind: "agent" as const,
    id,
    name: "scout",
    displayName: "Scout",
    description: "",
    role: "admin",
    isSelf: true,
    runtime: "codex",
    model: "m",
    status: "online" as const,
    creator: null,
  },
});

const transport = (profileShow?: () => Promise<ReturnType<typeof profile>>) => ({
  check: async () => ({ messages: [] }),
  read: async () => undefined,
  send: async () => undefined,
  view: async () => ({ bytes: new Uint8Array() }),
  ...(profileShow ? { profileShow } : {}),
});

test("whoami reports the identity the server confirms for the credential", async () => {
  const output = await withAgent("agent-1", () =>
    run(
      ["whoami"],
      transport(async () => profile("agent-1")),
    ),
  );
  expect(output).toContain("Agent ID: agent-1");
  expect(output).toContain("Server: confirmed @scout (admin)");
});

test("whoami --json carries serverConfirmed and the confirmed agent", async () => {
  const output = await withAgent("agent-1", () =>
    run(
      ["whoami", "--json"],
      transport(async () => profile("agent-1")),
    ),
  );
  const data = JSON.parse(output as string).data;
  expect(data.serverConfirmed).toBe(true);
  expect(data.server.agent).toEqual({
    id: "agent-1",
    name: "scout",
    displayName: "Scout",
    role: "admin",
  });
});

test("a server that names another Agent is an IDENTITY_MISMATCH", async () => {
  const failure = withAgent("agent-1", () =>
    run(
      ["whoami"],
      transport(async () => profile("agent-2")),
    ),
  );
  await expect(failure).rejects.toMatchObject({
    code: "IDENTITY_MISMATCH",
    message:
      "The server says this credential belongs to agent agent-2, not the locally configured agent-1.",
  });
});

const UNREACHABLE = "agent proxy request failed (network or timeout)";

async function failure(args: string[], profileShow: Parameters<typeof transport>[0]) {
  return withAgent("agent-1", () => run(args, transport(profileShow))).then(
    () => {
      throw new Error("whoami should have failed");
    },
    (error: unknown) => error as CliError,
  );
}

test("an unreachable server prints the local context, marks it unconfirmed, and fails", async () => {
  const error = await failure(["whoami"], async () => {
    throw new Error(UNREACHABLE);
  });
  expect(error.code).toBe("WHOAMI_FAILED");
  expect(error.message).toBe(
    `Could not confirm identity with the server: ${UNREACHABLE}. Any local context printed is unconfirmed.`,
  );
  expect(error.stdoutText).toContain("Agent ID: agent-1");
  expect(error.stdoutText).toContain("Server: unconfirmed");
  expect(error.exitCode).toBeUndefined();
});

test("--json prints { ok: false } with the local context before failing", async () => {
  const error = await failure(["whoami", "--json"], async () => {
    throw new Error(UNREACHABLE);
  });
  const printed = JSON.parse(error.stdoutText as string);
  expect(printed.ok).toBe(false);
  expect(printed.data.agentId).toBe("agent-1");
  expect(printed.data.serverConfirmed).toBe(false);
});

test("a refusal from the server keeps its code", async () => {
  const error = await failure(["whoami", "--json"], async () => {
    throw new CliError({ code: "UNAUTHORIZED", message: "credential rejected", retryable: false });
  });
  expect(error.code).toBe("UNAUTHORIZED");
  expect(JSON.parse(error.stdoutText as string).data.serverErrorCode).toBe("UNAUTHORIZED");
});

test("with no Agent id in the environment the server's answer is taken as is", async () => {
  const output = await withAgent(undefined, () =>
    run(
      ["whoami"],
      transport(async () => profile("agent-9")),
    ),
  );
  expect(output).toContain("Server: confirmed @scout");
});

test("a transport without profile show prints the local context alone", async () => {
  const output = await withAgent("agent-1", () => run(["whoami"], transport()));
  expect(output).not.toContain("Server:");
});
