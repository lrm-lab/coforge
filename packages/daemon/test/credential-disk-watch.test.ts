import { expect, test } from "bun:test";
import type { AgentRuntimeConfig } from "@coforge/agent";
import { CredentialInvalidLedger } from "#src/daemon-runtime/credential-invalid-ledger";
import { CredentialDiskWatch, type CredentialFs } from "#src/daemon-runtime/credential-disk-watch";
import { credentialPartsOf } from "#src/daemon-runtime/provider-credentials";

/** A file system of named files and the time each was last written. */
function memoryFs() {
  const files = new Map<string, { content: string; mtimeMs: number }>();
  let clock = 1;
  const reads: string[] = [];
  const fs: CredentialFs = {
    stat: async (path) => {
      const file = files.get(path);
      if (!file) return undefined;
      return {
        key: `${file.content.length}:${file.mtimeMs}`,
        read: async () => {
          reads.push(path);
          return new TextEncoder().encode(file.content);
        },
      };
    },
  };
  return {
    fs,
    reads,
    write: (path: string, content: string) => void files.set(path, { content, mtimeMs: clock++ }),
    remove: (path: string) => void files.delete(path),
  };
}

const codex: AgentRuntimeConfig = { provider: "codex", model: "gpt", reasoning: "balanced" };
const env = { HOME: "/home/frank" };
const AUTH = "/home/frank/.codex/auth.json";

function subject(
  options: { platform?: string; runSecurity?: (args: readonly string[]) => Promise<never> } = {},
) {
  const disk = memoryFs();
  const ledger = new CredentialInvalidLedger();
  const released: string[] = [];
  const watch = new CredentialDiskWatch({
    ledger,
    release: (key) => void released.push(key),
    baseEnv: () => env,
    homeDir: "/home/frank",
    platform: options.platform ?? "linux",
    fs: disk.fs,
    ...(options.runSecurity ? { runSecurity: options.runSecurity } : {}),
  });
  return { disk, ledger, released, watch };
}

test("each runtime's credentials are found where its login keeps them", () => {
  const home = { env, homeDir: "/home/frank", platform: "linux", cwd: "/" };
  expect(credentialPartsOf("codex", home)).toEqual([{ kind: "file", path: AUTH }]);
  expect(
    credentialPartsOf("codex", { ...home, env: { ...env, CODEX_HOME: "/elsewhere" } }),
  ).toEqual([{ kind: "file", path: "/elsewhere/auth.json" }]);
  // A key in the environment is no login on disk.
  expect(
    credentialPartsOf("codex", { ...home, env: { ...env, OPENAI_API_KEY: "k" } }),
  ).toBeUndefined();
  expect(credentialPartsOf("claude-code", home)).toEqual([
    { kind: "file", path: "/home/frank/.claude/.credentials.json" },
  ]);
  expect(credentialPartsOf("claude-code", { ...home, platform: "darwin" })?.[0]).toMatchObject({
    kind: "keychain",
    service: "Claude Code-credentials",
  });
  expect(credentialPartsOf("pi", home)).toBeUndefined();
});

test("a credential file that changes after the record releases it", async () => {
  const { disk, ledger, released, watch } = subject();
  disk.write(AUTH, "old");
  ledger.record("shared:codex", { reason: "user_reauth", recordedAtMs: 1 }, "a", codex);
  await watch.check();
  expect(released).toEqual([]);
  disk.write(AUTH, "new login");
  await watch.check();
  expect(released).toEqual(["shared:codex"]);
});

test("a file that is signed out, or never changes, releases nothing", async () => {
  const { disk, ledger, released, watch } = subject();
  disk.write(AUTH, "old");
  ledger.record("shared:codex", { reason: "user_reauth", recordedAtMs: 1 }, "a", codex);
  disk.remove(AUTH);
  await watch.check();
  await watch.check();
  expect(released).toEqual([]);
});

test("an Agent's own credentials are watched where its environment puts them", async () => {
  const { disk, ledger, released, watch } = subject();
  const own = { ...codex, envVars: { CODEX_HOME: "/agent/home" } };
  disk.write("/agent/home/auth.json", "old");
  ledger.record("agent:a", { reason: "user_reauth", recordedAtMs: 1 }, "a", own);
  await watch.check();
  disk.write("/agent/home/auth.json", "new");
  await watch.check();
  expect(released).toEqual(["agent:a"]);
});

test("a key stops being watched once its records end", async () => {
  const { disk, ledger, released, watch } = subject();
  disk.write(AUTH, "old");
  ledger.record("shared:codex", { reason: "user_reauth", recordedAtMs: 1 }, "a", codex);
  ledger.release("shared:codex", "explicit_stop");
  disk.write(AUTH, "new");
  await watch.check();
  expect(released).toEqual([]);
  expect(watch.watching).toBe(0);
});

test("a credential whose file did not change is not read again", async () => {
  const { disk, ledger, watch } = subject();
  disk.write(AUTH, "old");
  ledger.record("shared:codex", { reason: "user_reauth", recordedAtMs: 1 }, "a", codex);
  await watch.check();
  await watch.check();
  expect(disk.reads).toEqual([AUTH]);
});

test("a credential two keys share is read once in a round", async () => {
  const { disk, ledger, watch } = subject();
  disk.write(AUTH, "old");
  ledger.record("shared:codex", { reason: "user_reauth", recordedAtMs: 1 }, "a", codex);
  ledger.record("agent:b", { reason: "user_reauth", recordedAtMs: 1 }, "b", codex);
  await watch.check();
  disk.reads.length = 0;
  disk.write(AUTH, "new login");
  await watch.check();
  expect(disk.reads).toEqual([AUTH]);
});

test("an Agent on a provider of its own is not watched", () => {
  const { ledger, watch } = subject();
  const own = { ...codex, providerConfig: { kind: "coforge" } } as unknown as AgentRuntimeConfig;
  ledger.record("agent:a", { reason: "user_reauth", recordedAtMs: 1 }, "a", own);
  expect(watch.watching).toBe(0);
});

test("the Keychain is asked only when its file changed, and never for a secret", async () => {
  const asked: Array<readonly string[]> = [];
  const { disk, ledger, released, watch } = subject({
    platform: "darwin",
    runSecurity: async (args) => {
      asked.push(args);
      return { code: 0, stdout: `"mdat"<timedate>=0x${asked.length}` } as never;
    },
  });
  const KEYCHAIN = "/home/frank/Library/Keychains/login.keychain-db";
  disk.write(KEYCHAIN, "keychain v1");
  const claude: AgentRuntimeConfig = {
    provider: "claude-code",
    model: "opus",
    reasoning: "balanced",
  };
  ledger.record("shared:claude-code", { reason: "user_reauth", recordedAtMs: 1 }, "a", claude);
  await watch.check();
  await watch.check();
  expect(asked).toHaveLength(1);
  expect(asked[0]).toEqual(["find-generic-password", "-s", "Claude Code-credentials"]);
  disk.write(KEYCHAIN, "keychain v2");
  await watch.check();
  expect(asked).toHaveLength(2);
  expect(released).toEqual(["shared:claude-code"]);
});
