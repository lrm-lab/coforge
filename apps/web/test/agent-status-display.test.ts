import { expect, test } from "bun:test";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import { agentDisplay } from "#src/features/agents/agent-status-display";
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

test("a runtime signed out names the reason, the runtime's own words, and what to do", () => {
  for (const stopReason of ["runtime_login_required", "auth_failed"]) {
    const view = agentDisplay(
      display({ activityKind: "offline", stopReason, stopDetail: "Not logged in" }),
    );
    expect(view.label).toBe(m.agent_stop_sign_in());
    expect(view.statusDetail).toBe(m.agent_stop_sign_in_detail());
    expect(view.alert).toBe(true);
    expect(view.alertText).toBe(
      m.agent_stop_reason_with_words({
        label: m.agent_stop_sign_in(),
        words: "Not logged in",
        detail: m.agent_stop_sign_in_detail(),
      }),
    );
  }
  // A launch failure carries no words of its own: the reason and what to do.
  expect(
    agentDisplay(display({ activityKind: "offline", stopReason: "runtime_login_required" }))
      .alertText,
  ).toBe(
    m.agent_stop_reason_sentence({
      label: m.agent_stop_sign_in(),
      detail: m.agent_stop_sign_in_detail(),
    }),
  );
});

test("a reason nobody has to act on leaves the plain offline status", () => {
  for (const stopReason of ["rate_limited", "runtime_start_failed", "toString", null]) {
    const view = agentDisplay(display({ activityKind: "offline", stopReason }));
    expect(view.label).toBe(m.agent_status_offline());
    expect(view.alert).toBeUndefined();
  }
});
