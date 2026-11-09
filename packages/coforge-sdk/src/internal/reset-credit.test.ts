import { expect, test } from "bun:test";
import {
  RESET_CREDIT_MESSAGE_TYPE,
  RESET_CREDIT_OUTCOMES,
  RESET_CREDIT_RESPONSE_MESSAGE_TYPE,
  decodeDaemonRuntimeResetCreditConsumeRequest,
  decodeDaemonRuntimeResetCreditConsumeResponse,
  encodeDaemonRuntimeResetCreditConsumeRequest,
  encodeDaemonRuntimeResetCreditConsumeResponse,
  isResetCreditIdempotencyKey,
  isResetCreditOutcome,
} from "./reset-credit";

const request = {
  protocolMajor: 1,
  requestId: "reset-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  provider: "codex" as const,
  idempotencyKey: "0b8c1f3e-52d7-4a9c-9a4e-6f1d2c3b4a59",
  messageType: RESET_CREDIT_MESSAGE_TYPE,
};

test("reset credit consume request round-trips", () => {
  expect(
    decodeDaemonRuntimeResetCreditConsumeRequest(
      encodeDaemonRuntimeResetCreditConsumeRequest(request),
    ),
  ).toEqual(request);
});

test("reset credit consume response round-trips with and without a snapshot", () => {
  const response = {
    protocolMajor: 1,
    requestId: "reset-1",
    workspaceId: "workspace-1",
    computerId: "computer-1",
    provider: "codex" as const,
    outcome: "reset" as const,
    snapshotJson: new TextEncoder().encode('{"provider":"codex"}'),
    messageType: RESET_CREDIT_RESPONSE_MESSAGE_TYPE,
  };
  expect(
    decodeDaemonRuntimeResetCreditConsumeResponse(
      encodeDaemonRuntimeResetCreditConsumeResponse(response),
    ),
  ).toEqual(response);
  const { snapshotJson: _snapshot, ...bare } = response;
  expect(
    decodeDaemonRuntimeResetCreditConsumeResponse(
      encodeDaemonRuntimeResetCreditConsumeResponse({ ...bare, outcome: "unknown" }),
    ),
  ).toEqual({ ...bare, outcome: "unknown" });
});

test("a message of another type is not a reset credit message", () => {
  expect(() =>
    decodeDaemonRuntimeResetCreditConsumeRequest(
      encodeDaemonRuntimeResetCreditConsumeResponse({
        protocolMajor: 1,
        requestId: "reset-1",
        workspaceId: "workspace-1",
        computerId: "computer-1",
        provider: "codex",
        outcome: "reset",
      }),
    ),
  ).toThrow("invalid daemon runtime message type");
});

test("a missing or unrecognized outcome is refused at the boundary, not read as unknown", () => {
  for (const outcome of ["refunded", ""])
    expect(() =>
      decodeDaemonRuntimeResetCreditConsumeResponse(
        encodeDaemonRuntimeResetCreditConsumeResponse({
          protocolMajor: 1,
          requestId: "reset-1",
          workspaceId: "workspace-1",
          computerId: "computer-1",
          provider: "codex",
          outcome: outcome as never,
        }),
      ),
    ).toThrow("invalid reset credit outcome");
  expect(RESET_CREDIT_OUTCOMES.every(isResetCreditOutcome)).toBe(true);
  expect(isResetCreditOutcome("refunded")).toBe(false);
});

test("the idempotency key is 16 to 128 URL-safe characters", () => {
  expect(isResetCreditIdempotencyKey(crypto.randomUUID())).toBe(true);
  expect(isResetCreditIdempotencyKey("a".repeat(16))).toBe(true);
  expect(isResetCreditIdempotencyKey("a".repeat(128))).toBe(true);
  expect(isResetCreditIdempotencyKey("a".repeat(15))).toBe(false);
  expect(isResetCreditIdempotencyKey("a".repeat(129))).toBe(false);
  expect(isResetCreditIdempotencyKey("abcdefghijklmnop qrst")).toBe(false);
  expect(isResetCreditIdempotencyKey("abcdefghijklmnop\n")).toBe(false);
  expect(isResetCreditIdempotencyKey("abcdefghijklmnop.:")).toBe(false);
  expect(isResetCreditIdempotencyKey(undefined)).toBe(false);
});
