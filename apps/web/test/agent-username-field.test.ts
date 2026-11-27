import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { availableAgentUsername, randomAgentUsername } from "#src/features/agents/agent-username";

const SRC = join(import.meta.dir, "../src");
const ALLOWED = new Set([
  "features/agents/agent-username-field.tsx",
  "features/agents/agent-username.ts",
]);

describe("naming an Agent", () => {
  test("only AgentUsernameField reshapes a typed Agent name", async () => {
    const files = (await readdir(SRC, { recursive: true })).filter((file) =>
      /\.(ts|tsx)$/.test(file),
    );
    const offenders: string[] = [];
    for (const file of files) {
      const path = relative(SRC, join(SRC, file));
      if (ALLOWED.has(path) || path.startsWith("generated/") || path.startsWith("paraglide/"))
        continue;
      if ((await readFile(join(SRC, file), "utf8")).includes("typedAgentUsername"))
        offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  test("a suggestion skips taken names and falls back to -2 when all probes are taken", () => {
    const fixed = () => 0;
    const first = randomAgentUsername(undefined, fixed);
    const second = randomAgentUsername(undefined, fixed, new Set([first]));
    expect(second).not.toBe(first);
    const allTaken = {
      has: (name: string) => name !== "grace-2",
    } as unknown as ReadonlySet<string>;
    const suffixed = availableAgentUsername("grace", allTaken);
    expect(suffixed).toBe("grace-2");
  });

  test("a suggestion the directory turns out to have taken moves to a free one", () => {
    const taken = new Set(["grace"]);
    const moved = availableAgentUsername("grace", taken);
    expect(moved).not.toBe("grace");
    expect(availableAgentUsername("grace", new Set())).toBe("grace");
  });
});
