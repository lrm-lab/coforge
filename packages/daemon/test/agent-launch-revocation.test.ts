import { describe, expect, test } from "bun:test";

import type { AgentProxy } from "#src/daemon-runtime/runtime-launch-types";
import {
  restoreSupersededProxyToken,
  revokeLocalLaunch,
} from "#src/daemon-runtime/agent-launch-revocation";

/**
 * The launch-failure cleanup for an Agent's local binding, driven the way
 * `agent-launch-process.ts` drives it: a process is still running with its own
 * context+token pair while a second launch fails before or after issuing its
 * own. The running process must keep its binding afterward, and a later Stop
 * (the bare revoke) must still reach it.
 */

function fakeProxy() {
  const revoked: string[] = [];
  const revokedAgents: string[] = [];
  const proxy: AgentProxy = {
    issue: () => undefined,
    revoke: (token: string) => void revoked.push(token),
    revokeAgent: (agentId: string) => void revokedAgents.push(agentId),
    request: () => Promise.reject(new Error("unused")),
  } as unknown as AgentProxy;
  return { proxy, revoked, revokedAgents };
}

/** The catch path: put back what this launch displaced, then revoke only its own issue. A token
 * the launch reused is the Agent's and is left alone, as is anything a Stop removed meanwhile. */
function failedLaunchCleanup(
  contexts: Map<string, string>,
  proxyTokens: Map<string, string>,
  proxy: AgentProxy | undefined,
  agentId: string,
  launch: {
    localContext?: string;
    proxyToken?: string;
    priorProxyToken?: string;
    created?: boolean;
  },
) {
  if (launch.created === false) return;
  restoreSupersededProxyToken(proxyTokens, agentId, launch.proxyToken, launch.priorProxyToken);
  if (launch.localContext !== undefined)
    revokeLocalLaunch(
      contexts,
      proxyTokens,
      proxy,
      agentId,
      launch.localContext,
      launch.proxyToken,
    );
}

describe("revokeLocalLaunch", () => {
  test("a bare revoke drops the Agent's current context and token from the tables", () => {
    const contexts = new Map([["agent-a", "context-a"]]);
    const proxyTokens = new Map([["agent-a", "token-a"]]);
    const { proxy, revoked, revokedAgents } = fakeProxy();

    revokeLocalLaunch(contexts, proxyTokens, proxy, "agent-a");

    expect(contexts.has("agent-a")).toBe(false);
    expect(proxyTokens.has("agent-a")).toBe(false);
    expect(revoked).toEqual(["token-a"]);
    // Stop, delete, unbind and logout drop the whole registration, named or not.
    expect(revokedAgents).toEqual(["agent-a"]);
  });

  test("an explicit pair leaves table values the pair does not match", () => {
    const contexts = new Map([["agent-a", "context-old"]]);
    const proxyTokens = new Map([["agent-a", "token-old"]]);
    const { proxy, revoked } = fakeProxy();

    revokeLocalLaunch(contexts, proxyTokens, proxy, "agent-a", "context-new", "token-new");

    expect(contexts.get("agent-a")).toBe("context-old");
    expect(proxyTokens.get("agent-a")).toBe("token-old");
    expect(revoked).toEqual(["token-new"]);
  });

  test("a caller passing only its own context revokes no proxy token", () => {
    // A launch that issued a context but never a token: the running process's token stays.
    const contexts = new Map([["agent-a", "context-new"]]);
    const proxyTokens = new Map([["agent-a", "token-running"]]);
    const { proxy, revoked } = fakeProxy();

    revokeLocalLaunch(contexts, proxyTokens, proxy, "agent-a", "context-new", undefined);

    expect(contexts.has("agent-a")).toBe(false);
    expect(proxyTokens.get("agent-a")).toBe("token-running");
    expect(revoked).toEqual([]);
  });
});

