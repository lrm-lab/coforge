import { expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  RuntimeAuthIntentSchema,
  RuntimeAuthLoginReportSchema,
  RuntimeAuthLogoutReportSchema,
} from "#src/internal/gen/coforge/rpc/v1/runtime_auth_pb";
import {
  RUNTIME_AUTH_LOGIN_ID_PATTERN,
  decodeRuntimeAuthIntent,
  decodeRuntimeAuthLoginReport,
  decodeRuntimeAuthLogoutReport,
  encodeRuntimeAuthIntent,
  encodeRuntimeAuthLoginReport,
  encodeRuntimeAuthLogoutReport,
  type RuntimeAuthIntent,
  type RuntimeAuthLoginReport,
  type RuntimeAuthLogoutReport,
} from "./runtime-auth";
import { RUNTIME_PROVIDER } from "./runtime-provider";

const scope = { protocolMajor: 1 as const, workspaceId: "workspace-1", computerId: "computer-1" };
const loginId = "rtl_abcdefghijklmnop";

test("every intent round-trips and keeps its kind", () => {
  const intents: RuntimeAuthIntent[] = [
    { ...scope, kind: "login_start", loginId, provider: RUNTIME_PROVIDER.CLAUDE_CODE },
    { ...scope, kind: "login_code", loginId, code: "abc-123" },
    { ...scope, kind: "login_cancel", loginId },
    { ...scope, kind: "logout", requestId: "request-1", provider: RUNTIME_PROVIDER.CODEX },
  ];
  for (const intent of intents)
    expect(decodeRuntimeAuthIntent(encodeRuntimeAuthIntent(intent))).toEqual(intent);
});

test("intent fields are bounded", () => {
  expect(RUNTIME_AUTH_LOGIN_ID_PATTERN.test(loginId)).toBe(true);
  expect(() =>
    encodeRuntimeAuthIntent({ ...scope, kind: "login_cancel", loginId: "rtl_short" }),
  ).toThrow("login id");
  expect(() =>
    encodeRuntimeAuthIntent({ ...scope, kind: "login_start", loginId, provider: "pi" as "codex" }),
  ).toThrow("provider");
  expect(() =>
    encodeRuntimeAuthIntent({ ...scope, kind: "login_code", loginId, code: "a\u0000b" }),
  ).toThrow("code");
  expect(() =>
    encodeRuntimeAuthIntent({ ...scope, kind: "login_code", loginId, code: "x".repeat(1025) }),
  ).toThrow("code");
  expect(() =>
    encodeRuntimeAuthIntent({
      ...scope,
      kind: "logout",
      requestId: "r".repeat(129),
      provider: RUNTIME_PROVIDER.CODEX,
    }),
  ).toThrow("request id");
});

test("login reports round-trip every event and result", () => {
  const reports: RuntimeAuthLoginReport[] = [
    {
      ...scope,
      loginId,
      sequence: 1,
      event: { kind: "auth_url", url: "https://example.com/a", instructions: "Open it" },
    },
    {
      ...scope,
      loginId,
      sequence: 2,
      event: {
        kind: "device_code",
        userCode: "ABCD-1234",
        verificationUrl: "https://example.com/d",
        expiresInSeconds: 600,
      },
    },
    { ...scope, loginId, sequence: 3, event: { kind: "info", message: "Waiting" } },
    {
      ...scope,
      loginId,
      sequence: 4,
      event: { kind: "code_prompt", message: "Paste the code", retry: true },
    },
    { ...scope, loginId, sequence: 5, event: { kind: "code_prompt" } },
    {
      ...scope,
      loginId,
      sequence: 6,
      result: {
        kind: "logged_in",
        account: { maskedLabel: "a***@example.com", planLabel: "Max", methodLabel: "oauth" },
      },
    },
    { ...scope, loginId, sequence: 7, result: { kind: "logged_in" } },
    {
      ...scope,
      loginId,
      sequence: 8,
      result: { kind: "failed", reason: "rejected", detail: "no" },
    },
    { ...scope, loginId, sequence: 9, result: { kind: "cancelled" } },
    {
      ...scope,
      loginId,
      sequence: 10,
      result: { kind: "unsupported", reason: "version_unsupported" },
    },
    { ...scope, loginId, sequence: 11, result: { kind: "busy" } },
  ];
  for (const report of reports)
    expect(decodeRuntimeAuthLoginReport(encodeRuntimeAuthLoginReport(report))).toEqual(report);
});

