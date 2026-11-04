import { expect, test } from "bun:test";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import type { RuntimeProvider } from "@lrm/coforge-sdk/internal";

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
