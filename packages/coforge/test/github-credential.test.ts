import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { GitHubCredentialResponse } from "@lrm/coforge-sdk/agent";
import { CliError } from "#src/cli-error";
import { runGitHubCli, runGitHubCredentialHelper } from "#src/github-credential";

const scratchRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("gets the current user credential for a valid HTTPS GitHub path", async () => {
  let lookups = 0;
  const output = await runGitHubCredentialHelper(
    "get",
    "protocol=https\nhost=github.com\npath=Example-Org/private-repo.git\n\n",
    async () => {
      lookups++;
      return {
        username: "x-access-token",
        password: "short-lived-token",
        expiresAt: "2026-09-16T21:00:00Z",
      };
    },
  );

  expect(lookups).toBe(1);
  expect(output).toBe("username=x-access-token\npassword=short-lived-token\n\n");
});

test("does not answer credentials for another host or protocol", async () => {
  let calls = 0;
  const lookup = async () => {
    calls++;
    throw new Error("must not request a credential");
  };

  expect(
    await runGitHubCredentialHelper(
      "get",
      "protocol=https\nhost=gitlab.com\npath=org/repo\n\n",
      lookup,
    ),
  ).toBe("");
  expect(
    await runGitHubCredentialHelper(
      "get",
      "protocol=ssh\nhost=github.com\npath=org/repo\n\n",
      lookup,
    ),
  ).toBe("");
  expect(calls).toBe(0);
});

test("rejects an unscoped GitHub credential request", async () => {
  await expect(
    runGitHubCredentialHelper(
      "get",
      "protocol=https\nhost=github.com\npath=private-repo\n\n",
      async () => {
        throw new Error("must not request a credential");
      },
    ),
  ).rejects.toThrow("GitHub credential repository is invalid");
});

test("does not persist or erase short-lived credentials", async () => {
  const lookup = async () => {
    throw new Error("must not request a credential");
  };
  expect(await runGitHubCredentialHelper("store", "password=secret\n\n", lookup)).toBe("");
  expect(await runGitHubCredentialHelper("erase", "password=secret\n\n", lookup)).toBe("");
});

test("runs the real GitHub CLI with a fresh token without recursing into the wrapper", async () => {
  const root = await mkdtemp(join(tmpdir(), "coforge-gh-"));
  scratchRoots.push(root);
  const wrapperDirectory = join(root, "wrapper");
  const hostDirectory = join(root, "host");
  const output = join(root, "output");
  await Bun.write(join(wrapperDirectory, "gh"), "#!/bin/sh\nexit 99\n");
  await Bun.write(
    join(hostDirectory, "gh"),
    '#!/bin/sh\nprintf "%s\\n" "$GH_TOKEN" "$@" > "$GH_TEST_OUTPUT"\n',
  );
  await Promise.all([
    chmod(join(wrapperDirectory, "gh"), 0o700),
    chmod(join(hostDirectory, "gh"), 0o700),
  ]);

  const environment = {
    PATH: `${wrapperDirectory}:${hostDirectory}`,
    GH_TEST_OUTPUT: output,
  };
  expect(
    await runGitHubCli(
      ["pr", "view", "17"],
      async () => ({
        username: "x-access-token",
        password: "short-lived-token",
        expiresAt: "2026-09-16T21:00:00Z",
      }),
      environment,
      join(wrapperDirectory, "coforge-computer"),
    ),
  ).toBe(0);
  expect(await readFile(output, "utf8")).toBe("short-lived-token\npr\nview\n17\n");
  expect(environment).not.toHaveProperty("GH_TOKEN");
});

test("does not request a token when the host GitHub CLI is unavailable", async () => {
  let lookups = 0;
  await expect(
    runGitHubCli(
      ["repo", "view"],
      async () => {
        lookups++;
        throw new Error("must not request a credential");
      },
      { PATH: "" },
      "/coforge/coforge-computer",
    ),
  ).rejects.toThrow("GitHub CLI is not installed");
  expect(lookups).toBe(0);
});

const GET_REPO = "protocol=https\nhost=github.com\npath=org/repo.git\n\n";
const CREDENTIAL: GitHubCredentialResponse = {
  username: "x-access-token",
  password: "short-lived-token",
  expiresAt: "2026-09-16T21:00:00Z",
};
/** What the CLI receives for the cloud's retryable 503: the daemon relays its status with a public
 * line, the CLI names any upstream 5xx `SERVER_5XX` and marks this idempotent lookup's retryable. */
const unavailable = () =>
  new CliError({
    code: "SERVER_5XX",
    message: "the server is temporarily unavailable; retry",
    retryable: true,
    correlationId: "corr-unavailable",
    proxy: { failureClass: "upstream_http_response", upstreamStatus: 503 },
  });

test("a credential the cloud cannot issue right now is asked for again after a short wait", async () => {
  const waits: number[] = [];
  let lookups = 0;
  const output = await runGitHubCredentialHelper(
    "get",
    GET_REPO,
    async () => {
      lookups++;
      if (lookups < 3) throw unavailable();
      return CREDENTIAL;
    },
    { sleep: async (ms) => void waits.push(ms) },
  );

  expect(output).toBe("username=x-access-token\npassword=short-lived-token\n\n");
  expect(lookups).toBe(3);
  expect(waits).toEqual([500, 1500]);
});

test("a refused credential is not asked for again", async () => {
  const refusal = new CliError({
    code: "GITHUB_RECONNECT_REQUIRED",
    message:
      "GitHub is not connected for this Agent's owner, or its authorization expired; " +
      "the owner must reconnect GitHub in Settings → Integrations",
    retryable: false,
    proxy: { failureClass: "upstream_refusal", upstreamStatus: 403 },
  });
  let lookups = 0;
  const failure = await runGitHubCredentialHelper(
    "get",
    GET_REPO,
    async () => {
      lookups++;
      throw refusal;
    },
    { sleep: async () => {} },
  ).catch((error: unknown) => error);

  expect(failure).toBe(refusal);
  expect(lookups).toBe(1);
});

test("a credential that stays unavailable fails with the last answer after three tries", async () => {
  let lookups = 0;
  const failure = await runGitHubCredentialHelper(
    "get",
    GET_REPO,
    async () => {
      lookups++;
      throw unavailable();
    },
    { sleep: async () => {} },
  ).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(CliError);
  expect(failure).toMatchObject({ code: "SERVER_5XX", retryable: true });
  expect(lookups).toBe(3);
});

test("a credential lookup that never reached the proxy is asked for again", async () => {
  let lookups = 0;
  const output = await runGitHubCredentialHelper(
    "get",
    GET_REPO,
    async () => {
      lookups++;
      if (lookups < 2)
        throw new CliError({
          code: "GITHUB_CREDENTIAL_FAILED",
          message: "agent proxy request failed (network or timeout)",
          retryable: true,
        });
      return CREDENTIAL;
    },
    { sleep: async () => {} },
  );

  expect(output).toBe("username=x-access-token\npassword=short-lived-token\n\n");
  expect(lookups).toBe(2);
});
