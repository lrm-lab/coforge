import { expect, spyOn, test } from "bun:test";
import {
  readCommitCoAuthor,
  readGitHubConfig,
} from "#src/server/integrations/github-config.server";

test("GitHub stays unconfigured without secrets and rejects non-HTTPS or mismatched callback paths", async () => {
  expect(await readGitHubConfig({})).toBeNull();
  const env = {
    COFORGE_GITHUB_APP_ID: "4937758",
    COFORGE_GITHUB_CLIENT_ID: "client",
    COFORGE_GITHUB_APP_SLUG: "coforge-staging",
    COFORGE_GITHUB_CALLBACK_URL: "https://staging.coforge.cn/api/integrations/github/callback",
    COFORGE_GITHUB_CLIENT_SECRET: "secret",
    COFORGE_GITHUB_CREDENTIAL_ENCRYPTION_KEY: "ab".repeat(32),
  };
  expect((await readGitHubConfig(env))?.encryptionKey).toEqual(new Uint8Array(32).fill(171));
  expect((await readGitHubConfig(env))?.webhookSecret).toBeNull();
  expect(
    (await readGitHubConfig({ ...env, COFORGE_GITHUB_WEBHOOK_SECRET: "whsec-value" }))
      ?.webhookSecret,
  ).toBe("whsec-value");
  await expect(
    readGitHubConfig({
      ...env,
      COFORGE_GITHUB_CALLBACK_URL: "http://staging.coforge.cn/api/integrations/github/callback",
    }),
  ).rejects.toThrow();
  await expect(
    readGitHubConfig({ ...env, COFORGE_GITHUB_CALLBACK_URL: "https://staging.coforge.cn/other" }),
  ).rejects.toThrow();
  await expect(
    readGitHubConfig({ ...env, COFORGE_GITHUB_CLIENT_SECRET_FILE: "/tmp/secret" }),
  ).rejects.toThrow();
});

test("the commit co-author is one `Name <email>` value; anything else is unset", () => {
  expect(readCommitCoAuthor({})).toBeNull();
  expect(readCommitCoAuthor({ COFORGE_COMMIT_COAUTHOR: "CoForge <coforge@example.com>" })).toBe(
    "CoForge <coforge@example.com>",
  );
  expect(readCommitCoAuthor({ COFORGE_COMMIT_COAUTHOR: "  Amp <amp@ampcode.com>\n" })).toBe(
    "Amp <amp@ampcode.com>",
  );
  expect(
    readCommitCoAuthor({
      COFORGE_COMMIT_COAUTHOR: "Co Forge <123+coforge@users.noreply.github.com>",
    }),
  ).toBe("Co Forge <123+coforge@users.noreply.github.com>");
  // The GitHub App's bot identity is not a co-author source any more.
  expect(
    readCommitCoAuthor({
      COFORGE_GITHUB_APP_SLUG: "coforge-staging",
      COFORGE_GITHUB_APP_BOT_USER_ID: "328977087",
    }),
  ).toBeNull();
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (const value of [
      "",
      "   ",
      "CoForge",
      "<coforge@example.com>",
      "CoForge <>",
      "CoForge <not-an-email>",
      "CoForge <coforge@localhost>",
      "CoForge coforge@example.com",
      "CoForge  <coforge@example.com>",
      "CoForge <coforge@example.com> extra",
      "Co<Forge <coforge@example.com>",
      "CoForge <co forge@example.com>",
      "CoForge\n<coforge@example.com>",
      "CoForge <coforge@example.com>\nSigned-off-by: x <x@example.com>",
      "Co\tForge <coforge@example.com>",
      "Co-authored-by: CoForge <coforge@example.com>",
    ])
      expect(readCommitCoAuthor({ COFORGE_COMMIT_COAUTHOR: value })).toBeNull();
    // An empty (or blank) value is simply unset, not logged. Any other rejected value is logged
    // once per value; the log state is per process, so this uses a value no other test reads.
    const before = warn.mock.calls.length;
    expect(readCommitCoAuthor({ COFORGE_COMMIT_COAUTHOR: "" })).toBeNull();
    expect(readCommitCoAuthor({ COFORGE_COMMIT_COAUTHOR: "   " })).toBeNull();
    expect(warn.mock.calls.length).toBe(before);
    const unique = `CoForge ${crypto.randomUUID()}`;
    expect(readCommitCoAuthor({ COFORGE_COMMIT_COAUTHOR: unique })).toBeNull();
    expect(readCommitCoAuthor({ COFORGE_COMMIT_COAUTHOR: unique })).toBeNull();
    expect(warn.mock.calls.length).toBe(before + 1);
    // The log names the variable, never its value.
    expect(JSON.parse(String(warn.mock.calls.at(-1)?.[0]))).toEqual({
      event: "github.commit_coauthor_invalid",
      variable: "COFORGE_COMMIT_COAUTHOR",
    });
  } finally {
    warn.mockRestore();
  }
});
