import { expect, test } from "bun:test";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import { STOP_REASON_RECOVERY, stopNeedsPerson } from "@lrm/coforge-sdk/internal";
import { agentDisplay } from "#src/features/agents/agent-status-display";
import { STOP_REASON_COPY_KEYS } from "#src/features/agents/agent-stop-reason";
import { m } from "#src/paraglide/messages";

function display(overrides: Partial<AgentDisplaySnapshot> = {}): AgentDisplaySnapshot {
  return {
    protocolMajor: 1,
    workspaceId: "workspace-1",
    computerId: "computer-1",
    agentId: "agent-1",
    revision: 7,
    activityKind: "working",
    detailKind: "model_request_started",
    detail: "Reviewing the release plan",
    entries: [],
    expiresAt: 99_000,
    ...overrides,
  };
}

test("formats only the cloud display decision even when its raw detail kind conflicts", () => {
  expect(
    agentDisplay(
      display({
        activityKind: "online",
        detailKind: "model_request_started",
        detail: "Raw model request",
      }),
    ),
  ).toEqual({
    kind: "online",
    label: "Online",
    isOnline: true,
    tone: "idle",
    pulse: false,
  });
  expect(
    agentDisplay(
      display({
        activityKind: "working",
        detailKind: "future_backend_kind",
        detail: "Backend customized work",
      }),
    ),
  ).toMatchObject({
    kind: "working",
    label: "Backend customized work",
    isOnline: true,
    pulse: true,
  });
  expect(
    agentDisplay(
      display({
        activityKind: "error",
        detailKind: "runtime_error",
        detail: "Provider rejected request",
      }),
    ),
  ).toMatchObject({
    kind: "error",
    label: "Error: Provider rejected request",
    isOnline: true,
    pulse: false,
  });
  expect(
    agentDisplay(
      display({
        activityKind: "offline",
        detailKind: "model_response_started",
        detail: "stale work",
      }),
    ),
  ).toMatchObject({
    kind: "offline",
    label: "Offline",
    isOnline: false,
    pulse: false,
  });
  expect(agentDisplay()).toEqual({
    kind: "unknown",
    label: m.agent_status_unknown(),
    isOnline: undefined,
    tone: "unknown",
    pulse: false,
  });
});

test("a stopped Agent keeps its real display kind and label, adding only a status caption", () => {
  const offline = display({ activityKind: "offline", detailKind: "model_response_started" });
  expect(agentDisplay(offline, { stopped: true })).toMatchObject({
    kind: "offline",
    label: "Offline",
    isOnline: false,
    statusDetail: "Stopped — won't receive messages until restarted",
  });
  // Not stopped: no caption at all.
  expect(agentDisplay(offline, { stopped: false }).statusDetail).toBeUndefined();
  expect(agentDisplay(offline).statusDetail).toBeUndefined();
  // Stopped but the display is not (yet) offline: the real kind and label are not overridden.
  const working = display({ activityKind: "working", detailKind: "model_request_started" });
  const view = agentDisplay(working, { stopped: true });
  expect(view.kind).toBe("working");
  expect(view.isOnline).toBe(true);
  expect(view.statusDetail).toBeUndefined();
});

test("a stopped Agent reads in the provider's words, and ours where none were kept", () => {
  const stopped = { activityKind: "offline", stopReason: "billing_exhausted" } as const;
  const said = "Your credit balance is too low.";
  expect(agentDisplay(display({ ...stopped, stopDetail: said })).label).toBe(said);
  for (const stopDetail of [null, undefined]) {
    expect(agentDisplay(display({ ...stopped, stopDetail })).label).toBe(
      m.agent_status_quota_exhausted(),
    );
  }
});

test("a stop with the Daemon's sentence reads as that sentence everywhere, nothing of ours", () => {
  const sentence =
    "Pi's model provider rejected the API key, or no key is set for it on this machine. Check the API key for this Agent's provider, then retry starting this Agent.";
  const view = agentDisplay(
    display({
      activityKind: "offline",
      stopReason: "auth_failed",
      stopDetail: '401 "invalid api key"',
      stopMessage: sentence,
    }),
  );
  expect(view.alert).toBe(true);
  expect(view.label).toBe(sentence);
  expect(view.alertText).toBe(sentence);
  // An older server sends no sentence: only the short word, no sentence of ours.
  const older = agentDisplay(display({ activityKind: "offline", stopReason: "auth_failed" }));
  expect(older.label).toBe(m.agent_stop_sign_in());
  expect(older.alertText).toBe(m.agent_stop_sign_in());
});

test("a runtime signed out with no sentence of its own shows the short word, never the raw error", () => {
  for (const stopReason of ["runtime_login_required", "auth_failed"]) {
    const view = agentDisplay(
      display({ activityKind: "offline", stopReason, stopDetail: '401 "invalid api key"' }),
    );
    expect(view.label).toBe(m.agent_stop_sign_in());
    expect(view.statusDetail).toBe(m.agent_stop_sign_in_detail());
    expect(view.alert).toBe(true);
    // The raw error stays in the logs (Frank, 11-09); no sentence of ours stands in for the Daemon's.
    expect(view.alertText).toBe(m.agent_stop_sign_in());
  }
});

