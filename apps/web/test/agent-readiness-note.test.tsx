import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";

import { mockModuleForFile } from "./helpers/file-module-mock";

await mockModuleForFile("@tanstack/react-router", () => ({
  useNavigate: () => () => {},
}));

const { AgentReadinessNote } =
  await import("#src/features/agents/profile-panel/agent-readiness-note");
const { AgentProfileStatus } =
  await import("#src/features/agents/profile-panel/agent-profile-status");
const { runtimeMissingKind } =
  await import("#src/features/agents/profile-panel/agent-readiness-line");

const AGENT = {
  id: "agent-1",
  workspaceId: "ws-1",
  computerId: "pc-1",
  computerVersion: null,
  runtime: "codex",
  model: "gpt-5",
  stopped: false,
  status: "offline",
};

function noteData(overrides: Record<string, unknown> = {}) {
  return {
    readiness: { state: "ready" },
    computer: {
      id: "pc-1",
      label: "Frank's Mac Studio",
      ownerLabel: "Frank",
      ownedByViewer: false,
    },
    canManageAgentRole: false,
    canManageLogin: false,
    canStartAgent: false,
    canManage: false,
    agentOwnerLabel: "Agent Owner",
    runtimeLabel: "Codex",
    workspaceSlug: "dev-user",
    ...overrides,
  } as Parameters<typeof AgentReadinessNote>[0]["data"];
}

const queryClient = new QueryClient();

function renderNote(data: ReturnType<typeof noteData>, extra = {}) {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <AgentReadinessNote data={data} agent={AGENT} {...extra} />
    </QueryClientProvider>,
  );
}

function display(kind: AgentDisplaySnapshot["activityKind"]): AgentDisplaySnapshot {
  return {
    protocolMajor: 1,
    workspaceId: "ws-1",
    computerId: "pc-1",
    agentId: "agent-1",
    revision: 1,
    activityKind: kind,
    detailKind: "",
    detail: kind === "error" ? "provider exploded" : "",
    entries: [],
    expiresAt: null,
  };
}

describe("runtimeMissingKind", () => {
  test("the refusal detail picks the copy; anything else is unknown", () => {
    expect(runtimeMissingKind("runtime_missing")).toBe("install");
    expect(runtimeMissingKind("runtime_unusable")).toBe("unusable");
    expect(runtimeMissingKind("runtime_unconfirmed")).toBe("unconfirmed");
    expect(runtimeMissingKind(null)).toBe("unknown");
    expect(runtimeMissingKind("something_else")).toBe("unknown");
  });
});

describe("AgentReadinessNote runtime_missing copy", () => {
  test("a truly missing runtime still points at installing it", () => {
    const markup = renderNote(
      noteData({ readiness: { state: "runtime_missing", detail: "runtime_missing" } }),
    );
    expect(markup).toContain("No usable Codex on Frank&#x27;s Mac Studio");
    expect(markup).toContain("Frank needs to install it");
  });

  test("an unusable runtime does not tell anyone to install it", () => {
    const markup = renderNote(
      noteData({ readiness: { state: "runtime_missing", detail: "runtime_unusable" } }),
    );
    expect(markup).toContain("installed but can&#x27;t run the Agent");
    expect(markup).toContain("needs to reinstall or update it");
    expect(markup).not.toContain("needs to install it");
  });

  test("an unconfirmed runtime says it has not been reported", () => {
    const markup = renderNote(
      noteData({ readiness: { state: "runtime_missing", detail: "runtime_unconfirmed" } }),
    );
    expect(markup).toContain("hasn&#x27;t reported Codex yet");
    expect(markup).not.toContain("install");
  });

  test("a missing detail falls back to the generic line, not the install one", () => {
    const markup = renderNote(noteData({ readiness: { state: "runtime_missing" } }));
    expect(markup).toContain("can&#x27;t run Codex right now");
    expect(markup).not.toContain("needs to install it");
  });
});

