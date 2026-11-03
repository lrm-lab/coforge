import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { availableAgentUsername, randomAgentUsername } from "#src/features/agents/agent-username";

const SRC = join(import.meta.dir, "../src");
/** The field, and the module that defines how a typed name is reshaped. */
const ALLOWED = new Set([
  "features/agents/agent-username-field.tsx",
  "features/agents/agent-username.ts",
]);

/**
 * Every place a person names an Agent uses `AgentUsernameField` (docs/design/component-decisions.md,
 * 「给 Agent 起名」): the same label, suggestion, suggest button, reshaping as it is typed and
 * taken-name hint. A form that reshapes a typed name itself has built a second name field.
 */
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

  test("a suggestion is one nobody has while one is free, then the first free -N", () => {
    const first = () => 0;
    expect(randomAgentUsername(undefined, first, new Set(["ada"]))).toBe("alan");
    expect(randomAgentUsername("alan", first, new Set())).toBe("ada");
    const everyone = new Set(
      Array.from({ length: 40 }, (_, index) => randomAgentUsername(undefined, () => index / 40)),
    );
    expect(randomAgentUsername(undefined, first, everyone)).toBe("ada-2");
  });

  test("a suggestion the directory turns out to have taken moves to the next free one", () => {
    expect(availableAgentUsername("grace", new Set(["grace", "linus"]))).toBe("margaret");
    expect(availableAgentUsername("grace", new Set())).toBe("grace");
  });
});
