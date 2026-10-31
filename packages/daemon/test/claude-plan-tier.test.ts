import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudePlanTier } from "#src/code-agent/claude-code/plan-tier";

async function configHome(content: string | undefined) {
  const home = await mkdtemp(join(tmpdir(), "coforge-claude-plan-tier-"));
  if (content !== undefined) await Bun.write(join(home, ".claude.json"), content);
  return home;
}

test("the $200 Max tier reads from the account's user tier", async () => {
  const home = await configHome(
    JSON.stringify({ oauthAccount: { userRateLimitTier: "default_claude_max_20x" } }),
  );
  try {
    expect(await readClaudePlanTier({ HOME: home })).toBe("default_claude_max_20x");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the organization tier answers when the user has none", async () => {
  const home = await configHome(
    JSON.stringify({
      oauthAccount: {
        userRateLimitTier: null,
        organizationRateLimitTier: "default_claude_max_20x",
      },
    }),
  );
  try {
    expect(await readClaudePlanTier({ HOME: home })).toBe("default_claude_max_20x");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("CLAUDE_CONFIG_DIR moves the file", async () => {
  const home = await configHome(undefined);
  const moved = join(home, "moved");
  await Bun.write(
    join(moved, ".claude.json"),
    JSON.stringify({ oauthAccount: { userRateLimitTier: "default_claude_max_5x" } }),
  );
  try {
    expect(await readClaudePlanTier({ HOME: home, CLAUDE_CONFIG_DIR: moved })).toBe(
      "default_claude_max_5x",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a missing file, a missing field or broken JSON is simply no tier", async () => {
  const empty = await configHome(undefined);
  const noAccount = await configHome(JSON.stringify({ projects: {} }));
  const broken = await configHome("{ not json");
  try {
    expect(await readClaudePlanTier({ HOME: empty })).toBeUndefined();
    expect(await readClaudePlanTier({ HOME: noAccount })).toBeUndefined();
    expect(await readClaudePlanTier({ HOME: broken })).toBeUndefined();
    expect(await readClaudePlanTier({})).toBeUndefined();
  } finally {
    for (const home of [empty, noAccount, broken]) await rm(home, { recursive: true, force: true });
  }
});
