import { expect, test } from "bun:test";
import {
  RUNTIME_AUTH_CODE_MAX_LENGTH,
  RUNTIME_AUTH_PROVIDERS,
  type RuntimeAuthAdapter,
  type RuntimeAuthLoginEvent,
  isRuntimeAuthProvider,
  normalizeRuntimeAuthCode,
} from "#src/contract";

test("runtime auth is limited to the providers with a supported login flow", () => {
  expect(RUNTIME_AUTH_PROVIDERS).toEqual(["claude-code", "codex"]);
  expect(isRuntimeAuthProvider("claude-code")).toBe(true);
  expect(isRuntimeAuthProvider("codex")).toBe(true);
  expect(isRuntimeAuthProvider("pi")).toBe(false);
  expect(isRuntimeAuthProvider("unknown")).toBe(false);
});

test("runtime auth codes discard pasted whitespace and keep the bounded value", () => {
  expect(normalizeRuntimeAuthCode("  ABC\n 123 ")).toBe("ABC123");
  expect(normalizeRuntimeAuthCode("a".repeat(RUNTIME_AUTH_CODE_MAX_LENGTH))).toHaveLength(
    RUNTIME_AUTH_CODE_MAX_LENGTH,
  );
});

test("runtime auth codes reject empty, oversized, and non-whitespace control input", () => {
  expect(() => normalizeRuntimeAuthCode(" \n\t")).toThrow("empty");
  expect(() => normalizeRuntimeAuthCode("a".repeat(RUNTIME_AUTH_CODE_MAX_LENGTH + 1))).toThrow(
    "too long",
  );
  expect(() => normalizeRuntimeAuthCode("abc\u0000def")).toThrow("control");
});

test("runtime auth login is an event stream with a final result", async () => {
  const events: RuntimeAuthLoginEvent[] = [];
  const adapter: RuntimeAuthAdapter = {
    provider: "codex",
    async readStatus() {
      return { provider: "codex", state: "logged_out" };
    },
    async startLogin(_options, interaction) {
      interaction.onEvent({ kind: "device_code", userCode: "ABCD", expiresAtMs: 123 });
      interaction.onEvent({ kind: "info", message: "Enable device login in ChatGPT settings." });
      return { status: "logged_in", authStatus: { provider: "codex", state: "logged_in" } };
    },
    async submitCode() {},
    async cancel() {},
    async logout() {
      return { status: "logged_out", authStatus: { provider: "codex", state: "logged_out" } };
    },
  };

  const result = await adapter.startLogin(
    { workingDirectory: "/tmp" },
    {
      onEvent: (event) => events.push(event),
      prompt: async () => "ABCD",
    },
  );

  expect(events).toEqual([
    { kind: "device_code", userCode: "ABCD", expiresAtMs: 123 },
    { kind: "info", message: "Enable device login in ChatGPT settings." },
  ]);
  expect(result.status).toBe("logged_in");
});
