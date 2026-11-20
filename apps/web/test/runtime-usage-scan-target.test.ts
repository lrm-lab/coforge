import { expect, test } from "bun:test";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { RUNTIME_PROVIDER, type RuntimeProvider } from "@lrm/coforge-sdk/internal";

import {
  runtimeUsageQueryKey,
  runtimeUsageScanOptions,
} from "#src/features/computers/use-runtime-usage";

type Read = Parameters<ReturnType<typeof runtimeUsageScanOptions>["onSuccess"]>[0];

// A scan that returns when told to, so one can finish after the popup has moved on.
function deferredScans() {
  const pending = new Map<RuntimeProvider, (read: Read) => void>();
  const scan = (_computerId: string, provider: RuntimeProvider) =>
    new Promise<Read>((resolve) => pending.set(provider, resolve));
  return {
    scan,
    finish: async (provider: RuntimeProvider, read: Read) => {
      // The mutation starts its scan a few ticks after `mutate`.
      for (let tick = 0; !pending.has(provider) && tick < 100; tick += 1)
        await new Promise((resolve) => setTimeout(resolve, 0));
      pending.get(provider)!(read);
    },
  };
}

test("a scan that returns after the popup moved to another runtime fills its own runtime (task #513)", async () => {
  const queryClient = new QueryClient();
  const { scan, finish } = deferredScans();
  const observer = new MutationObserver(
    queryClient,
    runtimeUsageScanOptions(queryClient, scan, async () => {}),
  );
  // The popup shows a Kiro Agent and scans Kiro.
  const kiroScan = observer.mutate({ computerId: "computer", provider: "kiro" });
  // It moves to a Claude Code Agent before that returns: the hook's options are the new render's.
  observer.setOptions(runtimeUsageScanOptions(queryClient, scan, async () => {}));
  const kiro = { state: "fresh", provider: "kiro" } as unknown as Read;
  await finish("kiro", kiro);
  await kiroScan;

  expect(queryClient.getQueryData(runtimeUsageQueryKey("computer", "kiro"))).toBe(kiro);
  expect(queryClient.getQueryData(runtimeUsageQueryKey("computer", "claude-code"))).toBeUndefined();
});

test("two Codex Agents and a new configuration do not share the Computer usage query", async () => {
  const queryClient = new QueryClient();
  const options = runtimeUsageScanOptions(
    queryClient,
    async () => {
      throw new Error("Agent usage must never scan the Computer");
    },
    async () => {},
    async () => ({ state: "missing" }),
  );
  const base = { computerId: "computer", provider: RUNTIME_PROVIDER.CODEX };
  const alpha = { ...base, agent: { agentId: "a", runtimeConfigRevision: 1 } };
  const beta = { ...base, agent: { agentId: "b", runtimeConfigRevision: 1 } };
  const revised = { ...alpha, agent: { ...alpha.agent, runtimeConfigRevision: 2 } };
  const mark = (pendingScanId: string, runtimeConfigRevision = 1): Read => ({
    state: "missing",
    pendingScanId,
    target: { computerId: "computer", runtimeConfigRevision },
  });

  await options.onSuccess(mark("beta"), beta);
  await options.onSuccess(mark("new alpha", 2), revised);
  await options.onSuccess(mark("old alpha"), alpha);
  expect(queryClient.getQueryData(["agent-runtime-usage", "computer", "a", 1])).toEqual(
    mark("old alpha"),
  );
  expect(queryClient.getQueryData(["agent-runtime-usage", "computer", "a", 2])).toEqual(
    mark("new alpha", 2),
  );
  expect(queryClient.getQueryData(["agent-runtime-usage", "computer", "b", 1])).toEqual(
    mark("beta"),
  );
  expect(
    queryClient.getQueryData(runtimeUsageQueryKey("computer", RUNTIME_PROVIDER.CODEX)),
  ).toBeUndefined();
  expect(await options.mutationFn(alpha)).toEqual({ state: "missing" });
  await options.onSuccess(mark("unexpected revision", 2), alpha);
  expect(queryClient.getQueryData(["agent-runtime-usage", "computer", "a", 1])).toEqual({
    state: "fresh",
    unavailable: true,
  });
  expect(queryClient.getQueryData(["agent-runtime-usage", "computer", "a", 2])).toEqual(
    mark("new alpha", 2),
  );
});
