import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "bun:test";
import { profileStore, type AgentProfile } from "../src/external/profile-store";

export const SERVER = "https://forge.example";
export const OLD_KEY = `sk_ext_${"o".repeat(43)}`;
export const NEW_KEY = `sk_ext_${"n".repeat(43)}`;
export const DEVICE_CODE = "device-code-must-stay-secret";

export function profile(over: Partial<AgentProfile> = {}): AgentProfile {
  return {
    schemaVersion: 1,
    serverUrl: SERVER,
    workspaceId: "w1",
    workspaceSlug: "acme",
    agentId: "a1",
    agentName: "builder",
    credentialId: "c1",
    apiKey: OLD_KEY,
    createdAt: "2026-11-16T00:00:00.000Z",
    ...over,
  };
}

export type Recorded = { method: string; url: URL; headers: Headers; body: string };
export type Handler = (request: Recorded) => Response | Promise<Response>;

/** A fetch that answers from `handler` and records what it was asked. */
export function fakeFetch(handler: Handler) {
  const requests: Recorded[] = [];
  const fetchFn = async (input: URL | string | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input : input.url,
    );
    const body =
      init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
    const recorded = {
      method: init?.method ?? "GET",
      url,
      headers: new Headers(init?.headers),
      body,
    };
    requests.push(recorded);
    return handler(recorded);
  };
  return { requests, fetch: fetchFn as typeof fetch };
}

export const json = (body: unknown, status = 200) => Response.json(body, { status });

/** A temp COFORGE_AGENT_HOME for the test, removed after it. */
export function useAgentHome() {
  const state = { home: "", env: {} as Record<string, string | undefined> };
  beforeEach(async () => {
    state.home = await mkdtemp(join(tmpdir(), "coforge-agent-"));
    state.env = { COFORGE_AGENT_HOME: state.home };
  });
  afterEach(() => rm(state.home, { recursive: true, force: true }));
  return {
    get home() {
      return state.home;
    },
    get env() {
      return state.env;
    },
    get store() {
      return profileStore(state.env);
    },
  };
}

export function withGlobalFetch(fetchFn: typeof fetch): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = fetchFn;
  return () => {
    globalThis.fetch = original;
  };
}