test("a reason nobody has to act on leaves the plain offline status", () => {
  for (const stopReason of ["rate_limited", "quota_exhausted", "toString", null]) {
    const view = agentDisplay(display({ activityKind: "offline", stopReason }));
    expect(view.label).toBe(m.agent_status_offline());
    expect(view.alert).toBeUndefined();
  }
});

test("every stop a person has to clear gets the banner and its way back, in the Daemon's words", () => {
  const sentence = "The runtime could not start this Agent.";
  for (const [stopReason, recovery] of Object.entries(STOP_REASON_RECOVERY)) {
    const view = agentDisplay(
      display({ activityKind: "offline", stopReason, stopMessage: sentence }),
    );
    if (recovery === "automatic") {
      expect(view.alert).toBeUndefined();
      continue;
    }
    expect(view.alert).toBe(true);
    expect(view.recovery).toBe(recovery);
    expect(view.alertText).toBe(sentence);
  }
  // Too long to send: a fresh session, not another Start.
  expect(
    agentDisplay(display({ activityKind: "offline", stopReason: "input_too_large" })).recovery,
  ).toBe("reset_session");
  // A reason we have no words for, and no sentence came: the plain status word, nothing invented.
  const bare = agentDisplay(
    display({ activityKind: "offline", stopReason: "runtime_spawn_failed" }),
  );
  expect(bare.alertText).toBe(m.agent_status_offline());
  expect(bare.statusDetail).toBeUndefined();
});

test("our words exist only for stops a person has to clear", () => {
  for (const reason of STOP_REASON_COPY_KEYS) expect(stopNeedsPerson(reason)).toBe(true);
});

test("a live Agent held on its credential reads as the stop, still online, with Retry", () => {
  const view = agentDisplay(
    display({
      activityKind: "error",
      detailKind: "runtime_error",
      detail: "Runtime not signed in",
      stopReason: "auth_failed",
      stopMessage: "Runtime not signed in",
    }),
  );
  expect(view.isOnline).toBe(true);
  expect(view.alert).toBe(true);
  expect(view.label).toBe("Runtime not signed in");
  expect(view.recovery).toBe("retry");
});

/** The three runtime refusals the daemon tells apart (task #418; `launch-failure.test.ts` pins the
 * sentences): a refused Agent's Computer is still online, so the display is the `error` activity
 * carrying that sentence, and the profile's banner reads it as `Error: <sentence>`. */
test("each runtime refusal reaches the error banner as its own sentence", () => {
  const sentences = [
    "The configured runtime is marked private on this Computer, and is not shared with this Agent's owner.",
    "Kiro is not installed on this Computer. Install Kiro, then start the Agent again.",
    "Kiro is not usable on this Computer. Check its status in Computer settings, then start the Agent again.",
  ];
  for (const detail of sentences) {
    const view = agentDisplay(
      display({ activityKind: "error", detailKind: "runtime_error", detail, stopReason: null }),
    );
    expect(view.label).toBe(`Error: ${detail}`);
    expect(view.alert).toBeUndefined();
  }
});

test("an external Agent out of its window reads as external since its last activity", () => {
  const external = display({
    computerId: "",
    activityKind: "offline",
    detailKind: "",
    detail: "",
    expiresAt: null,
    lastSeenAtMs: 1_700_000_000_000,
  });
  expect(agentDisplay(external)).toMatchObject({
    kind: "offline",
    label: m.agent_status_offline(),
    isOnline: false,
    tone: "external",
    lastActiveAt: 1_700_000_000_000,
  });
  const neverSeen = agentDisplay({ ...external, lastSeenAtMs: null });
  expect(neverSeen.tone).toBe("external");
  expect(neverSeen.lastActiveAt).toBeUndefined();
  const stopped = agentDisplay(external, { stopped: true });
  expect(stopped.tone).toBe("external");
  expect(stopped.lastActiveAt).toBe(1_700_000_000_000);
  expect(stopped.statusDetail).toBeDefined();
});

test("an external Agent inside its window reads like any online Agent", () => {
  const online = agentDisplay(
    display({
      computerId: "",
      activityKind: "online",
      detailKind: "",
      detail: "",
      lastSeenAtMs: 1_700_000_000_000,
    }),
  );
  expect(online).toMatchObject({ kind: "online", tone: "idle", isOnline: true });
  expect(online.lastActiveAt).toBeUndefined();
});

test("a managed Agent offline keeps the plain offline dot", () => {
  const view = agentDisplay(display({ activityKind: "offline", expiresAt: null }));
  expect(view.tone).toBe("offline");
  expect(view.lastActiveAt).toBeUndefined();
});