describe("failed launch cleanup beside a running process", () => {
  test("failure after the token issue restores the running process's pair", () => {
    const contexts = new Map([["agent-a", "context-old"]]);
    const proxyTokens = new Map([["agent-a", "token-old"]]);
    const { proxy, revoked } = fakeProxy();
    // The failed launch issued token-new, displacing token-old; with a proxy the token is
    // the local context, so the contexts table still holds the running process's.
    proxyTokens.set("agent-a", "token-new");

    failedLaunchCleanup(contexts, proxyTokens, proxy, "agent-a", {
      localContext: "token-new",
      proxyToken: "token-new",
      priorProxyToken: "token-old",
    });

    expect(contexts.get("agent-a")).toBe("context-old");
    expect(proxyTokens.get("agent-a")).toBe("token-old");
    expect(revoked).toEqual(["token-new"]);
    // A later Stop still finds and revokes the running process's token.
    revokeLocalLaunch(contexts, proxyTokens, proxy, "agent-a");
    expect(revoked).toEqual(["token-new", "token-old"]);
    expect(proxyTokens.has("agent-a")).toBe(false);
  });

  test("failure before the token issue revokes nothing of the running process's", () => {
    const contexts = new Map([["agent-a", "context-old"]]);
    const proxyTokens = new Map([["agent-a", "token-old"]]);
    const { proxy, revoked } = fakeProxy();

    failedLaunchCleanup(contexts, proxyTokens, proxy, "agent-a", {});

    expect(contexts.get("agent-a")).toBe("context-old");
    expect(proxyTokens.get("agent-a")).toBe("token-old");
    expect(revoked).toEqual([]);
    revokeLocalLaunch(contexts, proxyTokens, proxy, "agent-a");
    expect(revoked).toEqual(["token-old"]);
  });

  test("failure after a context-only issue keeps the running process's token", () => {
    // No proxy on this launch: it issued a fresh context, which displaced the running
    // process's context entry but never its token.
    const contexts = new Map([["agent-a", "context-new"]]);
    const proxyTokens = new Map([["agent-a", "token-old"]]);
    const { proxy, revoked } = fakeProxy();

    failedLaunchCleanup(contexts, proxyTokens, proxy, "agent-a", {
      localContext: "context-new",
    });

    expect(contexts.has("agent-a")).toBe(false);
    expect(proxyTokens.get("agent-a")).toBe("token-old");
    expect(revoked).toEqual([]);
  });

  test("a concurrent newer launch's token is never clobbered by the restore", () => {
    const proxyTokens = new Map([["agent-a", "token-old"]]);
    proxyTokens.set("agent-a", "token-new");
    // A third launch already wrote its own token over the failed launch's.
    proxyTokens.set("agent-a", "token-newest");

    restoreSupersededProxyToken(proxyTokens, "agent-a", "token-new", "token-old");

    expect(proxyTokens.get("agent-a")).toBe("token-newest");
  });

  test("a launch that reused the Agent's token revokes nothing when it fails", () => {
    const contexts = new Map([["agent-a", "token-shared"]]);
    const proxyTokens = new Map([["agent-a", "token-shared"]]);
    const { proxy, revoked, revokedAgents } = fakeProxy();

    failedLaunchCleanup(contexts, proxyTokens, proxy, "agent-a", {
      localContext: "token-shared",
      proxyToken: "token-shared",
      priorProxyToken: "token-shared",
      created: false,
    });

    expect(contexts.get("agent-a")).toBe("token-shared");
    expect(proxyTokens.get("agent-a")).toBe("token-shared");
    expect(revoked).toEqual([]);
    expect(revokedAgents).toEqual([]);
  });

  test("a Stop during a launch is not undone when that launch then fails", () => {
    const contexts = new Map<string, string>();
    const proxyTokens = new Map<string, string>();
    const { proxy, revoked, revokedAgents } = fakeProxy();
    contexts.set("agent-a", "token-new");
    proxyTokens.set("agent-a", "token-new");
    revokeLocalLaunch(contexts, proxyTokens, proxy, "agent-a");

    failedLaunchCleanup(contexts, proxyTokens, proxy, "agent-a", {
      localContext: "token-new",
      proxyToken: "token-new",
      priorProxyToken: undefined,
      created: true,
    });

    // Nothing is put back: no context, no token, and the Stop's revoke is the only one that
    // mattered. A later launch issues a fresh token.
    expect(contexts.has("agent-a")).toBe(false);
    expect(proxyTokens.has("agent-a")).toBe(false);
    expect(revokedAgents).toEqual(["agent-a"]);
    expect(revoked).toEqual(["token-new", "token-new"]);
  });
});
