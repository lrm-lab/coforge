import { expect, test } from "bun:test";
import { RUNTIME_PROVIDER } from "@lrm/coforge-sdk/internal";
import {
  RUNTIME_PROVIDER_DISPLAY_ORDER,
  runtimeProviderLabel,
  sortedRuntimeProviders,
} from "#src/features/agents/runtime-provider-display";

test("RUNTIME_PROVIDER_DISPLAY_ORDER lists every runtime but CoForge", () => {
  const expected = Object.values(RUNTIME_PROVIDER).filter(
    (provider) => provider !== RUNTIME_PROVIDER.COFORGE,
  );
  expect([...RUNTIME_PROVIDER_DISPLAY_ORDER].sort()).toEqual([...expected].sort());
});

test("RUNTIME_PROVIDER_DISPLAY_ORDER is sorted alphabetically by display label", () => {
  expect(RUNTIME_PROVIDER_DISPLAY_ORDER.map(runtimeProviderLabel)).toEqual([
    "Antigravity CLI",
    "Claude Code",
    "Codex",
    "Command Code",
    "Cursor CLI",
    "DeepSeek Harness",
    "Devin",
    "Droid",
    "Grok Build",
    "Kiro",
    "OpenCode",
    "Pi",
  ]);
});

test("sortedRuntimeProviders sorts all runtimes including CoForge alphabetically and deduplicates", () => {
  const ordered = sortedRuntimeProviders([
    RUNTIME_PROVIDER.PI,
    RUNTIME_PROVIDER.COFORGE,
    RUNTIME_PROVIDER.DROID,
    RUNTIME_PROVIDER.COMMAND_CODE,
    RUNTIME_PROVIDER.DEVIN,
    RUNTIME_PROVIDER.CODEX,
    RUNTIME_PROVIDER.DSH,
    RUNTIME_PROVIDER.CLAUDE_CODE,
    RUNTIME_PROVIDER.COFORGE,
    RUNTIME_PROVIDER.ANTIGRAVITY,
  ]);

  expect(ordered).toEqual([
    RUNTIME_PROVIDER.ANTIGRAVITY,
    RUNTIME_PROVIDER.CLAUDE_CODE,
    RUNTIME_PROVIDER.CODEX,
    RUNTIME_PROVIDER.COFORGE,
    RUNTIME_PROVIDER.COMMAND_CODE,
    RUNTIME_PROVIDER.DSH,
    RUNTIME_PROVIDER.DEVIN,
    RUNTIME_PROVIDER.DROID,
    RUNTIME_PROVIDER.PI,
  ]);
});
