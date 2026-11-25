import { describe, expect, test } from "bun:test";
import { decide } from "./pre-bash";

describe("pre-bash hook", () => {
  test("denies a typed formatter call in every launch form", () => {
    for (const command of [
      "oxfmt .",
      "bunx oxfmt --write apps/web",
      "bunx --bun oxfmt --check apps/web",
      "bun x oxfmt .",
      "bun --bun x oxfmt .",
      "bun run oxfmt .",
      "bun --bun run oxfmt .",
      "bun oxfmt .",
      "bun --bun oxfmt .",
      "bun --bun ./node_modules/.bin/oxfmt src",
      "bun --cwd apps/web --bun oxfmt .",
      "npx oxfmt .",
      "mise exec -- oxfmt .",
      "FOO=1 oxfmt .",
      "./node_modules/.bin/oxfmt src",
      "cd apps/web && bunx oxfmt --check src",
      "git status; oxfmt .",
      "cat a.ts | oxfmt --stdin-filepath a.ts",
      'bash -c "bunx oxfmt ."',
      'bash -c "bun --bun oxfmt ."',
    ])
      expect({ command, kind: decide(command).kind }).toEqual({ command, kind: "deny" });
  });
  test("points the agent to mise run check", () => {
    expect(decide("bunx oxfmt .")).toMatchObject({ reason: expect.stringContaining("mise run check") });
  });
  test("allows package scripts, mentions and other tools", () => {
    for (const command of [
      "mise run check",
      "bun run check:ci",
      "bun --bun run check:ci",
      "bun run format",
      "bun --bun vite build",
      "bunx oxlint src",
      "bunx --bun oxlint src",
      "rg oxfmt scripts",
      'git commit -m "chore: run oxfmt; then push" -m "Revert-effect: none"',
      "echo oxfmt && ls",
      "cat .oxfmtrc.json",
      "bun test scripts/ci",
      "bash script.sh",
      "zsh",
      "git status && sh",
    ])
      expect({ command, kind: decide(command).kind }).toEqual({ command, kind: "allow" });
  });
});
