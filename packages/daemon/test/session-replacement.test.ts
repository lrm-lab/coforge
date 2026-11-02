import { expect, test } from "bun:test";
import {
  inferredReplacedSession,
  replacedSessionFor,
} from "#src/daemon-runtime/session-replacement";

test("a driver-reported replacement wins over every other source", () => {
  expect(
    replacedSessionFor({
      driverReplacedSessionId: "driver-old",
      recycledSessionId: "recycled-old",
      requestedReplacedSessionId: "control-old",
      requestedSessionId: "requested-old",
      requestedSessionMode: "resume",
      reportedSessionId: "new",
    }),
  ).toBe("driver-old");
});

test("a wake recycle or a control recovery names the replaced session when the driver does not", () => {
  const base = {
    requestedSessionId: "requested-old",
    requestedSessionMode: "resume" as const,
    reportedSessionId: "new",
  };
  expect(replacedSessionFor({ ...base, recycledSessionId: "recycled-old" })).toBe("recycled-old");
  expect(replacedSessionFor({ ...base, requestedReplacedSessionId: "control-old" })).toBe(
    "control-old",
  );
});

test("a fresh session after a lost resume names the session this launch tried to continue", () => {
  // The production case: the server knew `sess_ae105fff…`, the driver reported a new session for
  // the resume it could not complete, and nothing else named the replacement.
  expect(
    replacedSessionFor({
      requestedSessionId: "sess_ae105fff-da4b-4010-886f-a11c1530ccf4",
      requestedSessionMode: "resume",
      reportedSessionId: "sess_new",
    }),
  ).toBe("sess_ae105fff-da4b-4010-886f-a11c1530ccf4");
  expect(
    inferredReplacedSession({
      requestedSessionId: "sess_ae105fff-da4b-4010-886f-a11c1530ccf4",
      requestedSessionMode: "resume",
      reportedSessionId: "sess_new",
    }),
  ).toBe("sess_ae105fff-da4b-4010-886f-a11c1530ccf4");
});

test("a create launch, or a driver that kept the requested session, replaces nothing", () => {
  expect(
    inferredReplacedSession({
      requestedSessionId: "sess-old",
      requestedSessionMode: "create",
      reportedSessionId: "sess-new",
    }),
  ).toBeUndefined();
  expect(
    inferredReplacedSession({
      requestedSessionId: "sess-same",
      requestedSessionMode: "resume",
      reportedSessionId: "sess-same",
    }),
  ).toBeUndefined();
  expect(
    replacedSessionFor({
      requestedSessionMode: "create",
      reportedSessionId: "sess-new",
    }),
  ).toBeUndefined();
});

test("every provider's report runs the same derivation, so a lost session is always named", () => {
  // The fix lives in the daemon's shared report path, never in an adapter; this documents that
  // every runtime depends on it.
  for (const provider of [
    "kiro",
    "codex",
    "claude-code",
    "pi",
    "cursor",
    "grok",
    "command-code",
    "dsh",
    "antigravity",
    "devin",
  ] as const)
    expect(
      replacedSessionFor({
        requestedSessionId: `${provider}-old`,
        requestedSessionMode: "resume",
        reportedSessionId: `${provider}-new`,
      }),
      provider,
    ).toBe(`${provider}-old`);
});