test("login reports refuse unsafe links, text and account labels", () => {
  const base = { ...scope, loginId, sequence: 1 };
  const bad: RuntimeAuthLoginReport[] = [
    { ...base, event: { kind: "auth_url", url: "http://example.com" } },
    { ...base, event: { kind: "auth_url", url: "javascript:alert(1)" } },
    { ...base, event: { kind: "info", message: "a\u0007b" } },
    { ...base, event: { kind: "info", message: "x".repeat(501) } },
    {
      ...base,
      event: { kind: "device_code", userCode: "x".repeat(33), verificationUrl: "https://e.com" },
    },
    {
      ...base,
      event: {
        kind: "device_code",
        userCode: "A",
        verificationUrl: "https://e.com",
        expiresInSeconds: 3601,
      },
    },
    { ...base, result: { kind: "failed", reason: "nope" as "rejected" } },
    { ...base, result: { kind: "logged_in", account: { maskedLabel: "plain@example.com" } } },
    { ...base, sequence: -1, result: { kind: "busy" } },
  ];
  for (const report of bad) expect(() => encodeRuntimeAuthLoginReport(report)).toThrow();
});

test("a report must carry exactly one of event and result", () => {
  expect(() =>
    encodeRuntimeAuthLoginReport({ ...scope, loginId, sequence: 1 } as RuntimeAuthLoginReport),
  ).toThrow();
});

test("logout reports round-trip", () => {
  const reports: RuntimeAuthLogoutReport[] = [
    { ...scope, requestId: "request-1", result: { kind: "logged_out" } },
    { ...scope, requestId: "request-1", result: { kind: "failed", reason: "still_logged_in" } },
    {
      ...scope,
      requestId: "request-1",
      result: { kind: "unsupported", reason: "not_installed", detail: "no cli" },
    },
  ];
  for (const report of reports)
    expect(decodeRuntimeAuthLogoutReport(encodeRuntimeAuthLogoutReport(report))).toEqual(report);
});

test("a login failure reason is not valid for a logout and the reverse", () => {
  expect(() =>
    encodeRuntimeAuthLogoutReport({
      ...scope,
      requestId: "request-1",
      result: { kind: "failed", reason: "interaction_failed" as "rejected" },
    }),
  ).toThrow();
});

test("decoding refuses another message type", () => {
  const bytes = encodeRuntimeAuthLoginReport({
    ...scope,
    loginId,
    sequence: 1,
    result: { kind: "busy" },
  });
  expect(() => decodeRuntimeAuthLogoutReport(bytes)).toThrow();
  expect(() => decodeRuntimeAuthIntent(bytes)).toThrow();
});

const wireScope = { protocolMajor: 1, workspaceId: "workspace-1", computerId: "computer-1" };

test("decoding refuses malformed wire messages", () => {
  const intent = (init: object) =>
    toBinary(
      RuntimeAuthIntentSchema,
      create(RuntimeAuthIntentSchema, {
        ...wireScope,
        messageType: "coforge.rpc.v1.RuntimeAuthIntent",
        ...init,
      }),
    );
  expect(() => decodeRuntimeAuthIntent(intent({}))).toThrow();
  expect(() =>
    decodeRuntimeAuthIntent(
      intent({ protocolMajor: 2, kind: { case: "loginCancel", value: { loginId } } }),
    ),
  ).toThrow("scope");
  expect(() =>
    decodeRuntimeAuthIntent(
      intent({ workspaceId: "", kind: { case: "loginCancel", value: { loginId } } }),
    ),
  ).toThrow("scope");
  expect(() =>
    decodeRuntimeAuthIntent(intent({ kind: { case: "loginCancel", value: { loginId: "x" } } })),
  ).toThrow("login id");
  const loginReport = (init: object) =>
    toBinary(
      RuntimeAuthLoginReportSchema,
      create(RuntimeAuthLoginReportSchema, {
        ...wireScope,
        loginId,
        sequence: 1,
        messageType: "coforge.rpc.v1.RuntimeAuthLoginReport",
        ...init,
      }),
    );
  expect(() => decodeRuntimeAuthLoginReport(loginReport({}))).toThrow();
  expect(() =>
    decodeRuntimeAuthLoginReport(
      loginReport({
        sequence: 0,
        report: { case: "result", value: { kind: { case: "busy", value: {} } } },
      }),
    ),
  ).toThrow("sequence");
  expect(() =>
    decodeRuntimeAuthLoginReport(
      loginReport({
        report: {
          case: "event",
          value: { kind: { case: "authUrl", value: { url: "http://e.com" } } },
        },
      }),
    ),
  ).toThrow("https");
  expect(() =>
    decodeRuntimeAuthLoginReport(
      loginReport({
        report: {
          case: "event",
          value: {
            kind: {
              case: "deviceCode",
              value: { userCode: "A", verificationUrl: "https://e.com", expiresInSeconds: 0 },
            },
          },
        },
      }),
    ),
  ).toThrow("lifetime");
  expect(() =>
    decodeRuntimeAuthLoginReport(
      loginReport({
        report: { case: "result", value: { kind: { case: "failed", value: { reason: "nope" } } } },
      }),
    ),
  ).toThrow("failure reason");
  const logoutReport = (init: object) =>
    toBinary(
      RuntimeAuthLogoutReportSchema,
      create(RuntimeAuthLogoutReportSchema, {
        ...wireScope,
        requestId: "request-1",
        messageType: "coforge.rpc.v1.RuntimeAuthLogoutReport",
        ...init,
      }),
    );
  expect(() => decodeRuntimeAuthLogoutReport(logoutReport({}))).toThrow();
  expect(() => decodeRuntimeAuthLogoutReport(logoutReport({ result: {} }))).toThrow();
});

