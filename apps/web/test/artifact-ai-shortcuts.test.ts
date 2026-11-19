import { expect, test } from "bun:test";
import {
  buildAiPromptUrl,
  formatArtifactForAi,
} from "#src/features/artifacts/artifact-ai-shortcuts";

test("formatArtifactForAi formats title, version, url, and body", () => {
  const output = formatArtifactForAi({
    title: "Q4 Launch Plan",
    version: 3,
    url: "https://coforge.example/w/acme/artifacts/abc",
    body: "# Summary\nShip on Friday.",
  });

  expect(output).toContain("# Q4 Launch Plan (v3)");
  expect(output).toContain("Source: https://coforge.example/w/acme/artifacts/abc");
  expect(output).toContain("# Summary\nShip on Friday.");
});

test("formatArtifactForAi truncates oversized bodies with a clear marker", () => {
  const huge = "x".repeat(130_000);
  const output = formatArtifactForAi({
    title: "Huge Spec",
    body: huge,
  });

  expect(output.length).toBeLessThan(125_000);
  expect(output).toContain("[truncated]");
});

test("buildAiPromptUrl builds ChatGPT and Claude URLs with bounded query length", () => {
  const chatgpt = buildAiPromptUrl("chatgpt", {
    title: "Design Doc",
    url: "https://coforge.example/p/tok",
    body: "Key decision: use SQLite.",
  });
  const claude = buildAiPromptUrl("claude", {
    title: "Design Doc",
    url: "https://coforge.example/p/tok",
    body: "a".repeat(10_000),
  });

  const chatgptParsed = new URL(chatgpt);
  expect(chatgptParsed.origin).toBe("https://chatgpt.com");
  expect(chatgptParsed.pathname).toBe("/");
  expect(chatgptParsed.searchParams.get("q")).toContain("Design Doc");
  expect(chatgptParsed.searchParams.get("q")).toContain("https://coforge.example/p/tok");
  expect(chatgptParsed.searchParams.get("q")).toContain("Key decision: use SQLite.");

  const claudeParsed = new URL(claude);
  expect(claudeParsed.origin).toBe("https://claude.ai");
  expect(claudeParsed.pathname).toBe("/new");
  expect(claude.length).toBeLessThan(8_000);
  expect(claudeParsed.searchParams.get("q")).toContain("[truncated]");
});
