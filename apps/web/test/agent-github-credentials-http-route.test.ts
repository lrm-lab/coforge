import { expect, test } from "bun:test";
import { AppError } from "#src/lib/app-error";
import { handleGitHubCredentialPost } from "#src/routes/api/agent/v1/github-credentials";

const principal = { userId: "user-1" };

const post = (body: string = "{}") =>
  new Request("https://server.example/api/agent/v1/github-credentials", { method: "POST", body });

/** A connection whose `credential()` answers with `answer` (or throws what it throws). */
const connection = (answer: () => Promise<unknown>) => ({
  credential: async (userId: string) => {
    expect(userId).toBe(principal.userId);
    return answer() as never;
  },
});

const credential = {
  username: "x-access-token",
  password: "short-lived-token",
  expiresAt: "2026-10-19T12:00:00.000Z",
};

test("a credential is answered as it was issued", async () => {
  const response = await handleGitHubCredentialPost(
    post(),
    principal,
    connection(async () => credential),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(credential);
});

test("a person whose GitHub needs reconnecting is refused with a code that says so and is not retried", async () => {
  const response = await handleGitHubCredentialPost(
    post(),
    principal,
    connection(async () => {
      throw new AppError("ACCESS_DENIED");
    }),
  );
  expect(response.status).toBe(403);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body).toMatchObject({ code: "GITHUB_RECONNECT_REQUIRED", retryable: false });
  expect(body.error).toContain("reconnect GitHub in Settings → Integrations");
});

test("a credential GitHub cannot issue right now is a retryable 503", async () => {
  const response = await handleGitHubCredentialPost(
    post(),
    principal,
    connection(async () => {
      throw new AppError("TEMPORARILY_UNAVAILABLE");
    }),
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    code: "TEMPORARILY_UNAVAILABLE",
    retryable: true,
  });
});

test("a body that is not an empty JSON object is a 400 and asks for no credential", async () => {
  for (const body of ["not json", "", '{"repository":"org/repo"}', "[]"]) {
    const response = await handleGitHubCredentialPost(
      post(body),
      principal,
      connection(async () => {
        throw new Error("no credential may be asked for");
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_INPUT", retryable: false });
  }
});

test("a server with no GitHub configured is a 503 that asking again cannot fix", async () => {
  const response = await handleGitHubCredentialPost(post(), principal, null);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    code: "TEMPORARILY_UNAVAILABLE",
    retryable: false,
  });
});

test("an unexpected failure is a retryable 503", async () => {
  const response = await handleGitHubCredentialPost(
    post(),
    principal,
    connection(async () => {
      throw new Error("something nobody expected");
    }),
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    code: "TEMPORARILY_UNAVAILABLE",
    retryable: true,
  });
});