test("text is trimmed and refuses control, format and separator characters", () => {
  const info = (message: string): RuntimeAuthLoginReport => ({
    ...scope,
    loginId,
    sequence: 1,
    event: { kind: "info", message },
  });
  const roundTrip = (message: string) =>
    decodeRuntimeAuthLoginReport(encodeRuntimeAuthLoginReport(info(message)));
  expect(roundTrip("  hello  ")).toEqual(info("hello"));
  expect(roundTrip("a\tb\nc")).toEqual(info("a\tb\nc"));
  for (const bad of ["a\u0085b", "a\u202eb", "a\u200bb", "a\u2028b", "a\u0007b", "   "])
    expect(() => encodeRuntimeAuthLoginReport(info(bad))).toThrow();
});

test("links must be plain https and relayed exactly", () => {
  const link = (url: string): RuntimeAuthLoginReport => ({
    ...scope,
    loginId,
    sequence: 1,
    event: { kind: "auth_url", url },
  });
  expect(() => encodeRuntimeAuthLoginReport(link(" https://e.com/a"))).toThrow("https");
  expect(() => encodeRuntimeAuthLoginReport(link("https://e.com/a\nb"))).toThrow("https");
  expect(() => encodeRuntimeAuthLoginReport(link("https://user:pw@e.com/"))).toThrow("https");
  expect(() => encodeRuntimeAuthLoginReport(link(`https://e.com/${"a".repeat(4096)}`))).toThrow(
    "https",
  );
});

test("sequence starts at 1, a zero retry survives, and an empty account is refused", () => {
  expect(() =>
    encodeRuntimeAuthLoginReport({ ...scope, loginId, sequence: 0, result: { kind: "busy" } }),
  ).toThrow("sequence");
  const prompt: RuntimeAuthLoginReport = {
    ...scope,
    loginId,
    sequence: 1,
    event: { kind: "code_prompt", retry: false },
  };
  expect(decodeRuntimeAuthLoginReport(encodeRuntimeAuthLoginReport(prompt))).toEqual(prompt);
  expect(() =>
    encodeRuntimeAuthLoginReport({
      ...scope,
      loginId,
      sequence: 1,
      result: { kind: "logged_in", account: {} },
    }),
  ).toThrow("empty");
});

test("the login code is not rewritten: whitespace is refused", () => {
  for (const bad of ["  abc ", "abc\n", "ab cd"])
    expect(() =>
      encodeRuntimeAuthIntent({ ...scope, kind: "login_code", loginId, code: bad }),
    ).toThrow("code");
});

test("a login report refuses an event together with a result", () => {
  expect(() =>
    encodeRuntimeAuthLoginReport({
      ...scope,
      loginId,
      sequence: 1,
      event: { kind: "info", message: "x" },
      result: { kind: "busy" },
    } as unknown as RuntimeAuthLoginReport),
  ).toThrow("exactly one");
});