describe("AgentReadinessNote runtime_login_required permission split", () => {
  test("a viewer who may manage the runtime gets the sign-in words, the button and the start hint", () => {
    const markup = renderNote(
      noteData({
        readiness: { state: "runtime_login_required" },
        canManageLogin: true,
        canStartAgent: true,
      }),
    );
    expect(markup).toContain("Sign in to Codex on Frank&#x27;s Mac Studio");
    expect(markup).toContain("Start the Agent after sign-in");
    expect(markup.match(/Sign in/g)?.length).toBeGreaterThanOrEqual(2);
  });

  test("an ordinary member who can start but not sign in gets the ask wording, the start hint and no sign-in button", () => {
    const markup = renderNote(
      noteData({
        readiness: { state: "runtime_login_required" },
        canManageLogin: false,
        canStartAgent: true,
        canManage: false,
      }),
    );
    expect(markup).toContain("Ask the computer owner or an administrator to sign in");
    expect(markup).toContain("Start the Agent after sign-in");
    expect(markup.match(/Sign in/g)).toBeNull();
  });

  test("a viewer who can neither sign in nor start gets only the ask wording", () => {
    const markup = renderNote(
      noteData({
        readiness: { state: "runtime_login_required" },
        canManageLogin: false,
        canStartAgent: false,
      }),
    );
    expect(markup).toContain("Ask the computer owner or an administrator to sign in");
    expect(markup).not.toContain("Start the Agent after sign-in");
    expect(markup.match(/Sign in/g)).toBeNull();
  });
});

describe("AgentReadinessNote launch_failed permission split", () => {
  const retry = { onRetry: () => {}, busy: false, deferred: false };
  const onOpenSettings = () => {};

  test("an ordinary member who can start gets Retry and View logs but no settings entry", () => {
    const markup = renderNote(
      noteData({
        readiness: { state: "launch_failed", detail: "model_not_found" },
        canStartAgent: true,
        canManage: false,
      }),
      { retry, onViewLogs: () => {}, onOpenSettings },
    );
    expect(markup).toContain("can&#x27;t use this model");
    expect(markup).toContain("Retry");
    expect(markup).toContain("View logs");
    expect(markup).not.toContain("Open settings");
    expect(markup).not.toContain("needs to handle this");
  });

  test("a manager gets the settings entry on a settings-fixable failure", () => {
    const markup = renderNote(
      noteData({
        readiness: { state: "launch_failed", detail: "model_not_found" },
        canStartAgent: true,
        canManage: true,
      }),
      { retry, onViewLogs: () => {}, onOpenSettings },
    );
    expect(markup).toContain("Open settings");
  });

  test("a viewer who can neither start nor manage is pointed at the owner", () => {
    const markup = renderNote(
      noteData({
        readiness: { state: "launch_failed", detail: "model_not_found" },
        canStartAgent: false,
        canManage: false,
      }),
      { retry, onViewLogs: () => {}, onOpenSettings },
    );
    expect(markup).not.toContain("Retry");
    expect(markup).not.toContain("Open settings");
    expect(markup).toContain("Agent Owner needs to handle this");
  });
});

describe("AgentReadinessNote computer_offline copy", () => {
  test("an offline Computer the viewer does not own names its owner", () => {
    const markup = renderNote(noteData({ readiness: { state: "computer_offline" } }));
    expect(markup).toContain("Frank&#x27;s Mac Studio is offline. Frank needs to open CoForge");
  });
});

describe("AgentProfileStatus readiness vs Activity error", () => {
  const readiness = noteData({ readiness: { state: "computer_offline" } });

  test("an Activity error keeps its own banner and the readiness row stays out", () => {
    const markup = renderToStaticMarkup(
      <AgentProfileStatus
        agent={AGENT}
        display={display("error")}
        onActivityTab={false}
        readiness={readiness}
      />,
    );
    expect(markup).not.toContain("needs to open CoForge");
    expect(markup).toContain("bg-error-primary");
  });

  test("without an Activity error the readiness row speaks", () => {
    const markup = renderToStaticMarkup(
      <AgentProfileStatus
        agent={AGENT}
        display={display("online")}
        onActivityTab={false}
        readiness={readiness}
      />,
    );
    expect(markup).toContain("Frank&#x27;s Mac Studio is offline. Frank needs to open CoForge");
  });
});
